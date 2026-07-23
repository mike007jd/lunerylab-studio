use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const KEYCHAIN_SERVICE: &str = "com.lunerylab.studio.provider";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderSecretPayload {
    provider_id: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderIdPayload {
    pub(crate) provider_id: String,
}

#[derive(Serialize)]
pub(crate) struct ProviderSecretStatus {
    provider_id: String,
    configured: bool,
    secret_store: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeychainSecretState {
    Present,
    Missing,
    Unavailable,
}

impl KeychainSecretState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Missing => "missing",
            Self::Unavailable => "unavailable",
        }
    }

    pub(crate) fn is_present(self) -> bool {
        self == Self::Present
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderSecretReadError {
    InvalidProvider,
    Missing,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderSecretMutationError {
    InvalidProvider,
    InvalidSecret,
    Unavailable,
}

impl ProviderSecretMutationError {
    pub(crate) fn public_message(self) -> &'static str {
        match self {
            Self::InvalidProvider => "Invalid provider id",
            Self::InvalidSecret => "API key is required",
            Self::Unavailable => "System keychain is unavailable",
        }
    }
}

impl Serialize for ProviderSecretMutationError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.public_message())
    }
}

impl ProviderSecretReadError {
    pub(crate) fn audit_reason(self) -> &'static str {
        match self {
            Self::InvalidProvider => "invalid_provider",
            Self::Missing => "missing",
            Self::Unavailable => "keychain_unavailable",
        }
    }

    pub(crate) fn public_message(self) -> &'static str {
        match self {
            Self::InvalidProvider => "Invalid provider id",
            Self::Missing => "Provider secret is not configured",
            Self::Unavailable => "System keychain is unavailable",
        }
    }
}

pub(crate) fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    let ok = !provider_id.is_empty()
        && provider_id.len() <= 64
        && provider_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err("Invalid provider id".to_string())
    }
}

pub(crate) fn provider_entry(provider_id: &str) -> Result<Entry, ProviderSecretMutationError> {
    keyring::use_native_store(true).map_err(|_| ProviderSecretMutationError::Unavailable)?;
    Entry::new(KEYCHAIN_SERVICE, provider_id).map_err(|_| ProviderSecretMutationError::Unavailable)
}

/// Sliding-window rate limit shared by the /provider-secret-read endpoint —
/// the only bridge surface that returns OS-keychain material. Caps the global
/// (cross-provider) read rate to 5/minute. Even with a stolen bridge token a
/// runaway exfiltration loop is throttled. Single-user product, so a global
/// limit is enough — no per-provider buckets needed.
static SECRET_READ_TIMES: OnceLock<Mutex<Vec<Instant>>> = OnceLock::new();
const SECRET_READ_LIMIT: usize = 5;
const SECRET_READ_WINDOW: Duration = Duration::from_secs(60);

pub(crate) fn secret_read_rate_limit_ok() -> bool {
    let slot = SECRET_READ_TIMES.get_or_init(|| Mutex::new(Vec::new()));
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let now = Instant::now();
    guard.retain(|t| now.duration_since(*t) <= SECRET_READ_WINDOW);
    if guard.len() >= SECRET_READ_LIMIT {
        return false;
    }
    guard.push(now);
    true
}

/// Append a tamper-evident-ish audit line for every secret-read attempt. We
/// log to stderr only — the desktop runtime is single-user, so the OS event
/// log + Console.app are the persistence layer. NEVER logs the key material.
pub(crate) fn audit_secret_read(provider_id: &str, allowed: bool, reason: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!(
        "[lunerylab][audit] secret-read ts={ts} provider={provider_id} allowed={allowed} reason={reason}"
    );
}

fn classify_keychain_read_error(error: KeyringError) -> ProviderSecretReadError {
    match error {
        KeyringError::NoEntry => ProviderSecretReadError::Missing,
        _ => ProviderSecretReadError::Unavailable,
    }
}

fn classify_keychain_mutation_error(_error: KeyringError) -> ProviderSecretMutationError {
    ProviderSecretMutationError::Unavailable
}

pub(crate) fn keychain_secret_state(provider_id: &str) -> KeychainSecretState {
    let Ok(entry) = provider_entry(provider_id) else {
        return KeychainSecretState::Unavailable;
    };
    match entry.get_password() {
        Ok(_) => KeychainSecretState::Present,
        Err(KeyringError::NoEntry) => KeychainSecretState::Missing,
        Err(_) => KeychainSecretState::Unavailable,
    }
}

#[tauri::command]
pub(crate) fn save_provider_secret(
    payload: ProviderSecretPayload,
) -> Result<ProviderSecretStatus, ProviderSecretMutationError> {
    if payload.provider_id.trim().is_empty() {
        return Err(ProviderSecretMutationError::InvalidProvider);
    }
    if payload.api_key.trim().is_empty() {
        return Err(ProviderSecretMutationError::InvalidSecret);
    }

    let provider_id = payload.provider_id.trim().to_string();
    validate_provider_id(&provider_id).map_err(|_| ProviderSecretMutationError::InvalidProvider)?;
    let entry = provider_entry(&provider_id)?;
    entry
        .set_password(payload.api_key.trim())
        .map_err(classify_keychain_mutation_error)?;

    Ok(ProviderSecretStatus {
        provider_id,
        configured: true,
        secret_store: "system-keychain",
    })
}

/// Read a provider API key from the OS keychain.
/// SECURITY: the key is returned to the Rust bridge only and is NEVER logged.
/// Do not expose this as a Tauri command; `/provider-secret-read` adds token
/// auth, loopback checks, rate limiting, and audit logs around this helper.
pub(crate) fn get_provider_secret(
    payload: ProviderIdPayload,
) -> Result<String, ProviderSecretReadError> {
    let provider_id = payload.provider_id.trim().to_string();
    if provider_id.is_empty() {
        return Err(ProviderSecretReadError::InvalidProvider);
    }
    validate_provider_id(&provider_id).map_err(|_| ProviderSecretReadError::InvalidProvider)?;
    let entry = provider_entry(&provider_id).map_err(|_| ProviderSecretReadError::Unavailable)?;
    entry.get_password().map_err(classify_keychain_read_error)
}

#[tauri::command]
pub(crate) fn delete_provider_secret(
    payload: ProviderIdPayload,
) -> Result<ProviderSecretStatus, ProviderSecretMutationError> {
    let provider_id = payload.provider_id.trim().to_string();
    if provider_id.is_empty() {
        return Err(ProviderSecretMutationError::InvalidProvider);
    }
    validate_provider_id(&provider_id).map_err(|_| ProviderSecretMutationError::InvalidProvider)?;

    let entry = provider_entry(&provider_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(ProviderSecretStatus {
            provider_id,
            configured: false,
            secret_store: "system-keychain",
        }),
        Err(err) => Err(classify_keychain_mutation_error(err)),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_keychain_mutation_error, classify_keychain_read_error,
        ProviderSecretMutationError, ProviderSecretReadError,
    };
    use keyring_core::Error as KeyringError;

    #[test]
    fn no_entry_is_a_normal_missing_secret() {
        assert_eq!(
            classify_keychain_read_error(KeyringError::NoEntry),
            ProviderSecretReadError::Missing
        );
    }

    #[test]
    fn storage_access_failures_are_unavailable_without_backend_details() {
        let backend_error = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked");
        assert_eq!(
            classify_keychain_read_error(KeyringError::NoStorageAccess(Box::new(backend_error))),
            ProviderSecretReadError::Unavailable
        );
        assert_eq!(
            ProviderSecretReadError::Unavailable.public_message(),
            "System keychain is unavailable"
        );
    }

    #[test]
    fn mutation_failures_are_typed_without_backend_details() {
        let backend_error = std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "backend-password-do-not-leak",
        );
        let error = classify_keychain_mutation_error(KeyringError::NoStorageAccess(Box::new(
            backend_error,
        )));
        assert_eq!(error, ProviderSecretMutationError::Unavailable);
        assert_eq!(error.public_message(), "System keychain is unavailable");
        assert!(!error
            .public_message()
            .contains("backend-password-do-not-leak"));
    }
}
