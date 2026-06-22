use std::{
    collections::{HashMap, VecDeque},
    hash::Hash,
    sync::{Arc, Condvar, Mutex, OnceLock},
};

use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    ChaCha20Poly1305, Key, Nonce,
};
use keyring_core::Entry as KeyringEntry;
use zeroize::{Zeroize, Zeroizing};

use tauri::{AppHandle, Emitter};

use crate::{
    error::{terminal_error, Result},
    types::{
        SshAuthTarget, SshAuthTargetKind, SshCredentialInput, SshCredentialKind,
        SshHostScopedChallenge, SshWorkspaceChallenge, WorkspaceSshVerificationRequiredEvent,
        WorkspaceSshVerificationResponse,
    },
};

pub(crate) const WORKSPACE_SSH_VERIFICATION_REQUIRED_EVENT: &str =
    "workspace://ssh-verification-required";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct WorkspaceCredentialKey {
    pub(crate) workspace_id: String,
    pub(crate) auth_target_id: String,
    pub(crate) username: String,
    pub(crate) kind: SshCredentialKind,
    pub(crate) identity_file: Option<String>,
}

impl WorkspaceCredentialKey {
    pub(crate) fn new(
        workspace_id: &str,
        auth_target: &SshAuthTarget,
        kind: SshCredentialKind,
        identity_file: Option<&str>,
    ) -> Self {
        Self {
            workspace_id: workspace_id.to_string(),
            auth_target_id: auth_target.id.clone(),
            username: auth_target.username.clone(),
            kind,
            identity_file: identity_file.map(ToOwned::to_owned),
        }
    }
}

struct EncryptedTemporaryCredential {
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
}

struct EncryptedSecretScope<K> {
    key: Zeroizing<[u8; 32]>,
    credentials: HashMap<K, EncryptedTemporaryCredential>,
}

pub(crate) struct ScopedEncryptedCredentialStore<K> {
    scopes: HashMap<String, EncryptedSecretScope<K>>,
}

impl<K> Default for ScopedEncryptedCredentialStore<K> {
    fn default() -> Self {
        Self {
            scopes: HashMap::new(),
        }
    }
}

#[derive(Default)]
pub(crate) struct WorkspaceEncryptedCredentialStore {
    inner: ScopedEncryptedCredentialStore<WorkspaceCredentialKey>,
}

impl<K> ScopedEncryptedCredentialStore<K>
where
    K: Eq + Hash,
{
    pub(crate) fn put(&mut self, scope_id: &str, key: K, value: Zeroizing<String>) -> Result<()> {
        let scope = self
            .scopes
            .entry(scope_id.to_string())
            .or_insert_with(EncryptedSecretScope::new);
        let cipher = scope.cipher();
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&nonce, value.as_bytes())
            .map_err(|_| terminal_error("failed to encrypt temporary SSH credential"))?;
        scope.credentials.insert(
            key,
            EncryptedTemporaryCredential {
                nonce: nonce.into(),
                ciphertext,
            },
        );
        Ok(())
    }

    pub(crate) fn get(&self, scope_id: &str, key: &K) -> Result<Option<Zeroizing<String>>> {
        let Some(scope) = self.scopes.get(scope_id) else {
            return Ok(None);
        };
        let Some(entry) = scope.credentials.get(key) else {
            return Ok(None);
        };
        let cipher = scope.cipher();
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&entry.nonce), entry.ciphertext.as_ref())
            .map_err(|_| terminal_error("failed to decrypt temporary SSH credential"))?;
        String::from_utf8(plaintext)
            .map(Zeroizing::new)
            .map(Some)
            .map_err(|_| terminal_error("temporary SSH credential is not valid UTF-8"))
    }

    pub(crate) fn remove(&mut self, scope_id: &str, key: &K) {
        if let Some(scope) = self.scopes.get_mut(scope_id) {
            if let Some(mut entry) = scope.credentials.remove(key) {
                entry.ciphertext.zeroize();
                entry.nonce.zeroize();
            }
        }
    }

    pub(crate) fn remove_scope(&mut self, scope_id: &str) {
        if let Some(mut scope) = self.scopes.remove(scope_id) {
            scope.key.zeroize();
            for (_, mut entry) in scope.credentials.drain() {
                entry.ciphertext.zeroize();
                entry.nonce.zeroize();
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn raw_ciphertext_for_test(&self, scope_id: &str, key: &K) -> Option<&[u8]> {
        self.scopes
            .get(scope_id)?
            .credentials
            .get(key)
            .map(|entry| entry.ciphertext.as_slice())
    }
}

impl WorkspaceEncryptedCredentialStore {
    pub(crate) fn put(
        &mut self,
        key: WorkspaceCredentialKey,
        value: Zeroizing<String>,
    ) -> Result<()> {
        let scope_id = key.workspace_id.clone();
        self.inner.put(&scope_id, key, value)
    }

    pub(crate) fn get(&self, key: &WorkspaceCredentialKey) -> Result<Option<Zeroizing<String>>> {
        self.inner.get(&key.workspace_id, key)
    }

    pub(crate) fn remove(&mut self, key: &WorkspaceCredentialKey) {
        self.inner.remove(&key.workspace_id, key);
    }

    pub(crate) fn remove_workspace(&mut self, workspace_id: &str) {
        self.inner.remove_scope(workspace_id);
    }

    #[cfg(test)]
    fn raw_ciphertext_for_test(&self, key: &WorkspaceCredentialKey) -> Option<&[u8]> {
        self.inner.raw_ciphertext_for_test(&key.workspace_id, key)
    }
}

impl<K> EncryptedSecretScope<K> {
    fn new() -> Self {
        let mut key = [0u8; 32];
        let generated = ChaCha20Poly1305::generate_key(&mut OsRng);
        key.copy_from_slice(generated.as_slice());
        Self {
            key: Zeroizing::new(key),
            credentials: HashMap::new(),
        }
    }

    fn cipher(&self) -> ChaCha20Poly1305 {
        ChaCha20Poly1305::new(Key::from_slice(self.key.as_ref()))
    }
}

#[derive(Default)]
pub(crate) struct WorkspaceSshCoordinator {
    credentials: Mutex<WorkspaceEncryptedCredentialStore>,
    verifications: Mutex<WorkspaceVerificationStore>,
}

#[derive(Default)]
pub(crate) struct HostScopedSshCoordinator {
    verifications: Mutex<HostVerificationStore>,
}

#[derive(Default)]
struct WorkspaceVerificationStore {
    next_id: u64,
    by_workspace: HashMap<String, WorkspaceVerificationQueue>,
}

#[derive(Default)]
struct WorkspaceVerificationQueue {
    active: Option<Arc<WorkspaceVerificationRequest>>,
    queued: VecDeque<Arc<WorkspaceVerificationRequest>>,
}

struct WorkspaceVerificationRequest {
    id: String,
    workspace_id: String,
    challenge: SshWorkspaceChallenge,
    state: Mutex<WorkspaceVerificationState>,
    cv: Condvar,
}

#[derive(Default)]
struct HostVerificationStore {
    next_id: u64,
    by_host: HashMap<String, HostVerificationQueue>,
}

#[derive(Default)]
struct HostVerificationQueue {
    active: Option<Arc<HostVerificationRequest>>,
    queued: VecDeque<Arc<HostVerificationRequest>>,
}

struct HostVerificationRequest {
    id: String,
    host_id: String,
    challenge: SshHostScopedChallenge,
    state: Mutex<WorkspaceVerificationState>,
    cv: Condvar,
}

struct WorkspaceVerificationState {
    emitted: bool,
    response: Option<WorkspaceSshVerificationResponse>,
}

impl WorkspaceVerificationStore {
    fn next_verification_id(&mut self) -> Option<String> {
        self.next_id = self.next_id.checked_add(1)?;
        Some(format!("ssh-verify-{}", self.next_id))
    }
}

static WORKSPACE_SSH_COORDINATOR: OnceLock<Arc<WorkspaceSshCoordinator>> = OnceLock::new();
static HOST_SCOPED_SSH_COORDINATOR: OnceLock<Arc<HostScopedSshCoordinator>> = OnceLock::new();

pub(crate) fn workspace_ssh_coordinator() -> Arc<WorkspaceSshCoordinator> {
    WORKSPACE_SSH_COORDINATOR
        .get_or_init(|| Arc::new(WorkspaceSshCoordinator::default()))
        .clone()
}

pub(crate) fn host_scoped_ssh_coordinator() -> Arc<HostScopedSshCoordinator> {
    HOST_SCOPED_SSH_COORDINATOR
        .get_or_init(|| Arc::new(HostScopedSshCoordinator::default()))
        .clone()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn submit_workspace_ssh_verification(
    input: crate::types::WorkspaceSshVerificationSubmitInput,
) -> Result<()> {
    workspace_ssh_coordinator().submit_verification(
        &input.workspace_id,
        &input.verification_id,
        input.response,
    )
}

impl WorkspaceSshCoordinator {
    pub(crate) fn store_prompt_credential_after_success(
        &self,
        key: WorkspaceCredentialKey,
        credential: &SshCredentialInput,
    ) -> Result<()> {
        if credential.kind != key.kind {
            return Err(terminal_error(
                "SSH credential kind does not match auth target challenge",
            ));
        }
        self.credentials
            .lock()
            .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?
            .put(key, Zeroizing::new(credential.value.clone()))
    }

    pub(crate) fn read_workspace_encrypted_temporary_credential(
        &self,
        key: &WorkspaceCredentialKey,
    ) -> Result<Option<Zeroizing<String>>> {
        self.credentials
            .lock()
            .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?
            .get(key)
    }

    pub(crate) fn remove_workspace_encrypted_temporary_credential(
        &self,
        key: &WorkspaceCredentialKey,
    ) -> Result<()> {
        self.credentials
            .lock()
            .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?
            .remove(key);
        Ok(())
    }

    pub(crate) fn remove_workspace(&self, workspace_id: &str) -> Result<()> {
        self.credentials
            .lock()
            .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?
            .remove_workspace(workspace_id);
        let mut store = self
            .verifications
            .lock()
            .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?;
        if let Some(queue) = store.by_workspace.remove(workspace_id) {
            if let Some(active) = queue.active {
                active.cancel();
            }
            for request in queue.queued {
                request.cancel();
            }
        }
        Ok(())
    }

    pub(crate) fn request_verification(
        &self,
        app: Option<&AppHandle>,
        challenge: SshWorkspaceChallenge,
    ) -> Result<WorkspaceSshVerificationResponse> {
        let workspace_id = challenge.workspace_id().to_string();
        let request = {
            let mut store = self
                .verifications
                .lock()
                .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?;
            if let Some(existing) = store
                .by_workspace
                .get(&workspace_id)
                .and_then(|queue| queue.find_identical(&challenge))
            {
                existing
            } else {
                let next_id = store
                    .next_verification_id()
                    .ok_or_else(|| terminal_error("Workspace SSH verification id overflow"))?;
                let queue = store.by_workspace.entry(workspace_id.clone()).or_default();
                let request = Arc::new(WorkspaceVerificationRequest::new(
                    next_id,
                    workspace_id.clone(),
                    challenge,
                ));
                if queue.active.is_none() {
                    queue.active = Some(request.clone());
                } else {
                    queue.queued.push_back(request.clone());
                }
                request
            }
        };

        self.emit_verification_if_active(app, &workspace_id, &request)?;
        let response = request.wait()?;
        self.finish_verification(app, &workspace_id, &request)?;
        Ok(response)
    }

    pub(crate) fn submit_verification(
        &self,
        workspace_id: &str,
        verification_id: &str,
        response: WorkspaceSshVerificationResponse,
    ) -> Result<()> {
        let request = {
            let store = self
                .verifications
                .lock()
                .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?;
            let Some(queue) = store.by_workspace.get(workspace_id) else {
                return Err(terminal_error(format!(
                    "Workspace SSH verification {verification_id} not found"
                )));
            };
            let Some(active) = queue.active.as_ref() else {
                return Err(terminal_error(format!(
                    "Workspace SSH verification {verification_id} is not active"
                )));
            };
            if active.id != verification_id {
                return Err(terminal_error(format!(
                    "Workspace SSH verification {verification_id} is not the active verification"
                )));
            }
            active.clone()
        };
        request.complete(response)
    }

    #[cfg(test)]
    fn start_verification_for_test(
        &self,
        challenge: SshWorkspaceChallenge,
    ) -> Result<Arc<WorkspaceVerificationRequest>> {
        let workspace_id = challenge.workspace_id().to_string();
        let mut store = self
            .verifications
            .lock()
            .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?;
        if let Some(existing) = store
            .by_workspace
            .get(&workspace_id)
            .and_then(|queue| queue.find_identical(&challenge))
        {
            return Ok(existing);
        }
        let next_id = store
            .next_verification_id()
            .ok_or_else(|| terminal_error("Workspace SSH verification id overflow"))?;
        let queue = store.by_workspace.entry(workspace_id.clone()).or_default();
        let request = Arc::new(WorkspaceVerificationRequest::new(
            next_id,
            workspace_id,
            challenge,
        ));
        if queue.active.is_none() {
            queue.active = Some(request.clone());
        } else {
            queue.queued.push_back(request.clone());
        }
        Ok(request)
    }

    fn emit_verification_if_active(
        &self,
        app: Option<&AppHandle>,
        workspace_id: &str,
        request: &Arc<WorkspaceVerificationRequest>,
    ) -> Result<()> {
        let should_emit = {
            let store = self
                .verifications
                .lock()
                .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?;
            store
                .by_workspace
                .get(workspace_id)
                .and_then(|queue| queue.active.as_ref())
                .is_some_and(|active| Arc::ptr_eq(active, request))
        };
        if !should_emit {
            return Ok(());
        }
        if !request.mark_emitted()? {
            return Ok(());
        }
        if let Some(app) = app {
            app.emit(
                WORKSPACE_SSH_VERIFICATION_REQUIRED_EVENT,
                WorkspaceSshVerificationRequiredEvent {
                    workspace_id: request.workspace_id.clone(),
                    verification_id: request.id.clone(),
                    challenge: request.challenge.clone(),
                },
            )
            .map_err(terminal_error)?;
        }
        Ok(())
    }

    fn finish_verification(
        &self,
        app: Option<&AppHandle>,
        workspace_id: &str,
        request: &Arc<WorkspaceVerificationRequest>,
    ) -> Result<()> {
        let next = {
            let mut store = self
                .verifications
                .lock()
                .map_err(|_| terminal_error("Workspace SSH coordinator lock poisoned"))?;
            let Some(queue) = store.by_workspace.get_mut(workspace_id) else {
                return Ok(());
            };
            if queue
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, request))
            {
                queue.active = queue.queued.pop_front();
            }
            let next = queue.active.clone();
            if queue.active.is_none() && queue.queued.is_empty() {
                store.by_workspace.remove(workspace_id);
            }
            next
        };
        if let Some(next) = next {
            self.emit_verification_if_active(app, workspace_id, &next)?;
        }
        Ok(())
    }
}

impl HostScopedSshCoordinator {
    pub(crate) fn request_verification(
        &self,
        app: Option<&AppHandle>,
        host_id: &str,
        challenge: SshHostScopedChallenge,
        emit: fn(&AppHandle, String, String, SshHostScopedChallenge) -> Result<()>,
    ) -> Result<WorkspaceSshVerificationResponse> {
        let request = {
            let mut store = self
                .verifications
                .lock()
                .map_err(|_| terminal_error("Host SSH verification lock poisoned"))?;
            if let Some(existing) = store
                .by_host
                .get(host_id)
                .and_then(|queue| queue.find_identical(&challenge))
            {
                existing
            } else {
                let next_id = store
                    .next_verification_id()
                    .ok_or_else(|| terminal_error("Host SSH verification id overflow"))?;
                let queue = store.by_host.entry(host_id.to_string()).or_default();
                let request = Arc::new(HostVerificationRequest::new(
                    next_id,
                    host_id.to_string(),
                    challenge,
                ));
                if queue.active.is_none() {
                    queue.active = Some(request.clone());
                } else {
                    queue.queued.push_back(request.clone());
                }
                request
            }
        };

        self.emit_verification_if_active(app, host_id, &request, emit)?;
        let response = request.wait()?;
        self.finish_verification(app, host_id, &request, emit)?;
        Ok(response)
    }

    pub(crate) fn submit_verification(
        &self,
        host_id: &str,
        verification_id: &str,
        response: WorkspaceSshVerificationResponse,
    ) -> Result<()> {
        let request = {
            let store = self
                .verifications
                .lock()
                .map_err(|_| terminal_error("Host SSH verification lock poisoned"))?;
            let Some(queue) = store.by_host.get(host_id) else {
                return Err(terminal_error(format!(
                    "Host SSH verification {verification_id} not found"
                )));
            };
            let Some(active) = queue.active.as_ref() else {
                return Err(terminal_error(format!(
                    "Host SSH verification {verification_id} is not active"
                )));
            };
            if active.id != verification_id {
                return Err(terminal_error(format!(
                    "Host SSH verification {verification_id} is not the active verification"
                )));
            }
            active.clone()
        };
        request.complete(response)
    }

    pub(crate) fn cancel_host(&self, host_id: &str) -> Result<()> {
        let mut store = self
            .verifications
            .lock()
            .map_err(|_| terminal_error("Host SSH verification lock poisoned"))?;
        if let Some(queue) = store.by_host.remove(host_id) {
            if let Some(active) = queue.active {
                active.cancel();
            }
            for request in queue.queued {
                request.cancel();
            }
        }
        Ok(())
    }

    fn emit_verification_if_active(
        &self,
        app: Option<&AppHandle>,
        host_id: &str,
        request: &Arc<HostVerificationRequest>,
        emit: fn(&AppHandle, String, String, SshHostScopedChallenge) -> Result<()>,
    ) -> Result<()> {
        let should_emit = {
            let store = self
                .verifications
                .lock()
                .map_err(|_| terminal_error("Host SSH verification lock poisoned"))?;
            store
                .by_host
                .get(host_id)
                .and_then(|queue| queue.active.as_ref())
                .is_some_and(|active| Arc::ptr_eq(active, request))
        };
        if !should_emit || !request.mark_emitted()? {
            return Ok(());
        }
        if let Some(app) = app {
            emit(
                app,
                request.host_id.clone(),
                request.id.clone(),
                request.challenge.clone(),
            )?;
        }
        Ok(())
    }

    fn finish_verification(
        &self,
        app: Option<&AppHandle>,
        host_id: &str,
        request: &Arc<HostVerificationRequest>,
        emit: fn(&AppHandle, String, String, SshHostScopedChallenge) -> Result<()>,
    ) -> Result<()> {
        let next = {
            let mut store = self
                .verifications
                .lock()
                .map_err(|_| terminal_error("Host SSH verification lock poisoned"))?;
            let Some(queue) = store.by_host.get_mut(host_id) else {
                return Ok(());
            };
            if queue
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, request))
            {
                queue.active = queue.queued.pop_front();
            }
            let next = queue.active.clone();
            if queue.active.is_none() && queue.queued.is_empty() {
                store.by_host.remove(host_id);
            }
            next
        };
        if let Some(next) = next {
            self.emit_verification_if_active(app, host_id, &next, emit)?;
        }
        Ok(())
    }
}

impl WorkspaceVerificationQueue {
    fn find_identical(
        &self,
        challenge: &SshWorkspaceChallenge,
    ) -> Option<Arc<WorkspaceVerificationRequest>> {
        self.active
            .iter()
            .chain(self.queued.iter())
            .find(|request| request.challenge.same_verification(challenge))
            .cloned()
    }
}

impl HostVerificationStore {
    fn next_verification_id(&mut self) -> Option<String> {
        self.next_id = self.next_id.checked_add(1)?;
        Some(format!("host-ssh-verify-{}", self.next_id))
    }
}

impl HostVerificationQueue {
    fn find_identical(
        &self,
        challenge: &SshHostScopedChallenge,
    ) -> Option<Arc<HostVerificationRequest>> {
        self.active
            .iter()
            .chain(self.queued.iter())
            .find(|request| request.challenge.same_verification(challenge))
            .cloned()
    }
}

impl WorkspaceVerificationRequest {
    fn new(id: String, workspace_id: String, challenge: SshWorkspaceChallenge) -> Self {
        Self {
            id,
            workspace_id,
            challenge,
            state: Mutex::new(WorkspaceVerificationState {
                emitted: false,
                response: None,
            }),
            cv: Condvar::new(),
        }
    }

    fn mark_emitted(&self) -> Result<bool> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| terminal_error("Workspace SSH verification lock poisoned"))?;
        if state.emitted {
            return Ok(false);
        }
        state.emitted = true;
        Ok(true)
    }

    fn complete(&self, response: WorkspaceSshVerificationResponse) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| terminal_error("Workspace SSH verification lock poisoned"))?;
        if state.response.is_some() {
            return Err(terminal_error(
                "Workspace SSH verification already completed",
            ));
        }
        state.response = Some(response);
        self.cv.notify_all();
        Ok(())
    }

    fn cancel(&self) {
        if let Ok(mut state) = self.state.lock() {
            if state.response.is_none() {
                state.response = Some(WorkspaceSshVerificationResponse::Cancel);
            }
            self.cv.notify_all();
        }
    }

    fn wait(&self) -> Result<WorkspaceSshVerificationResponse> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| terminal_error("Workspace SSH verification lock poisoned"))?;
        while state.response.is_none() {
            state = self
                .cv
                .wait(state)
                .map_err(|_| terminal_error("Workspace SSH verification lock poisoned"))?;
        }
        Ok(state
            .response
            .clone()
            .ok_or_else(|| terminal_error("Workspace SSH verification response missing"))?)
    }
}

impl HostVerificationRequest {
    fn new(id: String, host_id: String, challenge: SshHostScopedChallenge) -> Self {
        Self {
            id,
            host_id,
            challenge,
            state: Mutex::new(WorkspaceVerificationState {
                emitted: false,
                response: None,
            }),
            cv: Condvar::new(),
        }
    }

    fn mark_emitted(&self) -> Result<bool> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| terminal_error("Host SSH verification lock poisoned"))?;
        if state.emitted {
            return Ok(false);
        }
        state.emitted = true;
        Ok(true)
    }

    fn complete(&self, response: WorkspaceSshVerificationResponse) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| terminal_error("Host SSH verification lock poisoned"))?;
        if state.response.is_some() {
            return Err(terminal_error("Host SSH verification already completed"));
        }
        state.response = Some(response);
        self.cv.notify_all();
        Ok(())
    }

    fn cancel(&self) {
        if let Ok(mut state) = self.state.lock() {
            if state.response.is_none() {
                state.response = Some(WorkspaceSshVerificationResponse::Cancel);
            }
            self.cv.notify_all();
        }
    }

    fn wait(&self) -> Result<WorkspaceSshVerificationResponse> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| terminal_error("Host SSH verification lock poisoned"))?;
        while state.response.is_none() {
            state = self
                .cv
                .wait(state)
                .map_err(|_| terminal_error("Host SSH verification lock poisoned"))?;
        }
        Ok(state
            .response
            .clone()
            .ok_or_else(|| terminal_error("Host SSH verification response missing"))?)
    }
}

impl SshWorkspaceChallenge {
    pub(crate) fn workspace_id(&self) -> &str {
        match self {
            SshWorkspaceChallenge::Credential { challenge } => &challenge.workspace_id,
            SshWorkspaceChallenge::HostKey { challenge } => &challenge.workspace_id,
        }
    }

    fn same_verification(&self, other: &Self) -> bool {
        match (self, other) {
            (
                SshWorkspaceChallenge::Credential { challenge: left },
                SshWorkspaceChallenge::Credential { challenge: right },
            ) => {
                left.workspace_id == right.workspace_id
                    && left.auth_target == right.auth_target
                    && left.credential_kind == right.credential_kind
                    && left.identity_file == right.identity_file
            }
            (
                SshWorkspaceChallenge::HostKey { challenge: left },
                SshWorkspaceChallenge::HostKey { challenge: right },
            ) => {
                left.workspace_id == right.workspace_id
                    && left.auth_target == right.auth_target
                    && left.challenge_kind == right.challenge_kind
                    && left.target == right.target
                    && left.algorithm == right.algorithm
                    && left.fingerprint == right.fingerprint
            }
            _ => false,
        }
    }
}

impl SshHostScopedChallenge {
    fn same_verification(&self, other: &Self) -> bool {
        match (self, other) {
            (
                SshHostScopedChallenge::Credential { challenge: left },
                SshHostScopedChallenge::Credential { challenge: right },
            ) => {
                left.auth_target == right.auth_target
                    && left.credential_kind == right.credential_kind
                    && left.identity_file == right.identity_file
            }
            (
                SshHostScopedChallenge::HostKey { challenge: left },
                SshHostScopedChallenge::HostKey { challenge: right },
            ) => {
                left.auth_target == right.auth_target
                    && left.challenge_kind == right.challenge_kind
                    && left.target == right.target
                    && left.algorithm == right.algorithm
                    && left.fingerprint == right.fingerprint
            }
            _ => false,
        }
    }
}

pub(crate) fn connection_host_auth_target(
    host_id: &str,
    display_name: &str,
    username: &str,
    hostname: &str,
    port: u16,
) -> SshAuthTarget {
    SshAuthTarget {
        id: format!("connection-host:{host_id}"),
        kind: SshAuthTargetKind::ConnectionHost,
        label: display_name.to_string(),
        username: username.to_string(),
        hostname: hostname.to_string(),
        port,
    }
}

pub(crate) fn proxy_jump_auth_target(username: &str, hostname: &str, port: u16) -> SshAuthTarget {
    SshAuthTarget {
        id: format!("proxy-jump:{}@{}:{}", username, hostname, port),
        kind: SshAuthTargetKind::ProxyJump,
        label: format!("{username}@{hostname}:{port}"),
        username: username.to_string(),
        hostname: hostname.to_string(),
        port,
    }
}

pub(crate) fn ssh_keyring_account(
    auth_target: &SshAuthTarget,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
) -> String {
    match kind {
        SshCredentialKind::Password => format!("ssh-auth-target:{}:password", auth_target.id),
        SshCredentialKind::KeyPassphrase => format!(
            "ssh-auth-target:{}:key_passphrase:{}",
            auth_target.id,
            identity_file.unwrap_or("")
        ),
    }
}

pub(crate) fn read_ssh_secret_from_keyring(
    auth_target: &SshAuthTarget,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
) -> Option<String> {
    let _ = keyring::use_native_store(true);
    let account = ssh_keyring_account(auth_target, kind, identity_file);
    KeyringEntry::new("nocturne", &account)
        .and_then(|entry| entry.get_password())
        .ok()
}

pub(crate) fn write_ssh_secret_to_keyring(
    auth_target: &SshAuthTarget,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
    value: &str,
) -> Result<()> {
    keyring::use_native_store(true).map_err(terminal_error)?;
    let account = ssh_keyring_account(auth_target, kind, identity_file);
    let entry = KeyringEntry::new("nocturne", &account).map_err(terminal_error)?;
    entry.set_password(value).map_err(terminal_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SshCredentialChallenge;
    use std::time::{Duration, Instant};

    fn target(id: &str) -> SshAuthTarget {
        SshAuthTarget {
            id: id.to_string(),
            kind: SshAuthTargetKind::ConnectionHost,
            label: "Prod".to_string(),
            username: "deploy".to_string(),
            hostname: "prod.example.com".to_string(),
            port: 22,
        }
    }

    #[test]
    fn workspace_encrypted_temporary_credentials_are_scoped_and_encrypted() {
        let auth_target = target("connection-host:host-a");
        let key_a = WorkspaceCredentialKey::new(
            "workspace-a",
            &auth_target,
            SshCredentialKind::Password,
            None,
        );
        let key_b = WorkspaceCredentialKey::new(
            "workspace-b",
            &auth_target,
            SshCredentialKind::Password,
            None,
        );
        let mut store = WorkspaceEncryptedCredentialStore::default();

        store
            .put(key_a.clone(), Zeroizing::new("secret-password".to_string()))
            .unwrap();

        assert_eq!(
            store.get(&key_a).unwrap().as_deref().map(String::as_str),
            Some("secret-password")
        );
        assert_eq!(
            store.get(&key_b).unwrap().as_deref().map(String::as_str),
            None
        );
        assert_ne!(
            store.raw_ciphertext_for_test(&key_a).unwrap(),
            b"secret-password"
        );
    }

    #[test]
    fn closing_workspace_removes_encrypted_credentials_and_scope_key() {
        let auth_target = target("connection-host:host-a");
        let key = WorkspaceCredentialKey::new(
            "workspace-a",
            &auth_target,
            SshCredentialKind::Password,
            None,
        );
        let mut store = WorkspaceEncryptedCredentialStore::default();
        store
            .put(key.clone(), Zeroizing::new("secret-password".to_string()))
            .unwrap();

        store.remove_workspace("workspace-a");

        assert_eq!(
            store.get(&key).unwrap().as_deref().map(String::as_str),
            None
        );
    }

    #[test]
    fn proxy_jump_and_connection_host_use_distinct_auth_target_keys() {
        let host_target =
            connection_host_auth_target("host-a", "Prod", "deploy", "prod.example.com", 22);
        let jump_target = proxy_jump_auth_target("deploy", "jump.example.com", 2222);

        assert_ne!(host_target.id, jump_target.id);
        assert_ne!(
            ssh_keyring_account(&host_target, SshCredentialKind::Password, None),
            ssh_keyring_account(&jump_target, SshCredentialKind::Password, None)
        );
    }

    fn credential_challenge(workspace_id: &str, target_id: &str) -> SshWorkspaceChallenge {
        let auth_target = target(target_id);
        SshWorkspaceChallenge::Credential {
            challenge: SshCredentialChallenge {
                workspace_id: workspace_id.to_string(),
                source_tool_tab_id: Some("tool-terminal-a".to_string()),
                auth_target,
                credential_kind: SshCredentialKind::Password,
                identity_file: None,
            },
        }
    }

    fn host_credential_challenge(host_id: &str) -> SshHostScopedChallenge {
        SshHostScopedChallenge::Credential {
            challenge: SshCredentialChallenge {
                workspace_id: format!("host-port-forward:{host_id}"),
                source_tool_tab_id: None,
                auth_target: target(&format!("connection-host:{host_id}")),
                credential_kind: SshCredentialKind::Password,
                identity_file: None,
            },
        }
    }

    #[test]
    fn coordinator_deduplicates_identical_workspace_challenges() {
        let coordinator = WorkspaceSshCoordinator::default();
        let first = coordinator
            .start_verification_for_test(credential_challenge(
                "workspace-a",
                "connection-host:host-a",
            ))
            .unwrap();
        let duplicate = coordinator
            .start_verification_for_test(credential_challenge(
                "workspace-a",
                "connection-host:host-a",
            ))
            .unwrap();

        assert!(Arc::ptr_eq(&first, &duplicate));
        assert_eq!(first.id, duplicate.id);
    }

    #[test]
    fn coordinator_allows_only_one_active_verification_per_workspace() {
        let coordinator = WorkspaceSshCoordinator::default();
        let first = coordinator
            .start_verification_for_test(credential_challenge(
                "workspace-a",
                "connection-host:host-a",
            ))
            .unwrap();
        let second = coordinator
            .start_verification_for_test(credential_challenge(
                "workspace-a",
                "connection-host:host-b",
            ))
            .unwrap();

        assert_ne!(first.id, second.id);
        {
            let store = coordinator.verifications.lock().unwrap();
            let queue = store.by_workspace.get("workspace-a").unwrap();
            assert_eq!(queue.active.as_ref().unwrap().id, first.id);
            assert_eq!(queue.queued.len(), 1);
        }

        coordinator
            .submit_verification(
                "workspace-a",
                &first.id,
                WorkspaceSshVerificationResponse::Cancel,
            )
            .unwrap();
        coordinator
            .finish_verification(None, "workspace-a", &first)
            .unwrap();

        let store = coordinator.verifications.lock().unwrap();
        let queue = store.by_workspace.get("workspace-a").unwrap();
        assert_eq!(queue.active.as_ref().unwrap().id, second.id);
        assert!(queue.queued.is_empty());
    }

    #[test]
    fn coordinator_reuses_successful_response_for_identical_waiters() {
        let coordinator = Arc::new(WorkspaceSshCoordinator::default());
        let challenge = credential_challenge("workspace-a", "connection-host:host-a");
        let first_coordinator = Arc::clone(&coordinator);
        let second_coordinator = Arc::clone(&coordinator);
        let first_challenge = challenge.clone();
        let second_challenge = challenge.clone();

        let first = std::thread::spawn(move || {
            first_coordinator
                .request_verification(None, first_challenge)
                .expect("first verification response")
        });
        let second = std::thread::spawn(move || {
            second_coordinator
                .request_verification(None, second_challenge)
                .expect("second verification response")
        });

        let verification_id = wait_for_active_verification_id(&coordinator, "workspace-a");
        coordinator
            .submit_verification(
                "workspace-a",
                &verification_id,
                WorkspaceSshVerificationResponse::Credential {
                    credential: SshCredentialInput {
                        kind: SshCredentialKind::Password,
                        value: "shared-secret".to_string(),
                    },
                    save_credential: false,
                },
            )
            .unwrap();

        let first_response = first.join().expect("first waiter");
        let second_response = second.join().expect("second waiter");

        assert!(matches!(
            first_response,
            WorkspaceSshVerificationResponse::Credential {
                credential: SshCredentialInput {
                    kind: SshCredentialKind::Password,
                    value
                },
                save_credential: false,
            } if value == "shared-secret"
        ));
        assert!(matches!(
            second_response,
            WorkspaceSshVerificationResponse::Credential {
                credential: SshCredentialInput {
                    kind: SshCredentialKind::Password,
                    value
                },
                save_credential: false,
            } if value == "shared-secret"
        ));
    }

    #[test]
    fn coordinator_stores_successful_prompt_as_workspace_encrypted_temporary_credential() {
        let coordinator = WorkspaceSshCoordinator::default();
        let auth_target = target("connection-host:host-a");
        let key = WorkspaceCredentialKey::new(
            "workspace-a",
            &auth_target,
            SshCredentialKind::Password,
            None,
        );

        coordinator
            .store_prompt_credential_after_success(
                key.clone(),
                &SshCredentialInput {
                    kind: SshCredentialKind::Password,
                    value: "prompt-secret".to_string(),
                },
            )
            .unwrap();

        assert_eq!(
            coordinator
                .read_workspace_encrypted_temporary_credential(&key)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("prompt-secret")
        );
    }

    #[test]
    fn host_scoped_coordinator_deduplicates_by_host_without_workspace_scope() {
        let coordinator = Arc::new(HostScopedSshCoordinator::default());
        let first_coordinator = Arc::clone(&coordinator);
        let second_coordinator = Arc::clone(&coordinator);
        let first_challenge = host_credential_challenge("host-a");
        let second_challenge = host_credential_challenge("host-a");

        let first = std::thread::spawn(move || {
            first_coordinator
                .request_verification(None, "host-a", first_challenge, no_emit_host_verification)
                .expect("first Host verification response")
        });
        let second = std::thread::spawn(move || {
            second_coordinator
                .request_verification(None, "host-a", second_challenge, no_emit_host_verification)
                .expect("second Host verification response")
        });

        let verification_id = wait_for_active_host_verification_id(&coordinator, "host-a");
        coordinator
            .submit_verification(
                "host-a",
                &verification_id,
                WorkspaceSshVerificationResponse::Credential {
                    credential: SshCredentialInput {
                        kind: SshCredentialKind::Password,
                        value: "host-secret".to_string(),
                    },
                    save_credential: false,
                },
            )
            .unwrap();

        let first_response = first.join().expect("first waiter");
        let second_response = second.join().expect("second waiter");
        assert!(matches!(
            first_response,
            WorkspaceSshVerificationResponse::Credential {
                credential: SshCredentialInput { value, .. },
                save_credential: false,
            } if value == "host-secret"
        ));
        assert!(matches!(
            second_response,
            WorkspaceSshVerificationResponse::Credential {
                credential: SshCredentialInput { value, .. },
                save_credential: false,
            } if value == "host-secret"
        ));
    }

    fn wait_for_active_verification_id(
        coordinator: &WorkspaceSshCoordinator,
        workspace_id: &str,
    ) -> String {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            {
                let store = coordinator.verifications.lock().unwrap();
                if let Some(id) = store
                    .by_workspace
                    .get(workspace_id)
                    .and_then(|queue| queue.active.as_ref())
                    .map(|request| request.id.clone())
                {
                    return id;
                }
            }
            assert!(
                Instant::now() < deadline,
                "workspace verification did not become active"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_active_host_verification_id(
        coordinator: &HostScopedSshCoordinator,
        host_id: &str,
    ) -> String {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            {
                let store = coordinator.verifications.lock().unwrap();
                if let Some(id) = store
                    .by_host
                    .get(host_id)
                    .and_then(|queue| queue.active.as_ref())
                    .map(|request| request.id.clone())
                {
                    return id;
                }
            }
            assert!(
                Instant::now() < deadline,
                "Host verification did not become active"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn no_emit_host_verification(
        _app: &AppHandle,
        _host_id: String,
        _verification_id: String,
        _challenge: SshHostScopedChallenge,
    ) -> Result<()> {
        Ok(())
    }
}
