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

pub(crate) fn provider_entry(provider_id: &str) -> Result<Entry, String> {
    keyring::use_native_store(true).map_err(|err| format!("Keychain unavailable: {err}"))?;
    Entry::new(KEYCHAIN_SERVICE, provider_id)
        .map_err(|err| format!("Could not open keychain entry: {err}"))
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

pub(crate) fn has_keychain_secret(provider_id: &str) -> bool {
    provider_entry(provider_id)
        .and_then(|entry| entry.get_password().map_err(|err| err.to_string()))
        .is_ok()
}

#[tauri::command]
pub(crate) fn save_provider_secret(
    payload: ProviderSecretPayload,
) -> Result<ProviderSecretStatus, String> {
    if payload.provider_id.trim().is_empty() {
        return Err("Provider id is required".to_string());
    }
    if payload.api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }

    let provider_id = payload.provider_id.trim().to_string();
    validate_provider_id(&provider_id)?;
    let entry = provider_entry(&provider_id)?;
    entry
        .set_password(payload.api_key.trim())
        .map_err(|err| format!("Could not save provider secret: {err}"))?;

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
pub(crate) fn get_provider_secret(payload: ProviderIdPayload) -> Result<String, String> {
    let provider_id = payload.provider_id.trim().to_string();
    if provider_id.is_empty() {
        return Err("Provider id is required".to_string());
    }
    validate_provider_id(&provider_id)?;
    let entry = provider_entry(&provider_id)?;
    entry
        .get_password()
        .map_err(|err| format!("Could not read provider secret: {err}"))
}

#[tauri::command]
pub(crate) fn delete_provider_secret(
    payload: ProviderIdPayload,
) -> Result<ProviderSecretStatus, String> {
    let provider_id = payload.provider_id.trim().to_string();
    if provider_id.is_empty() {
        return Err("Provider id is required".to_string());
    }
    validate_provider_id(&provider_id)?;

    let entry = provider_entry(&provider_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(ProviderSecretStatus {
            provider_id,
            configured: false,
            secret_store: "system-keychain",
        }),
        Err(err) => Err(format!("Could not delete provider secret: {err}")),
    }
}
