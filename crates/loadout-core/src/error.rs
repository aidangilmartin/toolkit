use std::path::Path;

/// Errors surfaced by the core. Messages are written for players, not developers:
/// they are shown in the UI as-is.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("Couldn't read {what}: {message}")]
    Parse { what: String, message: String },
    #[error("{0}")]
    Invalid(String),
    #[error("{0} wasn't found")]
    NotFound(String),
    /// A server lookup failed. The message says why, for the player.
    #[error("{0}")]
    Network(String),
    #[error("Close {} first, then try again", .0.join(", "))]
    GameRunning(Vec<String>),
    #[error("Couldn't read the archive: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("Couldn't save data: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn invalid(message: impl Into<String>) -> Self {
        Error::Invalid(message.into())
    }

    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Error::Io {
            context: context.into(),
            source,
        }
    }

    /// The message shown in the UI, with a hint for the usual Windows culprit.
    pub fn user_message(&self) -> String {
        let mut message = self.to_string();
        if let Error::Io { source, .. } = self {
            if source.kind() == std::io::ErrorKind::PermissionDenied {
                message.push_str(
                    ". Windows blocked access: make sure the game is closed. If GTA V is installed under Program Files, run Loadout as administrator.",
                );
            }
        }
        message
    }
}

/// Attach a human readable context (usually "verb + path") to IO errors.
pub trait IoContext<T> {
    fn ctx(self, context: impl FnOnce() -> String) -> Result<T>;
    fn ctx_path(self, verb: &str, path: &Path) -> Result<T>;
}

impl<T> IoContext<T> for std::io::Result<T> {
    fn ctx(self, context: impl FnOnce() -> String) -> Result<T> {
        self.map_err(|source| Error::io(context(), source))
    }

    fn ctx_path(self, verb: &str, path: &Path) -> Result<T> {
        self.map_err(|source| Error::io(format!("Couldn't {verb} {}", path.display()), source))
    }
}
