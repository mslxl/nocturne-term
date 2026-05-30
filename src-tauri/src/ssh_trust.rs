use std::{collections::BTreeSet, fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::error::{io_error, parse_error, Result};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SshTrustStore {
    pub version: u32,
    #[serde(default)]
    pub ssh: Vec<SshTrustEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshTrustEntry {
    pub target: String,
    pub keys: Vec<String>,
}

impl SshTrustStore {
    pub(crate) fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self {
                version: 1,
                ssh: Vec::new(),
            });
        }
        let text = fs::read_to_string(path).map_err(io_error)?;
        if text.trim().is_empty() {
            return Ok(Self {
                version: 1,
                ssh: Vec::new(),
            });
        }
        toml::from_str(&text).map_err(parse_error)
    }

    pub(crate) fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let text = toml::to_string_pretty(self).map_err(parse_error)?;
        fs::write(path, text).map_err(io_error)
    }

    pub(crate) fn contains_key(&self, target: &str, key: &str) -> bool {
        self.ssh
            .iter()
            .find(|entry| entry.target == target)
            .map(|entry| entry.keys.iter().any(|item| item == key))
            .unwrap_or(false)
    }

    pub(crate) fn has_target_algorithm(&self, target: &str, algorithm: &str) -> bool {
        self.ssh
            .iter()
            .find(|entry| entry.target == target)
            .map(|entry| {
                entry.keys.iter().any(|key| {
                    key.split_once(' ')
                        .map(|(kind, _)| kind == algorithm)
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    pub(crate) fn upsert_key(&mut self, target: String, key: String) {
        if let Some(entry) = self.ssh.iter_mut().find(|entry| entry.target == target) {
            if !entry.keys.iter().any(|item| item == &key) {
                entry.keys.push(key);
                entry.keys.sort();
            }
            return;
        }
        self.ssh.push(SshTrustEntry {
            target,
            keys: vec![key],
        });
        self.ssh.sort_by(|a, b| a.target.cmp(&b.target));
    }

    pub(crate) fn normalize(&mut self) {
        for entry in &mut self.ssh {
            let mut keys = BTreeSet::new();
            for key in entry.keys.drain(..) {
                keys.insert(key);
            }
            entry.keys = keys.into_iter().collect();
        }
        self.ssh.sort_by(|a, b| a.target.cmp(&b.target));
    }
}

pub(crate) fn ssh_trust_target(hostname: &str, port: u16) -> String {
    if hostname.contains(':') && !hostname.starts_with('[') {
        format!("[{hostname}]:{port}")
    } else {
        format!("{hostname}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn formats_ipv4_names_and_ipv6_trust_targets() {
        assert_eq!(ssh_trust_target("example.com", 22), "example.com:22");
        assert_eq!(ssh_trust_target("192.0.2.1", 22), "192.0.2.1:22");
        assert_eq!(ssh_trust_target("2001:db8::1", 22), "[2001:db8::1]:22");
    }

    #[test]
    fn trust_store_upserts_and_round_trips_keys() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("known-hosts.toml");
        let mut store = SshTrustStore {
            version: 1,
            ssh: Vec::new(),
        };
        store.upsert_key(
            "prod.example.com:22".to_string(),
            "ssh-ed25519 SHA256:abc".to_string(),
        );
        store.upsert_key(
            "prod.example.com:22".to_string(),
            "ssh-ed25519 SHA256:abc".to_string(),
        );
        store.save(&path).expect("save trust");

        let loaded = SshTrustStore::load(&path).expect("load trust");

        assert!(loaded.contains_key("prod.example.com:22", "ssh-ed25519 SHA256:abc"));
        assert!(loaded.has_target_algorithm("prod.example.com:22", "ssh-ed25519"));
        assert_eq!(loaded.ssh[0].keys.len(), 1);
    }
}
