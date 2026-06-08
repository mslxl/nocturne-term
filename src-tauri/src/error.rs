use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "message")]
pub enum ConfigError {
    Io { message: String },
    Parse { message: String },
    Missing { message: String },
    Invalid { message: String },
    Terminal { message: String },
    SshWorkspaceChallenge {
        challenge: crate::types::SshWorkspaceChallenge,
        message: String,
    },
}

pub type Result<T> = std::result::Result<T, ConfigError>;

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { message } => write!(f, "io error: {message}"),
            Self::Parse { message } => write!(f, "parse error: {message}"),
            Self::Missing { message } => write!(f, "missing value: {message}"),
            Self::Invalid { message } => write!(f, "invalid value: {message}"),
            Self::Terminal { message } => write!(f, "terminal error: {message}"),
            Self::SshWorkspaceChallenge { message, .. } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for ConfigError {}

pub(crate) fn io_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError::Io {
        message: error.to_string(),
    }
}

pub(crate) fn parse_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError::Parse {
        message: error.to_string(),
    }
}

pub(crate) fn missing_error(message: impl Into<String>) -> ConfigError {
    ConfigError::Missing {
        message: message.into(),
    }
}

pub(crate) fn invalid_error(message: impl Into<String>) -> ConfigError {
    ConfigError::Invalid {
        message: message.into(),
    }
}

pub(crate) fn terminal_error(message: impl std::fmt::Display) -> ConfigError {
    ConfigError::Terminal {
        message: message.to_string(),
    }
}

pub(crate) fn ssh_workspace_challenge_error(
    challenge: crate::types::SshWorkspaceChallenge,
    message: impl Into<String>,
) -> ConfigError {
    ConfigError::SshWorkspaceChallenge {
        challenge,
        message: message.into(),
    }
}
