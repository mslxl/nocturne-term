use std::{
    collections::HashMap,
    net::{IpAddr, Shutdown, TcpListener, TcpStream, ToSocketAddrs},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

use portable_pty::PtySize;
use ssh2::Session;
use tauri::{AppHandle, Emitter};
use zeroize::Zeroizing;

use crate::{
    config::{
        connection_host_by_id, resolve_openssh_proxy_jump_chain, ssh_known_hosts_path,
        update_connection_host_port_forwards,
    },
    error::{invalid_error, missing_error, Result},
    terminal::{
        bridge_proxy_channel_until_stopped, connect_authenticated_ssh_session,
        default_ssh_username, ssh_network_hostname, SshWorkerInput,
    },
    types::{
        ConnectionHostEntry, ConnectionProtocol, PortForwardDirection, PortForwardDraft,
        PortForwardDraftInput, PortForwardEvent, PortForwardEventLevel, PortForwardNonLoopbackRisk,
        PortForwardNonLoopbackRiskInput, PortForwardPersistence, PortForwardRule,
        PortForwardRuleIdInput, PortForwardRuleInput, PortForwardRuleSnapshot,
        PortForwardRuleStatus, PortForwardRuntimeRule, PortForwardSnapshot,
        PortForwardSshVerificationRequiredEvent, PortForwardSshVerificationSubmitInput,
        SshAuthTarget, SshCredentialInput, SshCredentialKind, SshHostScopedChallenge,
        WorkspaceSshVerificationResponse,
    },
    workspace_ssh::{
        connection_host_auth_target, host_scoped_ssh_coordinator, ScopedEncryptedCredentialStore,
    },
};

pub(crate) const PORT_FORWARD_SSH_VERIFICATION_REQUIRED_EVENT: &str =
    "port-forwarding://ssh-verification-required";

const PORT_FORWARD_EVENT_LIMIT: usize = 50;
const PORT_FORWARD_RECONNECT_BACKOFF_MS: [u64; 5] = [1_000, 2_000, 5_000, 10_000, 30_000];

#[derive(Default)]
struct PortForwardStore {
    hosts: HashMap<String, HostPortForwardRuntime>,
    sequence: u64,
}

#[derive(Default)]
struct HostPortForwardRuntime {
    temporary_rules: Vec<PortForwardRule>,
    runtime: HashMap<String, PortForwardRuntimeRule>,
    draft: Option<PortForwardDraft>,
    credential_scope: HostPortForwardCredentialScope,
    worker: Option<HostPortForwardWorkerHandle>,
}

struct HostPortForwardWorkerHandle {
    commands: Sender<HostPortForwardWorkerCommand>,
}

impl Clone for HostPortForwardWorkerHandle {
    fn clone(&self) -> Self {
        Self {
            commands: self.commands.clone(),
        }
    }
}

enum HostPortForwardWorkerCommand {
    StartRule {
        rule: PortForwardRule,
        persistence: PortForwardPersistence,
    },
    StopRule {
        rule_id: String,
        done: Sender<()>,
    },
    StopAll,
}

struct HostPortForwardWorker {
    app: Option<AppHandle>,
    host_id: String,
    input: SshWorkerInput,
    receiver: Receiver<HostPortForwardWorkerCommand>,
    session: Option<Session>,
    active_rules: HashMap<String, ActivePortForwardRule>,
    reconnect_backoff: HashMap<String, ReconnectBackoff>,
}

struct ActivePortForwardRule {
    stop: Arc<AtomicBool>,
    listener_guard: Option<thread::JoinHandle<()>>,
    connection_guards: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
}

struct ActiveConnectionCounter {
    host_id: String,
    rule_id: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ReconnectBackoff {
    attempts: usize,
}

#[derive(Default)]
struct HostPortForwardCredentialScope {
    credentials: ScopedEncryptedCredentialStore<HostPortForwardCredentialKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct HostPortForwardCredentialKey {
    auth_target_id: String,
    username: String,
    kind: SshCredentialKind,
    identity_file: Option<String>,
}

static PORT_FORWARD_STORE: OnceLock<Arc<Mutex<PortForwardStore>>> = OnceLock::new();

fn port_forward_store() -> Arc<Mutex<PortForwardStore>> {
    PORT_FORWARD_STORE
        .get_or_init(|| Arc::new(Mutex::new(PortForwardStore::default())))
        .clone()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_port_forward_snapshot(
    app: AppHandle,
    host_id: String,
) -> Result<PortForwardSnapshot> {
    host_snapshot(&app, &host_id)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn create_or_update_port_forward_rule(
    app: AppHandle,
    input: PortForwardRuleInput,
) -> Result<PortForwardSnapshot> {
    let host = connection_host_by_id(&app, &input.host_id)?;
    if input.persistence == PortForwardPersistence::Saved && host.read_only {
        return Err(invalid_error(
            "saved port forwards are unavailable for read-only OpenSSH hosts",
        ));
    }
    reject_unconfirmed_non_loopback(&input.rule)?;
    reject_duplicate_runtime_rule(&input.host_id, &host.document.port_forwards, &input.rule)?;
    let previous_rule =
        port_forward_rule_by_id(&input.host_id, &host.document.port_forwards, &input.rule.id)?;
    let should_start_after_save =
        should_start_rule_after_save(&input.host_id, previous_rule.as_ref(), &input.rule)?;
    let rule_id = input.rule.id.clone();
    let saved_rule = input.rule.clone();
    let saved_persistence = input.persistence;
    match input.persistence {
        PortForwardPersistence::JustThisTime => {
            if !host.read_only {
                update_connection_host_port_forwards(&app, &input.host_id, |rules| {
                    rules.retain(|rule| rule.id != rule_id);
                    Ok(())
                })?;
            }
            let store = port_forward_store();
            let mut store = store
                .lock()
                .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
            let runtime = store.hosts.entry(input.host_id.clone()).or_default();
            runtime
                .temporary_rules
                .retain(|rule| rule.id != input.rule.id);
            upsert_rule(&mut runtime.temporary_rules, input.rule);
        }
        PortForwardPersistence::Saved => {
            let rule = input.rule;
            update_connection_host_port_forwards(&app, &input.host_id, |rules| {
                upsert_rule(rules, rule);
                Ok(())
            })?;
            let store = port_forward_store();
            let mut store = store
                .lock()
                .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
            let runtime = store.hosts.entry(input.host_id.clone()).or_default();
            runtime
                .temporary_rules
                .retain(|rule| !rules_have_same_id(rule, &rule_id));
        }
    }
    clear_matching_draft_after_save(&input.host_id, &saved_rule, saved_persistence)?;
    if host.document.protocol == ConnectionProtocol::Ssh && should_start_after_save {
        start_rule_on_host_runtime(&app, &host, saved_rule.clone(), saved_persistence)?;
    }
    host_snapshot(&app, &input.host_id)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn update_port_forward_draft(
    app: AppHandle,
    input: PortForwardDraftInput,
) -> Result<PortForwardSnapshot> {
    let _host = connection_host_by_id(&app, &input.host_id)?;
    let store = port_forward_store();
    let mut store = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    let runtime = store.hosts.entry(input.host_id.clone()).or_default();
    runtime.draft = Some(input.draft);
    drop(store);
    host_snapshot(&app, &input.host_id)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn clear_port_forward_draft(
    app: AppHandle,
    host_id: String,
) -> Result<PortForwardSnapshot> {
    let _host = connection_host_by_id(&app, &host_id)?;
    let store = port_forward_store();
    let mut store = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    if let Some(runtime) = store.hosts.get_mut(&host_id) {
        runtime.draft = None;
    }
    drop(store);
    host_snapshot(&app, &host_id)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn check_port_forward_non_loopback_risk(
    input: PortForwardNonLoopbackRiskInput,
) -> Result<PortForwardNonLoopbackRisk> {
    Ok(non_loopback_risk_for_rule(&input.rule))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_port_forward_rule(
    app: AppHandle,
    input: PortForwardRuleIdInput,
) -> Result<PortForwardSnapshot> {
    let host = connection_host_by_id(&app, &input.host_id)?;
    let mut removed = false;
    if !host.read_only {
        let _ = update_connection_host_port_forwards(&app, &input.host_id, |rules| {
            let before = rules.len();
            rules.retain(|rule| rule.id != input.rule_id);
            removed = before != rules.len();
            Ok(())
        })?;
    }
    let store = port_forward_store();
    let mut guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    if let Some(runtime) = guard.hosts.get_mut(&input.host_id) {
        let before = runtime.temporary_rules.len();
        runtime
            .temporary_rules
            .retain(|rule| rule.id != input.rule_id);
        removed = removed || before != runtime.temporary_rules.len();
        runtime.runtime.remove(&input.rule_id);
    }
    if !removed {
        return Err(missing_error(format!(
            "port forward rule {} not found",
            input.rule_id
        )));
    }
    drop(guard);
    host_snapshot(&app, &input.host_id)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn start_port_forward_rule(
    app: AppHandle,
    input: PortForwardRuleIdInput,
) -> Result<PortForwardSnapshot> {
    let host = connection_host_by_id(&app, &input.host_id)?;
    if host.document.protocol != ConnectionProtocol::Ssh {
        return Err(invalid_error("port forwarding is supported for SSH hosts"));
    }
    let rule =
        port_forward_rule_by_id(&input.host_id, &host.document.port_forwards, &input.rule_id)?
            .ok_or_else(|| {
                missing_error(format!("port forward rule {} not found", input.rule_id))
            })?;
    reject_unconfirmed_non_loopback(&rule)?;
    let persistence =
        rule_persistence(&input.host_id, &host.document.port_forwards, &input.rule_id)?;
    start_rule_on_host_runtime(&app, &host, rule, persistence)?;
    host_snapshot(&app, &input.host_id)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn stop_port_forward_rule(
    app: AppHandle,
    input: PortForwardRuleIdInput,
) -> Result<PortForwardSnapshot> {
    stop_rule_on_host_runtime(&input.host_id, &input.rule_id)?;
    host_snapshot(&app, &input.host_id)
}

pub(crate) fn start_saved_port_forwards_for_host_open(
    app: &AppHandle,
    host: &ConnectionHostEntry,
) -> Result<()> {
    if host.document.protocol != ConnectionProtocol::Ssh {
        return Ok(());
    }
    let auto_rule_ids =
        host_open_auto_start_rule_ids(host.document.protocol.clone(), &host.document.port_forwards);
    for rule in host
        .document
        .port_forwards
        .iter()
        .filter(|rule| auto_rule_ids.iter().any(|id| id == &rule.id))
    {
        if let Err(error) = reject_unconfirmed_non_loopback(rule) {
            set_rule_status_with_persistence(
                &host.id,
                &rule.id,
                PortForwardRuleStatus::NeedsConfirmation,
                Some(error.to_string()),
                Some(PortForwardPersistence::Saved),
            )?;
            continue;
        }
        start_rule_on_host_runtime(app, host, rule.clone(), PortForwardPersistence::Saved)?;
    }
    Ok(())
}

fn host_open_auto_start_rule_ids(
    protocol: ConnectionProtocol,
    rules: &[PortForwardRule],
) -> Vec<String> {
    if protocol != ConnectionProtocol::Ssh {
        return Vec::new();
    }
    rules
        .iter()
        .filter(|rule| rule.connect_on_host_open)
        .map(|rule| rule.id.clone())
        .collect()
}

pub(crate) fn close_host_port_forward_runtime(host_id: &str) -> Result<()> {
    let _ = host_scoped_ssh_coordinator().cancel_host(host_id);
    let store = port_forward_store();
    let mut guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    if let Some(mut runtime) = guard.hosts.remove(host_id) {
        runtime.stop_all_rules();
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn host_port_forward_close_requires_confirmation(host_id: &str) -> Result<bool> {
    let store = port_forward_store();
    let guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    Ok(guard
        .hosts
        .get(host_id)
        .is_some_and(HostPortForwardRuntime::requires_close_confirmation))
}

#[cfg(test)]
pub(crate) fn set_port_forward_rule_status_for_test(
    host_id: &str,
    rule_id: &str,
    status: PortForwardRuleStatus,
) -> Result<()> {
    set_rule_status(host_id, rule_id, status, None)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn submit_port_forward_ssh_verification(
    input: PortForwardSshVerificationSubmitInput,
) -> Result<()> {
    host_scoped_ssh_coordinator().submit_verification(
        &input.host_id,
        &input.verification_id,
        input.response,
    )
}

pub(crate) fn emit_port_forward_ssh_verification_required(
    app: &AppHandle,
    host_id: String,
    verification_id: String,
    challenge: SshHostScopedChallenge,
) -> Result<()> {
    app.emit(
        PORT_FORWARD_SSH_VERIFICATION_REQUIRED_EVENT,
        PortForwardSshVerificationRequiredEvent {
            host_id,
            verification_id,
            challenge,
        },
    )
    .map_err(|error| invalid_error(error.to_string()))
}

pub(crate) fn request_host_port_forward_ssh_verification(
    app: Option<&AppHandle>,
    host_id: &str,
    challenge: SshHostScopedChallenge,
) -> Result<WorkspaceSshVerificationResponse> {
    host_scoped_ssh_coordinator().request_verification(
        app,
        host_id,
        challenge,
        emit_port_forward_ssh_verification_required,
    )
}

pub(crate) fn store_host_port_forward_credential(
    host_id: &str,
    auth_target: &crate::types::SshAuthTarget,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
    credential: &SshCredentialInput,
) -> Result<()> {
    let store = port_forward_store();
    let mut guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    let runtime = guard.hosts.entry(host_id.to_string()).or_default();
    runtime
        .credential_scope
        .store_prompt_credential_after_success(
            host_id,
            auth_target,
            kind,
            identity_file,
            credential,
        )
}

pub(crate) fn read_host_port_forward_credential(
    host_id: &str,
    auth_target: &crate::types::SshAuthTarget,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
) -> Result<Option<Zeroizing<String>>> {
    let store = port_forward_store();
    let guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    let Some(runtime) = guard.hosts.get(host_id) else {
        return Ok(None);
    };
    runtime
        .credential_scope
        .read_temporary_credential(host_id, auth_target, kind, identity_file)
}

pub(crate) fn remove_host_port_forward_credential(
    host_id: &str,
    auth_target: &crate::types::SshAuthTarget,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
) -> Result<()> {
    let store = port_forward_store();
    let mut guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    if let Some(runtime) = guard.hosts.get_mut(host_id) {
        runtime.credential_scope.remove_temporary_credential(
            host_id,
            auth_target,
            kind,
            identity_file,
        );
    }
    Ok(())
}

fn host_snapshot(app: &AppHandle, host_id: &str) -> Result<PortForwardSnapshot> {
    let host = connection_host_by_id(app, host_id)?;
    let supported = host.document.protocol == ConnectionProtocol::Ssh;
    let unsupported_reason = if supported {
        None
    } else {
        Some("Port forwarding is supported for SSH hosts.".to_string())
    };
    let store = port_forward_store();
    let mut guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    let runtime = guard.hosts.entry(host_id.to_string()).or_default();
    let mut rules = Vec::new();
    for rule in &host.document.port_forwards {
        rules.push(rule_snapshot(
            rule,
            PortForwardPersistence::Saved,
            &mut runtime.runtime,
        ));
    }
    for rule in &runtime.temporary_rules {
        rules.push(rule_snapshot(
            rule,
            PortForwardPersistence::JustThisTime,
            &mut runtime.runtime,
        ));
    }
    Ok(PortForwardSnapshot {
        host_id: host_id.to_string(),
        supported,
        unsupported_reason,
        rules,
        draft: runtime.draft.clone(),
    })
}

impl HostPortForwardRuntime {
    fn stop_all_rules(&mut self) {
        if let Some(worker) = self.worker.take() {
            let _ = worker.commands.send(HostPortForwardWorkerCommand::StopAll);
        }
        for runtime in self.runtime.values_mut() {
            runtime.status = PortForwardRuleStatus::Stopped;
            runtime.intended_running = false;
            runtime.active_connections = 0;
            runtime.error = None;
        }
        self.credential_scope.clear();
    }

    #[cfg(test)]
    fn requires_close_confirmation(&self) -> bool {
        self.runtime.values().any(|runtime| {
            matches!(
                runtime.status,
                PortForwardRuleStatus::Starting
                    | PortForwardRuleStatus::Running
                    | PortForwardRuleStatus::Reconnecting
            )
        })
    }
}

impl ReconnectBackoff {
    fn next_delay(&mut self, intended_running: bool) -> Option<Duration> {
        if !intended_running {
            self.attempts = 0;
            return None;
        }
        let index = self
            .attempts
            .min(PORT_FORWARD_RECONNECT_BACKOFF_MS.len().saturating_sub(1));
        self.attempts = self.attempts.saturating_add(1);
        Some(Duration::from_millis(
            PORT_FORWARD_RECONNECT_BACKOFF_MS[index],
        ))
    }

    fn reset(&mut self) {
        self.attempts = 0;
    }
}

impl HostPortForwardWorker {
    fn run(mut self) {
        while let Ok(command) = self.receiver.recv() {
            match command {
                HostPortForwardWorkerCommand::StartRule { rule, persistence } => {
                    self.start_rule_with_reconnect(rule, persistence);
                }
                HostPortForwardWorkerCommand::StopRule { rule_id, done } => {
                    self.stop_rule(&rule_id);
                    let _ = set_rule_status(
                        &self.host_id,
                        &rule_id,
                        PortForwardRuleStatus::Stopped,
                        None,
                    );
                    self.close_session_if_idle();
                    let _ = done.send(());
                }
                HostPortForwardWorkerCommand::StopAll => {
                    let rule_ids = self.active_rules.keys().cloned().collect::<Vec<_>>();
                    for rule_id in rule_ids {
                        self.stop_rule(&rule_id);
                        let _ = set_rule_status(
                            &self.host_id,
                            &rule_id,
                            PortForwardRuleStatus::Stopped,
                            None,
                        );
                    }
                    self.session = None;
                    break;
                }
            }
        }
    }

    fn start_rule(
        &mut self,
        mut rule: PortForwardRule,
        persistence: PortForwardPersistence,
    ) -> Result<()> {
        self.stop_rule(&rule.id);
        let session = self.ensure_session()?;
        match rule.direction {
            PortForwardDirection::LocalToRemote => {
                self.start_local_to_remote_rule(session, &mut rule, persistence)
            }
            PortForwardDirection::RemoteToLocal => {
                self.start_remote_to_local_rule(session, &mut rule, persistence)
            }
        }
    }

    fn start_rule_with_reconnect(
        &mut self,
        rule: PortForwardRule,
        persistence: PortForwardPersistence,
    ) {
        loop {
            match self.start_rule(rule.clone(), persistence) {
                Ok(()) => {
                    self.reconnect_backoff
                        .entry(rule.id.clone())
                        .or_default()
                        .reset();
                    return;
                }
                Err(error) if rule_should_reconnect(&self.host_id, &rule.id) => {
                    if is_port_in_use_error(&error) {
                        self.reconnect_backoff
                            .entry(rule.id.clone())
                            .or_default()
                            .reset();
                        let _ = set_rule_status_with_persistence(
                            &self.host_id,
                            &rule.id,
                            PortForwardRuleStatus::Failed,
                            Some(format!("listen port is no longer available: {error}")),
                            Some(persistence),
                        );
                        return;
                    }
                    self.stop_rule(&rule.id);
                    self.session = None;
                    let delay = self
                        .reconnect_backoff
                        .entry(rule.id.clone())
                        .or_default()
                        .next_delay(true)
                        .unwrap_or_else(|| {
                            Duration::from_millis(PORT_FORWARD_RECONNECT_BACKOFF_MS[0])
                        });
                    let _ = set_rule_status_with_persistence(
                        &self.host_id,
                        &rule.id,
                        PortForwardRuleStatus::Reconnecting,
                        Some(format!("reconnect scheduled after failure: {error}")),
                        Some(persistence),
                    );
                    if !self.wait_for_reconnect_delay(&rule.id, delay) {
                        return;
                    }
                }
                Err(error) => {
                    self.reconnect_backoff
                        .entry(rule.id.clone())
                        .or_default()
                        .reset();
                    let _ = set_rule_status_with_persistence(
                        &self.host_id,
                        &rule.id,
                        PortForwardRuleStatus::Failed,
                        Some(error.to_string()),
                        Some(persistence),
                    );
                    return;
                }
            }
        }
    }

    fn wait_for_reconnect_delay(&mut self, rule_id: &str, delay: Duration) -> bool {
        let step = Duration::from_millis(100);
        let mut waited = Duration::ZERO;
        while waited < delay {
            match self.receiver.recv_timeout(step) {
                Ok(HostPortForwardWorkerCommand::StopRule {
                    rule_id: stopped,
                    done,
                })
                    if stopped == rule_id =>
                {
                    self.stop_rule(&stopped);
                    let _ = set_rule_status(
                        &self.host_id,
                        &stopped,
                        PortForwardRuleStatus::Stopped,
                        None,
                    );
                    self.close_session_if_idle();
                    let _ = done.send(());
                    return false;
                }
                Ok(HostPortForwardWorkerCommand::StopRule {
                    rule_id: stopped,
                    done,
                }) => {
                    self.stop_rule(&stopped);
                    let _ = set_rule_status(
                        &self.host_id,
                        &stopped,
                        PortForwardRuleStatus::Stopped,
                        None,
                    );
                    self.close_session_if_idle();
                    let _ = done.send(());
                }
                Ok(HostPortForwardWorkerCommand::StartRule { rule, persistence }) => {
                    self.start_rule_with_reconnect(rule, persistence);
                }
                Ok(HostPortForwardWorkerCommand::StopAll) => {
                    let rule_ids = self.active_rules.keys().cloned().collect::<Vec<_>>();
                    for rule_id in rule_ids {
                        self.stop_rule(&rule_id);
                        let _ = set_rule_status(
                            &self.host_id,
                            &rule_id,
                            PortForwardRuleStatus::Stopped,
                            None,
                        );
                    }
                    self.session = None;
                    return false;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    waited = waited.saturating_add(step);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return false,
            }
            if !rule_should_reconnect(&self.host_id, rule_id) {
                return false;
            }
        }
        true
    }

    fn ensure_session(&mut self) -> Result<Session> {
        if let Some(session) = &self.session {
            return Ok(session.clone());
        }
        let authenticated = connect_authenticated_ssh_session(&self.input)?;
        authenticated
            .tcp_mode
            .set_nonblocking(true)
            .map_err(crate::error::terminal_error)?;
        authenticated.session.set_blocking(false);
        self.session = Some(authenticated.session.clone());
        Ok(authenticated.session)
    }

    fn start_local_to_remote_rule(
        &mut self,
        session: Session,
        rule: &mut PortForwardRule,
        persistence: PortForwardPersistence,
    ) -> Result<()> {
        let listener = TcpListener::bind((rule.local_address.as_str(), rule.local_port))
            .map_err(crate::error::terminal_error)?;
        listener
            .set_nonblocking(true)
            .map_err(crate::error::terminal_error)?;
        let assigned_port = listener
            .local_addr()
            .map_err(crate::error::terminal_error)?
            .port();
        apply_assigned_listen_port_to_runtime(
            self.app.as_ref(),
            &self.host_id,
            rule,
            assigned_port,
            persistence,
        )?;
        let stop = Arc::new(AtomicBool::new(false));
        let connection_guards = Arc::new(Mutex::new(Vec::new()));
        let guard = spawn_local_forward_listener(
            self.host_id.clone(),
            rule.clone(),
            session,
            listener,
            Arc::clone(&stop),
            Arc::clone(&connection_guards),
        );
        self.active_rules.insert(
            rule.id.clone(),
            ActivePortForwardRule {
                stop,
                listener_guard: Some(guard),
                connection_guards,
            },
        );
        set_rule_status_with_persistence(
            &self.host_id,
            &rule.id,
            PortForwardRuleStatus::Running,
            None,
            Some(persistence),
        )
    }

    fn start_remote_to_local_rule(
        &mut self,
        session: Session,
        rule: &mut PortForwardRule,
        persistence: PortForwardPersistence,
    ) -> Result<()> {
        let (listener, assigned_port) = session
            .channel_forward_listen(rule.remote_port, Some(&rule.remote_address), Some(128))
            .map_err(crate::error::terminal_error)?;
        apply_assigned_listen_port_to_runtime(
            self.app.as_ref(),
            &self.host_id,
            rule,
            assigned_port,
            persistence,
        )?;
        let stop = Arc::new(AtomicBool::new(false));
        let connection_guards = Arc::new(Mutex::new(Vec::new()));
        let guard = spawn_remote_forward_listener(
            self.host_id.clone(),
            rule.clone(),
            listener,
            Arc::clone(&stop),
            Arc::clone(&connection_guards),
        );
        self.active_rules.insert(
            rule.id.clone(),
            ActivePortForwardRule {
                stop,
                listener_guard: Some(guard),
                connection_guards,
            },
        );
        set_rule_status_with_persistence(
            &self.host_id,
            &rule.id,
            PortForwardRuleStatus::Running,
            None,
            Some(persistence),
        )
    }

    fn stop_rule(&mut self, rule_id: &str) {
        let Some(mut active) = self.active_rules.remove(rule_id) else {
            return;
        };
        active.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect("127.0.0.1:9");
        if let Some(guard) = active.listener_guard.take() {
            let _ = guard.join();
        }
        if let Ok(mut guards) = active.connection_guards.lock() {
            for guard in guards.drain(..) {
                let _ = guard.join();
            }
        }
        update_rule_active_connections(&self.host_id, rule_id, 0);
    }

    fn close_session_if_idle(&mut self) {
        if self.active_rules.is_empty() {
            self.session = None;
            clear_host_worker_if_current(&self.host_id);
        }
    }
}

impl HostPortForwardCredentialScope {
    fn store_prompt_credential_after_success(
        &mut self,
        host_id: &str,
        auth_target: &SshAuthTarget,
        kind: SshCredentialKind,
        identity_file: Option<&str>,
        credential: &SshCredentialInput,
    ) -> Result<()> {
        if credential.kind != kind {
            return Err(invalid_error(
                "SSH credential kind does not match Host port forwarding challenge",
            ));
        }
        let key = HostPortForwardCredentialKey::new(auth_target, kind, identity_file);
        self.credentials
            .put(host_id, key, Zeroizing::new(credential.value.clone()))
    }

    fn read_temporary_credential(
        &self,
        host_id: &str,
        auth_target: &SshAuthTarget,
        kind: SshCredentialKind,
        identity_file: Option<&str>,
    ) -> Result<Option<Zeroizing<String>>> {
        let key = HostPortForwardCredentialKey::new(auth_target, kind, identity_file);
        self.credentials.get(host_id, &key)
    }

    fn remove_temporary_credential(
        &mut self,
        host_id: &str,
        auth_target: &SshAuthTarget,
        kind: SshCredentialKind,
        identity_file: Option<&str>,
    ) {
        let key = HostPortForwardCredentialKey::new(auth_target, kind, identity_file);
        self.credentials.remove(host_id, &key);
    }

    fn clear(&mut self) {
        self.credentials = ScopedEncryptedCredentialStore::default();
    }

    #[cfg(test)]
    fn raw_ciphertext_for_test(
        &self,
        host_id: &str,
        auth_target: &SshAuthTarget,
        kind: SshCredentialKind,
        identity_file: Option<&str>,
    ) -> Option<&[u8]> {
        let key = HostPortForwardCredentialKey::new(auth_target, kind, identity_file);
        self.credentials.raw_ciphertext_for_test(host_id, &key)
    }
}

impl HostPortForwardCredentialKey {
    fn new(
        auth_target: &SshAuthTarget,
        kind: SshCredentialKind,
        identity_file: Option<&str>,
    ) -> Self {
        Self {
            auth_target_id: auth_target.id.clone(),
            username: auth_target.username.clone(),
            kind,
            identity_file: identity_file.map(ToOwned::to_owned),
        }
    }
}

fn rule_snapshot(
    rule: &PortForwardRule,
    persistence: PortForwardPersistence,
    runtime: &mut HashMap<String, PortForwardRuntimeRule>,
) -> PortForwardRuleSnapshot {
    let runtime = runtime
        .entry(rule.id.clone())
        .or_insert_with(|| stopped_runtime_rule(rule.id.clone(), persistence));
    runtime.persistence = persistence;
    PortForwardRuleSnapshot {
        rule: rule.clone(),
        runtime: runtime.clone(),
    }
}

fn stopped_runtime_rule(
    rule_id: String,
    persistence: PortForwardPersistence,
) -> PortForwardRuntimeRule {
    PortForwardRuntimeRule {
        rule_id,
        persistence,
        status: PortForwardRuleStatus::Stopped,
        intended_running: false,
        active_connections: 0,
        effective_local_port: None,
        effective_remote_port: None,
        warning: None,
        error: None,
        events: Vec::new(),
    }
}

fn start_rule_on_host_runtime(
    app: &AppHandle,
    host: &ConnectionHostEntry,
    rule: PortForwardRule,
    persistence: PortForwardPersistence,
) -> Result<()> {
    let input = port_forward_ssh_input_for_host(app, host)?;
    let handle = ensure_host_worker(app, &host.id, input)?;
    set_rule_status_with_persistence(
        &host.id,
        &rule.id,
        PortForwardRuleStatus::Starting,
        None,
        Some(persistence),
    )?;
    handle
        .commands
        .send(HostPortForwardWorkerCommand::StartRule { rule, persistence })
        .map_err(|_| invalid_error("Host port forwarding worker is unavailable"))
}

fn stop_rule_on_host_runtime(host_id: &str, rule_id: &str) -> Result<()> {
    let (done_sender, done_receiver) = mpsc::channel();
    let command_sent = {
        let store = port_forward_store();
        let guard = store
            .lock()
            .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
        guard
            .hosts
            .get(host_id)
            .and_then(|runtime| runtime.worker.as_ref())
            .map(|worker| {
                worker
                    .commands
                    .send(HostPortForwardWorkerCommand::StopRule {
                        rule_id: rule_id.to_string(),
                        done: done_sender,
                    })
            })
    };
    match command_sent {
        Some(Ok(())) => done_receiver
            .recv()
            .map_err(|_| invalid_error("Host port forwarding worker stopped before rule stop completed"))?,
        None => {}
        Some(Err(_)) => {
            return Err(invalid_error("Host port forwarding worker is unavailable"));
        }
    }
    set_rule_status(host_id, rule_id, PortForwardRuleStatus::Stopped, None)
}

fn ensure_host_worker(
    app: &AppHandle,
    host_id: &str,
    input: SshWorkerInput,
) -> Result<HostPortForwardWorkerHandle> {
    let store = port_forward_store();
    let mut guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    let runtime = guard.hosts.entry(host_id.to_string()).or_default();
    if let Some(worker) = &runtime.worker {
        return Ok(worker.clone());
    }
    let (sender, receiver) = mpsc::channel();
    let handle = HostPortForwardWorkerHandle {
        commands: sender.clone(),
    };
    runtime.worker = Some(handle.clone());
    let worker = HostPortForwardWorker {
        app: Some(app.clone()),
        host_id: host_id.to_string(),
        input,
        receiver,
        session: None,
        active_rules: HashMap::new(),
        reconnect_backoff: HashMap::new(),
    };
    thread::spawn(move || worker.run());
    Ok(handle)
}

fn port_forward_ssh_input_for_host(
    app: &AppHandle,
    host: &ConnectionHostEntry,
) -> Result<SshWorkerInput> {
    let ssh = host
        .document
        .ssh
        .clone()
        .ok_or_else(|| invalid_error("ssh connection host requires ssh config"))?;
    let proxy_jump_chain = if matches!(
        host.source,
        crate::types::ConnectionHostSource::OpenSshConfig
    ) {
        match (host.path.as_deref(), ssh.proxy_jump.as_deref()) {
            (Some(path), Some(proxy_jump)) => Some(resolve_openssh_proxy_jump_chain(
                Path::new(path),
                proxy_jump,
            )?),
            _ => None,
        }
    } else {
        None
    };
    let username = default_ssh_username(&ssh)?;
    Ok(SshWorkerInput {
        app: Some(app.clone()),
        session_id: format!("port-forward-host-{}", host.id),
        workspace_id: format!("host-port-forward:{}", host.id),
        source_tool_tab_id: None,
        display_name: format!("{} Ports", host.document.name),
        auth_target: connection_host_auth_target(
            &host.id,
            &host.document.name,
            &username,
            &ssh.hostname,
            ssh.port,
        ),
        ssh,
        proxy_jump_chain,
        username,
        size: PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 800,
            pixel_height: 600,
        },
        trust_path: ssh_known_hosts_path(app)?,
        accept_new_host_key: false,
        update_changed_host_key: false,
        credential: None,
        save_credential: false,
        verification_scope: crate::terminal::SshVerificationScope::HostPortForward {
            host_id: host.id.clone(),
        },
    })
}

fn rule_persistence(
    host_id: &str,
    saved_rules: &[PortForwardRule],
    rule_id: &str,
) -> Result<PortForwardPersistence> {
    if saved_rules.iter().any(|rule| rule.id == rule_id) {
        return Ok(PortForwardPersistence::Saved);
    }
    let store = port_forward_store();
    let guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    if guard.hosts.get(host_id).is_some_and(|runtime| {
        runtime
            .temporary_rules
            .iter()
            .any(|rule| rule.id == rule_id)
    }) {
        return Ok(PortForwardPersistence::JustThisTime);
    }
    Err(missing_error(format!(
        "port forward rule {rule_id} not found"
    )))
}

fn should_start_rule_after_save(
    host_id: &str,
    previous_rule: Option<&PortForwardRule>,
    saved_rule: &PortForwardRule,
) -> Result<bool> {
    let Some(previous_rule) = previous_rule else {
        return Ok(true);
    };
    if semantic_key(previous_rule) == semantic_key(saved_rule) {
        return Ok(false);
    }
    let store = port_forward_store();
    let guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    Ok(guard
        .hosts
        .get(host_id)
        .and_then(|runtime| runtime.runtime.get(&saved_rule.id))
        .is_some_and(|runtime| {
            matches!(
                runtime.status,
                PortForwardRuleStatus::Starting
                    | PortForwardRuleStatus::Running
                    | PortForwardRuleStatus::Reconnecting
            )
        }))
}

#[cfg(test)]
fn set_runtime_rule_for_test(host_id: &str, rule_id: &str, runtime: PortForwardRuntimeRule) {
    let store = port_forward_store();
    let mut guard = store.lock().expect("store lock");
    guard
        .hosts
        .entry(host_id.to_string())
        .or_default()
        .runtime
        .insert(rule_id.to_string(), runtime);
}

fn apply_assigned_listen_port_to_runtime(
    app: Option<&AppHandle>,
    host_id: &str,
    rule: &mut PortForwardRule,
    assigned_port: u16,
    persistence: PortForwardPersistence,
) -> Result<()> {
    let mut runtime_after_assignment = {
        let store = port_forward_store();
        let mut guard = store
            .lock()
            .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
        let host_runtime = guard.hosts.entry(host_id.to_string()).or_default();
        let runtime = host_runtime
            .runtime
            .entry(rule.id.clone())
            .or_insert_with(|| stopped_runtime_rule(rule.id.clone(), persistence));
        runtime.persistence = persistence;
        apply_assigned_listen_port(rule, runtime, assigned_port);
        runtime.clone()
    };

    if persistence == PortForwardPersistence::Saved {
        let app = app.ok_or_else(|| {
            invalid_error("saved dynamic port writeback requires an application handle")
        })?;
        let writeback = update_connection_host_port_forwards(app, host_id, |rules| {
            if let Some(saved_rule) = rules.iter_mut().find(|saved_rule| saved_rule.id == rule.id) {
                match rule.direction {
                    PortForwardDirection::LocalToRemote => saved_rule.local_port = rule.local_port,
                    PortForwardDirection::RemoteToLocal => {
                        saved_rule.remote_port = rule.remote_port
                    }
                }
                Ok(())
            } else {
                Err(missing_error(format!(
                    "saved port forward rule {} not found",
                    rule.id
                )))
            }
        })
        .map(|_| ());
        if mark_dynamic_port_writeback_result(&mut runtime_after_assignment, writeback).is_err() {
            replace_runtime_rule(host_id, &rule.id, runtime_after_assignment)?;
            push_rule_runtime_event(
                host_id,
                &rule.id,
                PortForwardEventLevel::Warn,
                "port was assigned but could not be saved".to_string(),
            );
            return Ok(());
        }
        replace_runtime_rule(host_id, &rule.id, runtime_after_assignment)?;
    }
    Ok(())
}

fn replace_runtime_rule(
    host_id: &str,
    rule_id: &str,
    updated: PortForwardRuntimeRule,
) -> Result<()> {
    let store = port_forward_store();
    let mut guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    let runtime = guard.hosts.entry(host_id.to_string()).or_default();
    runtime.runtime.insert(rule_id.to_string(), updated);
    Ok(())
}

fn clear_host_worker_if_current(host_id: &str) {
    if let Ok(mut guard) = port_forward_store().lock() {
        if let Some(runtime) = guard.hosts.get_mut(host_id) {
            runtime.worker = None;
        }
    }
}

fn update_rule_active_connections(host_id: &str, rule_id: &str, active_connections: u32) {
    if let Ok(mut guard) = port_forward_store().lock() {
        if let Some(rule_runtime) = guard
            .hosts
            .get_mut(host_id)
            .and_then(|runtime| runtime.runtime.get_mut(rule_id))
        {
            rule_runtime.active_connections = active_connections;
        }
    }
}

fn increment_rule_active_connections(host_id: &str, rule_id: &str) {
    if let Ok(mut guard) = port_forward_store().lock() {
        if let Some(rule_runtime) = guard
            .hosts
            .get_mut(host_id)
            .and_then(|runtime| runtime.runtime.get_mut(rule_id))
        {
            rule_runtime.active_connections = rule_runtime.active_connections.saturating_add(1);
        }
    }
}

fn decrement_rule_active_connections(host_id: &str, rule_id: &str) {
    if let Ok(mut guard) = port_forward_store().lock() {
        if let Some(rule_runtime) = guard
            .hosts
            .get_mut(host_id)
            .and_then(|runtime| runtime.runtime.get_mut(rule_id))
        {
            rule_runtime.active_connections = rule_runtime.active_connections.saturating_sub(1);
        }
    }
}

impl ActiveConnectionCounter {
    fn open(host_id: String, rule_id: String) -> Self {
        increment_rule_active_connections(&host_id, &rule_id);
        push_rule_runtime_event(
            &host_id,
            &rule_id,
            PortForwardEventLevel::Debug,
            "connection opened".to_string(),
        );
        Self { host_id, rule_id }
    }
}

impl Drop for ActiveConnectionCounter {
    fn drop(&mut self) {
        decrement_rule_active_connections(&self.host_id, &self.rule_id);
        push_rule_runtime_event(
            &self.host_id,
            &self.rule_id,
            PortForwardEventLevel::Debug,
            "connection closed".to_string(),
        );
    }
}

fn push_rule_runtime_event(
    host_id: &str,
    rule_id: &str,
    level: PortForwardEventLevel,
    message: String,
) {
    if let Ok(mut guard) = port_forward_store().lock() {
        guard.sequence = guard.sequence.saturating_add(1);
        let sequence = guard.sequence;
        if let Some(rule_runtime) = guard
            .hosts
            .get_mut(host_id)
            .and_then(|runtime| runtime.runtime.get_mut(rule_id))
        {
            push_event(rule_runtime, sequence, level, message);
        }
    }
}

fn rule_should_reconnect(host_id: &str, rule_id: &str) -> bool {
    port_forward_store()
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .hosts
                .get(host_id)
                .and_then(|runtime| runtime.runtime.get(rule_id))
                .map(|rule_runtime| rule_runtime.intended_running)
        })
        .unwrap_or(false)
}

fn is_port_in_use_error(error: &crate::error::ConfigError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("address already in use")
        || message.contains("addrinuse")
        || message.contains("only one usage of each socket address")
        || message.contains("os error 98")
        || message.contains("os error 48")
        || message.contains("os error 10048")
}

fn spawn_local_forward_listener(
    host_id: String,
    rule: PortForwardRule,
    session: Session,
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    connection_guards: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        push_rule_runtime_event(
            &host_id,
            &rule.id,
            PortForwardEventLevel::Info,
            format!(
                "listening locally on {}:{}",
                rule.local_address, rule.local_port
            ),
        );
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((local, _peer)) => {
                    let session = session.clone();
                    let host_id = host_id.clone();
                    let rule = rule.clone();
                    let connection_stop = Arc::clone(&stop);
                    let guard = thread::spawn(move || {
                        let _connection =
                            ActiveConnectionCounter::open(host_id.clone(), rule.id.clone());
                        match session.channel_direct_tcpip(
                            ssh_network_hostname(&rule.remote_address),
                            rule.remote_port,
                            None,
                        ) {
                            Ok(channel) => {
                                bridge_proxy_channel_until_stopped(local, channel, connection_stop)
                            }
                            Err(error) => {
                                push_rule_runtime_event(
                                    &host_id,
                                    &rule.id,
                                    PortForwardEventLevel::Warn,
                                    format!("SSH direct TCP channel failed: {error}"),
                                );
                                let _ = local.shutdown(Shutdown::Both);
                            }
                        }
                    });
                    if let Ok(mut guards) = connection_guards.lock() {
                        guards.push(guard);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => {
                    if !stop.load(Ordering::SeqCst) {
                        let _ = set_rule_status(
                            &host_id,
                            &rule.id,
                            PortForwardRuleStatus::Failed,
                            Some(format!("local listener failed: {error}")),
                        );
                    }
                    break;
                }
            }
        }
    })
}

fn spawn_remote_forward_listener(
    host_id: String,
    rule: PortForwardRule,
    mut listener: ssh2::Listener,
    stop: Arc<AtomicBool>,
    connection_guards: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        push_rule_runtime_event(
            &host_id,
            &rule.id,
            PortForwardEventLevel::Info,
            format!(
                "listening remotely on {}:{}",
                rule.remote_address, rule.remote_port
            ),
        );
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok(channel) => {
                    let host_id = host_id.clone();
                    let rule = rule.clone();
                    let connection_stop = Arc::clone(&stop);
                    let guard = thread::spawn(move || {
                        let _connection =
                            ActiveConnectionCounter::open(host_id.clone(), rule.id.clone());
                        match TcpStream::connect((rule.local_address.as_str(), rule.local_port)) {
                            Ok(local) => {
                                bridge_proxy_channel_until_stopped(local, channel, connection_stop)
                            }
                            Err(error) => {
                                push_rule_runtime_event(
                                    &host_id,
                                    &rule.id,
                                    PortForwardEventLevel::Warn,
                                    format!("local target connection failed: {error}"),
                                );
                            }
                        }
                    });
                    if let Ok(mut guards) = connection_guards.lock() {
                        guards.push(guard);
                    }
                }
                Err(error) => {
                    let io_error: std::io::Error = error.into();
                    if io_error.kind() == std::io::ErrorKind::WouldBlock {
                        thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                    if !stop.load(Ordering::SeqCst) {
                        let _ = set_rule_status(
                            &host_id,
                            &rule.id,
                            PortForwardRuleStatus::Failed,
                            Some(format!("remote listener failed: {io_error}")),
                        );
                    }
                    break;
                }
            }
        }
    })
}

fn apply_assigned_listen_port(
    rule: &mut PortForwardRule,
    runtime: &mut PortForwardRuntimeRule,
    assigned_port: u16,
) {
    match rule.direction {
        PortForwardDirection::LocalToRemote => {
            if runtime.effective_local_port.is_none() {
                runtime.effective_local_port = Some(assigned_port);
            }
            if rule.local_port == 0 {
                rule.local_port = assigned_port;
            }
        }
        PortForwardDirection::RemoteToLocal => {
            if runtime.effective_remote_port.is_none() {
                runtime.effective_remote_port = Some(assigned_port);
            }
            if rule.remote_port == 0 {
                rule.remote_port = assigned_port;
            }
        }
    }
}

fn mark_dynamic_port_writeback_result(
    runtime: &mut PortForwardRuntimeRule,
    writeback: Result<()>,
) -> Result<()> {
    match writeback {
        Ok(()) => {
            runtime.warning = None;
            Ok(())
        }
        Err(error) => {
            runtime.status = PortForwardRuleStatus::Running;
            runtime.warning = Some("port was assigned but could not be saved".to_string());
            runtime.error = None;
            Err(error)
        }
    }
}

fn upsert_rule(rules: &mut Vec<PortForwardRule>, rule: PortForwardRule) {
    if let Some(existing) = rules.iter_mut().find(|existing| existing.id == rule.id) {
        *existing = rule;
    } else {
        rules.push(rule);
    }
}

fn rules_have_same_id(rule: &PortForwardRule, id: &str) -> bool {
    rule.id == id
}

fn clear_matching_draft_after_save(
    host_id: &str,
    saved_rule: &PortForwardRule,
    saved_persistence: PortForwardPersistence,
) -> Result<()> {
    let store = port_forward_store();
    let mut guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    let Some(runtime) = guard.hosts.get_mut(host_id) else {
        return Ok(());
    };
    if runtime
        .draft
        .as_ref()
        .is_some_and(|draft| draft_matches_saved_rule(draft, saved_rule, saved_persistence))
    {
        runtime.draft = None;
    }
    Ok(())
}

fn draft_matches_saved_rule(
    draft: &PortForwardDraft,
    rule: &PortForwardRule,
    persistence: PortForwardPersistence,
) -> bool {
    draft.name == rule.name
        && draft.direction == rule.direction
        && draft.local_address == rule.local_address
        && draft.local_port == rule.local_port.to_string()
        && draft.remote_address == rule.remote_address
        && draft.remote_port == rule.remote_port.to_string()
        && draft.persistence == persistence
        && draft.connect_on_host_open == rule.connect_on_host_open
}

fn reject_duplicate_runtime_rule(
    host_id: &str,
    saved_rules: &[PortForwardRule],
    candidate: &PortForwardRule,
) -> Result<()> {
    for rule in saved_rules {
        if rule.id != candidate.id && semantic_key(rule) == semantic_key(candidate) {
            return Err(duplicate_semantics_error(candidate));
        }
    }
    let store = port_forward_store();
    let guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    let Some(runtime) = guard.hosts.get(host_id) else {
        return Ok(());
    };
    for rule in &runtime.temporary_rules {
        if rule.id != candidate.id && semantic_key(rule) == semantic_key(candidate) {
            return Err(duplicate_semantics_error(candidate));
        }
    }
    Ok(())
}

fn port_forward_rule_by_id(
    host_id: &str,
    saved_rules: &[PortForwardRule],
    rule_id: &str,
) -> Result<Option<PortForwardRule>> {
    if let Some(rule) = saved_rules.iter().find(|rule| rule.id == rule_id) {
        return Ok(Some(rule.clone()));
    }
    let store = port_forward_store();
    let guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    Ok(guard
        .hosts
        .get(host_id)
        .and_then(|runtime| {
            runtime
                .temporary_rules
                .iter()
                .find(|rule| rule.id == rule_id)
        })
        .cloned())
}

fn reject_unconfirmed_non_loopback(rule: &PortForwardRule) -> Result<()> {
    let risk = non_loopback_risk_for_rule(rule);
    if risk.requires_confirmation {
        return Err(invalid_error(format!(
            "non-loopback listen address {} requires confirmation before saving or starting",
            risk.listen_address
        )));
    }
    Ok(())
}

fn duplicate_semantics_error(rule: &PortForwardRule) -> crate::error::ConfigError {
    invalid_error(format!(
        "duplicate port forward rule connection semantics for {}:{} and {}:{}",
        rule.local_address, rule.local_port, rule.remote_address, rule.remote_port
    ))
}

fn semantic_key(rule: &PortForwardRule) -> (PortForwardDirection, String, u16, String, u16) {
    (
        rule.direction,
        rule.local_address.trim().to_string(),
        rule.local_port,
        rule.remote_address.trim().to_string(),
        rule.remote_port,
    )
}

fn non_loopback_risk_for_rule(rule: &PortForwardRule) -> PortForwardNonLoopbackRisk {
    let (listen_address, listen_port) = match rule.direction {
        PortForwardDirection::LocalToRemote => (&rule.local_address, rule.local_port),
        PortForwardDirection::RemoteToLocal => (&rule.remote_address, rule.remote_port),
    };
    let mut reasons = non_loopback_risk_reasons(listen_address, listen_port);
    reasons.sort();
    reasons.dedup();
    let confirmed = rule.non_loopback_confirmations.iter().any(|confirmation| {
        confirmation.semantic_key.direction == rule.direction
            && confirmation.semantic_key.local_address == rule.local_address
            && confirmation.semantic_key.local_port == rule.local_port
            && confirmation.semantic_key.remote_address == rule.remote_address
            && confirmation.semantic_key.remote_port == rule.remote_port
    });
    PortForwardNonLoopbackRisk {
        requires_confirmation: !confirmed && !reasons.is_empty(),
        listen_address: listen_address.trim().to_string(),
        reasons,
    }
}

fn non_loopback_risk_reasons(address: &str, port: u16) -> Vec<String> {
    let trimmed = address.trim();
    let mut reasons = Vec::new();
    if trimmed.eq_ignore_ascii_case("localhost") {
        return reasons;
    }
    match trimmed.parse::<IpAddr>() {
        Ok(ip) if ip.is_loopback() => return reasons,
        Ok(ip) if ip.is_unspecified() => {
            reasons.push("listen address binds every interface".to_string());
        }
        Ok(_) => {
            reasons.push("listen address is not loopback".to_string());
        }
        Err(_) => {
            reasons
                .push("listen address is a hostname and may resolve outside loopback".to_string());
        }
    }
    if let Ok(mut addrs) = (trimmed, port).to_socket_addrs() {
        if addrs.any(|addr| !addr.ip().is_loopback()) {
            reasons.push("resolved listen address includes a non-loopback interface".to_string());
        }
    }
    reasons
}

fn set_rule_status(
    host_id: &str,
    rule_id: &str,
    status: PortForwardRuleStatus,
    error: Option<String>,
) -> Result<()> {
    set_rule_status_with_persistence(host_id, rule_id, status, error, None)
}

fn set_rule_status_with_persistence(
    host_id: &str,
    rule_id: &str,
    status: PortForwardRuleStatus,
    error: Option<String>,
    persistence: Option<PortForwardPersistence>,
) -> Result<()> {
    let store = port_forward_store();
    let mut guard = store
        .lock()
        .map_err(|_| invalid_error("port forwarding store lock poisoned"))?;
    guard.sequence = guard.sequence.saturating_add(1);
    let sequence = guard.sequence;
    let runtime = guard.hosts.entry(host_id.to_string()).or_default();
    let rule_runtime = runtime
        .runtime
        .entry(rule_id.to_string())
        .or_insert_with(|| {
            stopped_runtime_rule(rule_id.to_string(), PortForwardPersistence::JustThisTime)
        });
    if let Some(persistence) = persistence {
        rule_runtime.persistence = persistence;
    }
    rule_runtime.status = status;
    rule_runtime.intended_running = matches!(
        status,
        PortForwardRuleStatus::Starting
            | PortForwardRuleStatus::Running
            | PortForwardRuleStatus::Reconnecting
    );
    rule_runtime.error = error.clone();
    push_event(
        rule_runtime,
        sequence,
        if error.is_some() {
            PortForwardEventLevel::Error
        } else {
            PortForwardEventLevel::Info
        },
        match status {
            PortForwardRuleStatus::Failed => "start failed".to_string(),
            PortForwardRuleStatus::Stopped => "stopped".to_string(),
            PortForwardRuleStatus::Starting => "starting".to_string(),
            PortForwardRuleStatus::Running => "running".to_string(),
            PortForwardRuleStatus::Reconnecting => "reconnecting".to_string(),
            PortForwardRuleStatus::NeedsConfirmation => "needs confirmation".to_string(),
        },
    );
    Ok(())
}

fn push_event(
    runtime: &mut PortForwardRuntimeRule,
    sequence: u64,
    level: PortForwardEventLevel,
    message: String,
) {
    runtime.events.push(PortForwardEvent {
        sequence: sequence.to_string(),
        occurred_at_unix_ms: sequence.to_string(),
        level,
        message,
    });
    if runtime.events.len() > PORT_FORWARD_EVENT_LIMIT {
        let remove_count = runtime.events.len() - PORT_FORWARD_EVENT_LIMIT;
        runtime.events.drain(0..remove_count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        terminal::connect_authenticated_ssh_session,
        types::{SshAuthTargetKind, SshConnectionConfig},
        workspace_ssh::{
            connection_host_auth_target, workspace_ssh_coordinator, WorkspaceCredentialKey,
        },
    };
    use std::{
        io::{Read, Write},
        time::{Instant, SystemTime, UNIX_EPOCH},
    };
    use tempfile::{tempdir, TempDir};

    #[test]
    fn runtime_event_log_is_bounded_to_latest_events() {
        let mut runtime = stopped_runtime_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236d95".to_string(),
            PortForwardPersistence::JustThisTime,
        );

        for sequence in 1..=75 {
            push_event(
                &mut runtime,
                sequence,
                PortForwardEventLevel::Info,
                format!("event {sequence}"),
            );
        }

        assert_eq!(runtime.events.len(), 50);
        assert_eq!(runtime.events[0].sequence, "26");
        assert_eq!(runtime.events[49].sequence, "75");
    }

    #[test]
    fn stopped_and_failed_rules_do_not_require_last_workspace_close_confirmation() {
        assert!(!requires_last_workspace_close_confirmation(&[
            PortForwardRuleStatus::Stopped,
            PortForwardRuleStatus::Failed,
        ]));
    }

    #[test]
    fn active_rules_require_last_workspace_close_confirmation() {
        assert!(requires_last_workspace_close_confirmation(&[
            PortForwardRuleStatus::Starting,
            PortForwardRuleStatus::Running,
            PortForwardRuleStatus::Reconnecting,
        ]));
    }

    #[test]
    fn reconnect_backoff_is_finite_and_only_for_intended_running_rules() {
        let mut backoff = ReconnectBackoff::default();

        assert_eq!(
            backoff.next_delay(true).map(|delay| delay.as_millis()),
            Some(1_000)
        );
        assert_eq!(
            backoff.next_delay(true).map(|delay| delay.as_millis()),
            Some(2_000)
        );
        assert_eq!(
            backoff.next_delay(true).map(|delay| delay.as_millis()),
            Some(5_000)
        );
        assert_eq!(
            backoff.next_delay(true).map(|delay| delay.as_millis()),
            Some(10_000)
        );
        assert_eq!(
            backoff.next_delay(true).map(|delay| delay.as_millis()),
            Some(30_000)
        );
        assert_eq!(
            backoff.next_delay(true).map(|delay| delay.as_millis()),
            Some(30_000)
        );

        assert_eq!(backoff.next_delay(false), None);
        assert_eq!(
            backoff.next_delay(true).map(|delay| delay.as_millis()),
            Some(1_000)
        );
    }

    #[test]
    fn reconnect_classifies_port_in_use_as_terminal_rule_failure() {
        for message in [
            "Address already in use (os error 98)",
            "Address already in use (os error 48)",
            "Only one usage of each socket address is normally permitted. (os error 10048)",
        ] {
            assert!(
                is_port_in_use_error(&crate::error::terminal_error(message)),
                "expected port-in-use detection for {message}"
            );
        }
        assert!(!is_port_in_use_error(&crate::error::terminal_error(
            "connection refused"
        )));
    }

    #[test]
    fn closing_host_runtime_removes_active_close_protection_state() {
        let host_id = "host-close-runtime-test";
        let rule_id = "018f6eb3-6f91-7410-bc43-f927b2236d9f";
        set_rule_status(host_id, rule_id, PortForwardRuleStatus::Running, None)
            .expect("mark rule running");

        assert!(host_port_forward_close_requires_confirmation(host_id)
            .expect("close protection before runtime close"));

        close_host_port_forward_runtime(host_id).expect("close Host runtime");

        assert!(!host_port_forward_close_requires_confirmation(host_id)
            .expect("close protection after runtime close"));
    }

    #[test]
    fn upsert_rule_replaces_existing_rule_without_duplicate_ids() {
        let mut rules = vec![test_rule("018f6eb3-6f91-7410-bc43-f927b2236d95", 15432)];
        let mut updated = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d95", 15433);
        updated.name = "Updated".to_string();

        upsert_rule(&mut rules, updated);

        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].name, "Updated");
        assert_eq!(rules[0].local_port, 15433);
    }

    #[test]
    fn semantic_duplicate_detection_ignores_rule_name() {
        let first = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d95", 15432);
        let mut second = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d96", 15432);
        second.name = "Different Name".to_string();

        assert_eq!(semantic_key(&first), semantic_key(&second));
    }

    #[test]
    fn host_open_auto_start_decision_selects_only_saved_ssh_auto_rules() {
        let auto_rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d97", 15432);
        let mut manual_rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d98", 15433);
        manual_rule.connect_on_host_open = false;
        let rules = vec![auto_rule.clone(), manual_rule.clone()];

        let selected = host_open_auto_start_rule_ids(ConnectionProtocol::Ssh, &rules);
        let unsupported = host_open_auto_start_rule_ids(ConnectionProtocol::Local, &rules);

        assert_eq!(selected, vec![auto_rule.id]);
        assert!(unsupported.is_empty());
    }

    #[test]
    fn saved_new_rule_starts_immediately_instead_of_remaining_stopped() {
        let host_id = "host-new-rule-start";
        let rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236e21", 15432);

        assert!(
            should_start_rule_after_save(host_id, None, &rule).expect("new rule start decision")
        );
    }

    #[test]
    fn saved_non_semantic_rule_changes_do_not_restart() {
        let host_id = "host-non-semantic-change";
        let rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236e22", 15432);
        let mut renamed = rule.clone();
        renamed.name = "Renamed".to_string();
        set_runtime_rule_for_test(
            host_id,
            &rule.id,
            PortForwardRuntimeRule {
                status: PortForwardRuleStatus::Running,
                intended_running: true,
                ..stopped_runtime_rule(rule.id.clone(), PortForwardPersistence::JustThisTime)
            },
        );

        assert!(
            !should_start_rule_after_save(host_id, Some(&rule), &renamed)
                .expect("rename start decision")
        );
    }

    #[test]
    fn saved_semantic_rule_changes_restart_only_when_rule_should_run() {
        let host_id = "host-semantic-change";
        let rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236e23", 15432);
        let mut changed = rule.clone();
        changed.local_port = 15433;

        assert!(
            !should_start_rule_after_save(host_id, Some(&rule), &changed)
                .expect("stopped semantic change decision")
        );

        set_runtime_rule_for_test(
            host_id,
            &rule.id,
            PortForwardRuntimeRule {
                status: PortForwardRuleStatus::Running,
                intended_running: true,
                ..stopped_runtime_rule(rule.id.clone(), PortForwardPersistence::JustThisTime)
            },
        );

        assert!(should_start_rule_after_save(host_id, Some(&rule), &changed)
            .expect("running semantic change decision"));
    }

    #[test]
    fn non_loopback_risk_uses_input_string_and_resolution() {
        let mut loopback = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d99", 15432);
        assert!(!non_loopback_risk_for_rule(&loopback).requires_confirmation);

        loopback.local_address = "0.0.0.0".to_string();
        let wildcard = non_loopback_risk_for_rule(&loopback);
        assert!(wildcard.requires_confirmation);
        assert!(wildcard
            .reasons
            .iter()
            .any(|reason| reason.contains("every interface")));

        loopback.local_address = "db.internal".to_string();
        let hostname = non_loopback_risk_for_rule(&loopback);
        assert!(hostname.requires_confirmation);
        assert!(hostname
            .reasons
            .iter()
            .any(|reason| reason.contains("hostname")));
    }

    #[test]
    fn non_loopback_confirmation_is_bound_to_connection_semantics() {
        let mut rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d9a", 15432);
        rule.local_address = "0.0.0.0".to_string();
        rule.non_loopback_confirmations
            .push(crate::types::PortForwardNonLoopbackConfirmation {
                semantic_key: crate::types::PortForwardSemanticKey {
                    direction: rule.direction,
                    local_address: rule.local_address.clone(),
                    local_port: rule.local_port,
                    remote_address: rule.remote_address.clone(),
                    remote_port: rule.remote_port,
                },
                confirmed_at_unix_ms: "1781881401000".to_string(),
            });

        assert!(!non_loopback_risk_for_rule(&rule).requires_confirmation);
        rule.remote_port = 5433;
        assert!(non_loopback_risk_for_rule(&rule).requires_confirmation);
    }

    #[test]
    fn unconfirmed_non_loopback_rule_is_rejected_before_save_or_start() {
        let mut rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d9b", 15432);
        rule.local_address = "0.0.0.0".to_string();

        let error = reject_unconfirmed_non_loopback(&rule)
            .expect_err("unconfirmed non-loopback should fail");
        assert!(format!("{error}").contains("requires confirmation"));

        rule.non_loopback_confirmations
            .push(crate::types::PortForwardNonLoopbackConfirmation {
                semantic_key: crate::types::PortForwardSemanticKey {
                    direction: rule.direction,
                    local_address: rule.local_address.clone(),
                    local_port: rule.local_port,
                    remote_address: rule.remote_address.clone(),
                    remote_port: rule.remote_port,
                },
                confirmed_at_unix_ms: "1781881401000".to_string(),
            });
        reject_unconfirmed_non_loopback(&rule).expect("matching confirmation should pass");
    }

    #[test]
    fn host_level_temporary_credentials_are_encrypted_and_host_scoped() {
        let auth_target = test_auth_target();
        let mut scope = HostPortForwardCredentialScope::default();
        let credential = SshCredentialInput {
            kind: SshCredentialKind::Password,
            value: "host-port-secret".to_string(),
        };

        scope
            .store_prompt_credential_after_success(
                "host-a",
                &auth_target,
                SshCredentialKind::Password,
                None,
                &credential,
            )
            .expect("store Host-scoped credential");

        assert_eq!(
            scope
                .read_temporary_credential(
                    "host-a",
                    &auth_target,
                    SshCredentialKind::Password,
                    None,
                )
                .expect("read credential")
                .as_deref()
                .map(String::as_str),
            Some("host-port-secret")
        );
        assert_eq!(
            scope
                .read_temporary_credential(
                    "host-b",
                    &auth_target,
                    SshCredentialKind::Password,
                    None,
                )
                .expect("read other host")
                .as_deref()
                .map(String::as_str),
            None
        );
        assert_ne!(
            scope
                .raw_ciphertext_for_test("host-a", &auth_target, SshCredentialKind::Password, None)
                .expect("ciphertext"),
            b"host-port-secret"
        );

        scope.remove_temporary_credential(
            "host-a",
            &auth_target,
            SshCredentialKind::Password,
            None,
        );
        assert_eq!(
            scope
                .read_temporary_credential(
                    "host-a",
                    &auth_target,
                    SshCredentialKind::Password,
                    None,
                )
                .expect("read removed credential")
                .as_deref()
                .map(String::as_str),
            None
        );
    }

    #[test]
    fn clearing_host_runtime_destroys_host_temporary_credential_scope() {
        let auth_target = test_auth_target();
        let mut runtime = HostPortForwardRuntime::default();
        runtime
            .credential_scope
            .store_prompt_credential_after_success(
                "host-a",
                &auth_target,
                SshCredentialKind::Password,
                None,
                &SshCredentialInput {
                    kind: SshCredentialKind::Password,
                    value: "host-port-secret".to_string(),
                },
            )
            .expect("store credential");
        runtime.runtime.insert(
            "018f6eb3-6f91-7410-bc43-f927b2236d9c".to_string(),
            PortForwardRuntimeRule {
                status: PortForwardRuleStatus::Running,
                intended_running: true,
                active_connections: 2,
                ..stopped_runtime_rule(
                    "018f6eb3-6f91-7410-bc43-f927b2236d9c".to_string(),
                    PortForwardPersistence::JustThisTime,
                )
            },
        );

        runtime.stop_all_rules();

        let stopped = runtime
            .runtime
            .get("018f6eb3-6f91-7410-bc43-f927b2236d9c")
            .expect("runtime rule");
        assert_eq!(stopped.status, PortForwardRuleStatus::Stopped);
        assert!(!stopped.intended_running);
        assert_eq!(stopped.active_connections, 0);
        assert_eq!(
            runtime
                .credential_scope
                .read_temporary_credential(
                    "host-a",
                    &auth_target,
                    SshCredentialKind::Password,
                    None,
                )
                .expect("read after clear")
                .as_deref()
                .map(String::as_str),
            None
        );
    }

    #[test]
    fn active_connection_counter_decrements_when_connection_scope_exits() {
        let host_id = "host-active-connection-counter";
        let rule_id = "018f6eb3-6f91-7410-bc43-f927b2236e20";
        {
            let store = port_forward_store();
            let mut guard = store.lock().expect("store lock");
            let host = guard.hosts.entry(host_id.to_string()).or_default();
            host.runtime.insert(
                rule_id.to_string(),
                PortForwardRuntimeRule {
                    status: PortForwardRuleStatus::Running,
                    intended_running: true,
                    ..stopped_runtime_rule(
                        rule_id.to_string(),
                        PortForwardPersistence::JustThisTime,
                    )
                },
            );
        }

        {
            let _connection =
                ActiveConnectionCounter::open(host_id.to_string(), rule_id.to_string());
            assert_eq!(
                runtime_rule(host_id, rule_id)
                    .expect("runtime after connection open")
                    .active_connections,
                1
            );
        }

        let runtime = runtime_rule(host_id, rule_id).expect("runtime after connection close");
        assert_eq!(runtime.active_connections, 0);
        assert!(runtime
            .events
            .iter()
            .any(|event| event.message == "connection closed"));
    }

    #[test]
    fn assigned_dynamic_local_port_is_retained_for_reconnects_and_saved_rule_writeback() {
        let mut rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d9d", 0);
        let mut runtime = stopped_runtime_rule(rule.id.clone(), PortForwardPersistence::Saved);

        apply_assigned_listen_port(&mut rule, &mut runtime, 43123);
        apply_assigned_listen_port(&mut rule, &mut runtime, 49999);
        mark_dynamic_port_writeback_result(&mut runtime, Ok(())).expect("writeback success");

        assert_eq!(rule.local_port, 43123);
        assert_eq!(runtime.effective_local_port, Some(43123));
        assert_eq!(runtime.warning, None);
    }

    #[test]
    fn assigned_dynamic_remote_port_writeback_failure_keeps_running_with_warning() {
        let mut rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d9e", 15432);
        rule.direction = PortForwardDirection::RemoteToLocal;
        rule.remote_port = 0;
        let mut runtime = stopped_runtime_rule(rule.id.clone(), PortForwardPersistence::Saved);
        runtime.status = PortForwardRuleStatus::Running;

        apply_assigned_listen_port(&mut rule, &mut runtime, 41001);
        let error = mark_dynamic_port_writeback_result(
            &mut runtime,
            Err(invalid_error("simulated Host TOML write failure")),
        )
        .expect_err("writeback failure should be surfaced");

        assert_eq!(rule.remote_port, 41001);
        assert_eq!(runtime.effective_remote_port, Some(41001));
        assert_eq!(runtime.status, PortForwardRuleStatus::Running);
        assert!(runtime
            .warning
            .as_ref()
            .is_some_and(|warning| warning.contains("could not be saved")));
        assert!(format!("{error}").contains("simulated Host TOML write failure"));
    }

    #[test]
    fn dynamic_port_writeback_failure_is_not_a_start_failure() {
        let mut rule = test_rule("018f6eb3-6f91-7410-bc43-f927b2236d90", 0);
        let mut runtime = stopped_runtime_rule(rule.id.clone(), PortForwardPersistence::Saved);
        runtime.status = PortForwardRuleStatus::Running;

        apply_assigned_listen_port(&mut rule, &mut runtime, 45123);
        let _ = mark_dynamic_port_writeback_result(
            &mut runtime,
            Err(invalid_error("simulated writeback failure")),
        );

        assert_eq!(runtime.status, PortForwardRuleStatus::Running);
        assert_eq!(runtime.error, None);
        assert!(runtime
            .warning
            .as_ref()
            .is_some_and(|warning| warning.contains("could not be saved")));
    }

    #[test]
    #[ignore = "requires SSH target; defaults to 127.0.0.1:22 or set NOCTURNE_PORT_FORWARD_TEST_SSH_* env vars"]
    fn port_forward_local_to_remote_reaches_ssh_target_echo_service() {
        let fixture = PortForwardSshFixture::start();
        let remote_echo = LocalEchoServer::start_with_prefix(b"echo:");
        let mut worker = fixture.worker("host-port-forward-local");
        let rule = fixture.local_to_remote_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236e01",
            0,
            &fixture.local_target_address(),
            remote_echo.port,
        );

        worker
            .start_rule(rule.clone(), PortForwardPersistence::JustThisTime)
            .expect("start local forward");
        let runtime =
            wait_for_rule_status(fixture.host_id(), &rule.id, PortForwardRuleStatus::Running);
        let local_port = runtime.effective_local_port.expect("assigned local port");

        let response = tcp_round_trip("127.0.0.1", local_port, b"local-forward\n");
        assert_eq!(response, b"echo:local-forward\n");
        assert_eq!(
            wait_for_active_connections(fixture.host_id(), &rule.id, 0),
            0
        );

        worker.stop_rule(&rule.id);
    }

    #[test]
    #[ignore = "requires SSH target; defaults to 127.0.0.1:22 or set NOCTURNE_PORT_FORWARD_TEST_SSH_* env vars"]
    fn port_forward_remote_to_local_reaches_local_echo_service_through_ssh_target() {
        let fixture = PortForwardSshFixture::start();
        let local_echo = LocalEchoServer::start_with_prefix(b"local:");
        let mut worker = fixture.worker("host-port-forward-remote");
        let rule = fixture.remote_to_local_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236e02",
            0,
            "127.0.0.1",
            local_echo.port,
        );

        worker
            .start_rule(rule.clone(), PortForwardPersistence::JustThisTime)
            .expect("start remote forward");
        let runtime =
            wait_for_rule_status(fixture.host_id(), &rule.id, PortForwardRuleStatus::Running);
        let remote_port = runtime.effective_remote_port.expect("assigned remote port");

        let response = fixture.remote_tcp_round_trip(remote_port, b"remote-forward\n");
        assert_eq!(response, b"local:remote-forward\n");

        worker.stop_rule(&rule.id);
    }

    #[test]
    #[ignore = "requires SSH target; defaults to 127.0.0.1:22 or set NOCTURNE_PORT_FORWARD_TEST_SSH_* env vars"]
    fn port_forward_remote_dynamic_port_remains_stable_for_runtime_restart() {
        let fixture = PortForwardSshFixture::start();
        let local_echo = LocalEchoServer::start_with_prefix(b"local:");
        let mut worker = fixture.worker("host-port-forward-dynamic-remote");
        let mut rule = fixture.remote_to_local_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236e03",
            0,
            "127.0.0.1",
            local_echo.port,
        );

        worker
            .start_rule(rule.clone(), PortForwardPersistence::JustThisTime)
            .expect("start remote dynamic forward");
        let runtime =
            wait_for_rule_status(fixture.host_id(), &rule.id, PortForwardRuleStatus::Running);
        let assigned = runtime.effective_remote_port.expect("assigned remote port");
        rule.remote_port = assigned;

        worker
            .start_rule(rule.clone(), PortForwardPersistence::JustThisTime)
            .expect("restart with assigned remote port");
        let restarted =
            wait_for_rule_status(fixture.host_id(), &rule.id, PortForwardRuleStatus::Running);
        assert_eq!(restarted.effective_remote_port, Some(assigned));
        assert_eq!(
            fixture.remote_tcp_round_trip(assigned, b"stable-remote\n"),
            b"local:stable-remote\n"
        );

        worker.stop_rule(&rule.id);
    }

    #[test]
    #[ignore = "requires SSH target; defaults to 127.0.0.1:22 or set NOCTURNE_PORT_FORWARD_TEST_SSH_* env vars"]
    fn port_forward_shared_session_carries_multiple_rules() {
        let fixture = PortForwardSshFixture::start();
        let remote_echo = LocalEchoServer::start_with_prefix(b"echo:");
        let mut worker = fixture.worker("host-port-forward-multiplex");
        let first = fixture.local_to_remote_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236e04",
            0,
            &fixture.local_target_address(),
            remote_echo.port,
        );
        let second = fixture.local_to_remote_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236e05",
            0,
            &fixture.local_target_address(),
            remote_echo.port,
        );

        worker
            .start_rule(first.clone(), PortForwardPersistence::JustThisTime)
            .expect("start first rule");
        let first_runtime =
            wait_for_rule_status(fixture.host_id(), &first.id, PortForwardRuleStatus::Running);
        assert!(
            worker.session.is_some(),
            "first rule should establish one shared SSH session"
        );
        worker
            .start_rule(second.clone(), PortForwardPersistence::JustThisTime)
            .expect("start second rule");
        let second_runtime = wait_for_rule_status(
            fixture.host_id(),
            &second.id,
            PortForwardRuleStatus::Running,
        );

        assert_eq!(worker.active_rules.len(), 2);
        assert!(
            worker.session.is_some(),
            "second rule should reuse the worker's shared SSH session"
        );
        assert_eq!(
            tcp_round_trip(
                "127.0.0.1",
                first_runtime
                    .effective_local_port
                    .expect("first local port"),
                b"first\n",
            ),
            b"echo:first\n"
        );
        assert_eq!(
            tcp_round_trip(
                "127.0.0.1",
                second_runtime
                    .effective_local_port
                    .expect("second local port"),
                b"second\n",
            ),
            b"echo:second\n"
        );

        worker.stop_rule(&first.id);
        worker.stop_rule(&second.id);
    }

    #[test]
    #[ignore = "requires SSH target; defaults to 127.0.0.1:22 or set NOCTURNE_PORT_FORWARD_TEST_SSH_* env vars"]
    fn port_forward_one_rule_bind_failure_does_not_stop_running_rule() {
        let fixture = PortForwardSshFixture::start();
        let remote_echo = LocalEchoServer::start_with_prefix(b"echo:");
        let occupied_listener = TcpListener::bind(("127.0.0.1", 0)).expect("occupy local port");
        let occupied_port = occupied_listener
            .local_addr()
            .expect("occupied address")
            .port();
        let mut worker = fixture.worker("host-port-forward-isolation");
        let running = fixture.local_to_remote_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236e06",
            0,
            &fixture.local_target_address(),
            remote_echo.port,
        );
        let failing = fixture.local_to_remote_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236e07",
            occupied_port,
            &fixture.local_target_address(),
            remote_echo.port,
        );

        worker
            .start_rule(running.clone(), PortForwardPersistence::JustThisTime)
            .expect("start healthy rule");
        let running_runtime = wait_for_rule_status(
            fixture.host_id(),
            &running.id,
            PortForwardRuleStatus::Running,
        );
        let error = worker
            .start_rule(failing.clone(), PortForwardPersistence::JustThisTime)
            .expect_err("occupied port fails only the second rule");
        assert!(
            is_port_in_use_error(&error),
            "expected port-in-use error, got {error}"
        );
        set_rule_status_with_persistence(
            fixture.host_id(),
            &failing.id,
            PortForwardRuleStatus::Failed,
            Some(error.to_string()),
            Some(PortForwardPersistence::JustThisTime),
        )
        .expect("record failed rule for isolation assertion");

        assert_eq!(
            wait_for_rule_status(
                fixture.host_id(),
                &running.id,
                PortForwardRuleStatus::Running
            )
            .status,
            PortForwardRuleStatus::Running
        );
        assert_eq!(
            wait_for_rule_status(
                fixture.host_id(),
                &failing.id,
                PortForwardRuleStatus::Failed
            )
            .status,
            PortForwardRuleStatus::Failed
        );
        assert_eq!(
            tcp_round_trip(
                "127.0.0.1",
                running_runtime
                    .effective_local_port
                    .expect("running local port"),
                b"still-running\n",
            ),
            b"echo:still-running\n"
        );

        drop(occupied_listener);
        worker.stop_rule(&running.id);
    }

    fn test_rule(id: &str, local_port: u16) -> PortForwardRule {
        PortForwardRule {
            id: id.to_string(),
            name: "Postgres".to_string(),
            direction: PortForwardDirection::LocalToRemote,
            local_address: "127.0.0.1".to_string(),
            local_port,
            remote_address: "db.internal".to_string(),
            remote_port: 5432,
            connect_on_host_open: true,
            non_loopback_confirmations: Vec::new(),
        }
    }

    fn test_auth_target() -> SshAuthTarget {
        SshAuthTarget {
            id: "connection-host:host-a".to_string(),
            kind: SshAuthTargetKind::ConnectionHost,
            label: "Production".to_string(),
            username: "deploy".to_string(),
            hostname: "prod.example.com".to_string(),
            port: 22,
        }
    }

    struct PortForwardSshFixture {
        env: EnvPortForwardFixture,
    }

    impl PortForwardSshFixture {
        fn start() -> Self {
            Self {
                env: EnvPortForwardFixture::start(),
            }
        }

        fn worker(&self, workspace_id: &str) -> HostPortForwardWorker {
            self.env.worker(workspace_id)
        }

        fn local_to_remote_rule(
            &self,
            id: &str,
            local_port: u16,
            remote_address: &str,
            remote_port: u16,
        ) -> PortForwardRule {
            self.env
                .local_to_remote_rule(id, local_port, remote_address, remote_port)
        }

        fn remote_to_local_rule(
            &self,
            id: &str,
            remote_port: u16,
            local_address: &str,
            local_port: u16,
        ) -> PortForwardRule {
            self.env
                .remote_to_local_rule(id, remote_port, local_address, local_port)
        }

        fn remote_tcp_round_trip(&self, remote_port: u16, payload: &[u8]) -> Vec<u8> {
            self.env.remote_tcp_round_trip(remote_port, payload)
        }

        fn local_target_address(&self) -> String {
            self.env.local_target_address.clone()
        }

        fn host_id(&self) -> &str {
            &self.env.host_id
        }
    }

    struct EnvPortForwardFixture {
        root: TempDir,
        host_id: String,
        hostname: String,
        port: u16,
        username: String,
        password: Option<String>,
        identity_file: Option<String>,
        local_target_address: String,
    }

    impl EnvPortForwardFixture {
        fn start() -> Self {
            let root = tempdir().expect("temp dir");
            let suffix = format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system clock after unix epoch")
                    .as_millis()
            );
            let hostname = std::env::var("NOCTURNE_PORT_FORWARD_TEST_SSH_HOST")
                .unwrap_or_else(|_| "127.0.0.1".to_string());
            let port = std::env::var("NOCTURNE_PORT_FORWARD_TEST_SSH_PORT")
                .ok()
                .map(|value| {
                    value
                        .parse::<u16>()
                        .expect("NOCTURNE_PORT_FORWARD_TEST_SSH_PORT must be 0-65535")
                })
                .unwrap_or(22);
            let username = std::env::var("NOCTURNE_PORT_FORWARD_TEST_SSH_USER")
                .or_else(|_| std::env::var("USER"))
                .or_else(|_| std::env::var("USERNAME"))
                .expect("set NOCTURNE_PORT_FORWARD_TEST_SSH_USER for the SSH integration target");
            let password = std::env::var("NOCTURNE_PORT_FORWARD_TEST_SSH_PASSWORD").ok();
            let identity_file = std::env::var("NOCTURNE_PORT_FORWARD_TEST_SSH_IDENTITY_FILE").ok();
            let local_target_address = std::env::var("NOCTURNE_PORT_FORWARD_TEST_TARGET_ADDRESS")
                .unwrap_or_else(|_| "127.0.0.1".to_string());

            Self {
                root,
                host_id: format!("host-port-forward-env-{suffix}"),
                hostname,
                port,
                username,
                password,
                identity_file,
                local_target_address,
            }
        }

        fn worker(&self, workspace_id: &str) -> HostPortForwardWorker {
            let input = self.ssh_input(workspace_id);
            let session = connect_authenticated_ssh_session(&input)
                .unwrap_or_else(|error| {
                    panic!(
                        "connect SSH port-forward integration target failed: {error}\n\
                         Set NOCTURNE_PORT_FORWARD_TEST_SSH_HOST/PORT/USER and either \
                         NOCTURNE_PORT_FORWARD_TEST_SSH_PASSWORD or \
                         NOCTURNE_PORT_FORWARD_TEST_SSH_IDENTITY_FILE. Defaults target 127.0.0.1:22."
                    )
                })
                .session;
            session.set_blocking(false);
            let (_sender, receiver) = mpsc::channel();
            HostPortForwardWorker {
                app: None,
                host_id: self.host_id.clone(),
                input,
                receiver,
                session: Some(session),
                active_rules: HashMap::new(),
                reconnect_backoff: HashMap::new(),
            }
        }

        fn ssh_input(&self, workspace_id: &str) -> SshWorkerInput {
            let auth_target = connection_host_auth_target(
                &self.host_id,
                "Env Port Forward Host",
                &self.username,
                &self.hostname,
                self.port,
            );
            if let Some(password) = &self.password {
                workspace_ssh_coordinator()
                    .store_prompt_credential_after_success(
                        WorkspaceCredentialKey::new(
                            workspace_id,
                            &auth_target,
                            SshCredentialKind::Password,
                            None,
                        ),
                        &SshCredentialInput {
                            kind: SshCredentialKind::Password,
                            value: password.clone(),
                        },
                    )
                    .expect("store env SSH password");
            }
            SshWorkerInput {
                app: None,
                session_id: format!("{workspace_id}-session"),
                workspace_id: workspace_id.to_string(),
                source_tool_tab_id: None,
                display_name: "Env Port Forward Host".to_string(),
                auth_target,
                ssh: SshConnectionConfig {
                    hostname: self.hostname.clone(),
                    port: self.port,
                    username: Some(self.username.clone()),
                    identity_file: self.identity_file.clone(),
                    proxy_jump: None,
                    forward_agent: true,
                    server_alive_interval: None,
                },
                proxy_jump_chain: None,
                username: self.username.clone(),
                size: PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 800,
                    pixel_height: 600,
                },
                trust_path: self.root.path().join("known-hosts.toml"),
                accept_new_host_key: true,
                update_changed_host_key: false,
                credential: None,
                save_credential: false,
                verification_scope: crate::terminal::SshVerificationScope::Workspace,
            }
        }

        fn local_to_remote_rule(
            &self,
            id: &str,
            local_port: u16,
            remote_address: &str,
            remote_port: u16,
        ) -> PortForwardRule {
            PortForwardRule {
                id: id.to_string(),
                name: "Local To Remote".to_string(),
                direction: PortForwardDirection::LocalToRemote,
                local_address: "127.0.0.1".to_string(),
                local_port,
                remote_address: remote_address.to_string(),
                remote_port,
                connect_on_host_open: true,
                non_loopback_confirmations: Vec::new(),
            }
        }

        fn remote_to_local_rule(
            &self,
            id: &str,
            remote_port: u16,
            local_address: &str,
            local_port: u16,
        ) -> PortForwardRule {
            PortForwardRule {
                id: id.to_string(),
                name: "Remote To Local".to_string(),
                direction: PortForwardDirection::RemoteToLocal,
                local_address: local_address.to_string(),
                local_port,
                remote_address: "127.0.0.1".to_string(),
                remote_port,
                connect_on_host_open: true,
                non_loopback_confirmations: Vec::new(),
            }
        }

        fn remote_tcp_round_trip(&self, remote_port: u16, payload: &[u8]) -> Vec<u8> {
            let input = self.ssh_input("host-port-forward-env-probe");
            let session = connect_authenticated_ssh_session(&input)
                .expect("connect env SSH target for remote listener probe")
                .session;
            let mut channel = session
                .channel_session()
                .expect("open remote listener probe channel");
            channel
                .exec(&format!(
                    "sh -lc \"printf '{}' | nc -w 5 127.0.0.1 {}\"",
                    shell_single_quote_bytes(payload),
                    remote_port
                ))
                .expect("execute remote listener probe");
            let mut output = Vec::new();
            channel
                .read_to_end(&mut output)
                .expect("read remote listener probe output");
            channel
                .wait_close()
                .expect("wait remote listener probe close");
            output
        }
    }

    struct LocalEchoServer {
        port: u16,
        stop: Arc<AtomicBool>,
        guard: Option<thread::JoinHandle<()>>,
    }

    impl LocalEchoServer {
        fn start_with_prefix(prefix: &'static [u8]) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind local echo");
            listener
                .set_nonblocking(true)
                .expect("nonblocking echo listener");
            let port = listener.local_addr().expect("local echo address").port();
            let stop = Arc::new(AtomicBool::new(false));
            let stop_thread = Arc::clone(&stop);
            let guard = thread::spawn(move || {
                while !stop_thread.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _peer)) => {
                            let mut buffer = [0_u8; 4096];
                            match stream.read(&mut buffer) {
                                Ok(size) if size > 0 => {
                                    let mut response = prefix.to_vec();
                                    response.extend_from_slice(&buffer[..size]);
                                    let _ = stream.write_all(&response);
                                }
                                _ => {}
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                port,
                stop,
                guard: Some(guard),
            }
        }
    }

    impl Drop for LocalEchoServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(("127.0.0.1", self.port));
            if let Some(guard) = self.guard.take() {
                let _ = guard.join();
            }
        }
    }

    fn wait_for_rule_status(
        host_id: &str,
        rule_id: &str,
        status: PortForwardRuleStatus,
    ) -> PortForwardRuntimeRule {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            if let Some(runtime) = runtime_rule(host_id, rule_id) {
                if runtime.status == status {
                    return runtime;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!(
            "rule {rule_id} did not reach {status:?}; latest runtime: {:?}",
            runtime_rule(host_id, rule_id)
        );
    }

    fn wait_for_active_connections(host_id: &str, rule_id: &str, count: u32) -> u32 {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            let active = runtime_rule(host_id, rule_id)
                .map(|runtime| runtime.active_connections)
                .unwrap_or(0);
            if active == count {
                return active;
            }
            thread::sleep(Duration::from_millis(50));
        }
        runtime_rule(host_id, rule_id)
            .map(|runtime| runtime.active_connections)
            .unwrap_or(0)
    }

    fn runtime_rule(host_id: &str, rule_id: &str) -> Option<PortForwardRuntimeRule> {
        port_forward_store().lock().ok().and_then(|store| {
            store
                .hosts
                .get(host_id)
                .and_then(|host| host.runtime.get(rule_id))
                .cloned()
        })
    }

    fn tcp_round_trip(host: &str, port: u16, payload: &[u8]) -> Vec<u8> {
        let started = Instant::now();
        let mut last_error = None;
        while started.elapsed() < Duration::from_secs(10) {
            match TcpStream::connect((host, port)) {
                Ok(mut stream) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .expect("set read timeout");
                    stream.write_all(payload).expect("write payload");
                    let mut response = Vec::new();
                    stream.read_to_end(&mut response).expect("read response");
                    return response;
                }
                Err(error) => {
                    last_error = Some(error);
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
        panic!("tcp round trip to {host}:{port} failed: {last_error:?}");
    }

    fn shell_single_quote_bytes(bytes: &[u8]) -> String {
        let text = String::from_utf8(bytes.to_vec()).expect("test payload is utf8");
        text.replace('\\', "\\\\")
            .replace('\'', "'\\''")
            .replace('\n', "\\n")
    }
}

#[cfg(test)]
fn requires_last_workspace_close_confirmation(statuses: &[PortForwardRuleStatus]) -> bool {
    statuses.iter().any(|status| {
        matches!(
            status,
            PortForwardRuleStatus::Starting
                | PortForwardRuleStatus::Running
                | PortForwardRuleStatus::Reconnecting
        )
    })
}
