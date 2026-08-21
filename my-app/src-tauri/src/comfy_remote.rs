//! Remote ComfyUI start via SSH.
//!
//! Runs `ssh <hostAlias> <command>` as a plain argv vector — no local shell —
//! so a crafted alias/command pair cannot escape into local execution. Both
//! halves are shape-validated (alias matches a strict identifier pattern and
//! starts with an alphanumeric, so it can never be parsed as an ssh option).
//! stdin is null so an interactive password prompt fails fast instead of
//! hanging, and the whole call is bounded by a hard timeout.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SSH_TIMEOUT: Duration = Duration::from_secs(25);
const OUTPUT_CAP_BYTES: usize = 64 * 1024;

/// SSH host aliases come from the user's ~/.ssh/config. Allow a plain
/// identifier shape only: starts alphanumeric, then letters/digits/dot/dash/
/// underscore. A leading `-` is impossible, so OpenSSH can never read the
/// alias as an option.
pub(crate) fn validate_ssh_host_alias(alias: &str) -> Result<(), String> {
    let mut chars = alias.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return Err("SSH host alias must start with a letter or digit.".to_string()),
    }
    if alias.len() > 64 {
        return Err("SSH host alias is too long.".to_string());
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') {
        return Err(
            "SSH host alias may only contain letters, digits, dots, dashes, and underscores."
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) fn validate_ssh_start_command(command: &str) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("SSH start command is empty.".to_string());
    }
    if command.len() > 200 {
        return Err("SSH start command is too long.".to_string());
    }
    if command.contains('\0') || command.contains('\n') || command.contains('\r') {
        return Err("SSH start command must be a single line.".to_string());
    }
    Ok(())
}

fn read_capped(stream: &mut impl Read) -> String {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buffer.len() + n > OUTPUT_CAP_BYTES {
                    buffer.extend_from_slice(&chunk[..OUTPUT_CAP_BYTES - buffer.len()]);
                    buffer.extend_from_slice(b"\n...output truncated...".as_slice());
                    break;
                }
                buffer.extend_from_slice(&chunk[..n]);
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buffer).to_string()
}

/// Execute the SSH start and return a JSON payload for the bridge response.
pub(crate) fn comfy_ssh_start(host_alias: &str, command: &str) -> Result<String, String> {
    validate_ssh_host_alias(host_alias)?;
    validate_ssh_start_command(command)?;

    let mut child = Command::new("ssh")
        .arg(host_alias)
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("Could not run ssh on this machine: {err}"))?;

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if started.elapsed() >= SSH_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(err) => return Err(format!("ssh failed to run: {err}")),
        }
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        stdout = read_capped(&mut pipe);
    }
    if let Some(mut pipe) = child.stderr.take() {
        stderr = read_capped(&mut pipe);
    }

    match status {
        None => Err(
            "ssh start timed out — the remote machine may still be booting ComfyUI.".to_string(),
        ),
        Some(status) => {
            let payload = serde_json::json!({
                "ok": status.success(),
                "exitCode": status.code(),
                "stdout": stdout,
                "stderr": stderr,
            });
            serde_json::to_string(&payload).map_err(|err| err.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_ssh_host_alias, validate_ssh_start_command};

    #[test]
    fn accepts_plain_aliases() {
        assert!(validate_ssh_host_alias("gmk").is_ok());
        assert!(validate_ssh_host_alias("box2.lan").is_ok());
        assert!(validate_ssh_host_alias("a-b_c").is_ok());
    }

    #[test]
    fn rejects_alias_option_injection() {
        // Leading dash would let OpenSSH parse the alias as an option.
        assert!(validate_ssh_host_alias("-oProxyCommand=evil").is_err());
        assert!(validate_ssh_host_alias("--").is_err());
        // Spaces / shell metacharacters have no business in an ssh-config alias.
        assert!(validate_ssh_host_alias("gmk; rm -rf /").is_err());
        assert!(validate_ssh_host_alias("g mk").is_err());
        assert!(validate_ssh_host_alias("").is_err());
        assert!(validate_ssh_host_alias("gmk\nHost evil").is_err());
    }

    #[test]
    fn validates_start_command_shape() {
        assert!(validate_ssh_start_command("~/ai/comfy start").is_ok());
        assert!(validate_ssh_start_command("").is_err());
        assert!(validate_ssh_start_command("   ").is_err());
        assert!(validate_ssh_start_command("start\nrm -rf /").is_err());
        let long = "x".repeat(201);
        assert!(validate_ssh_start_command(&long).is_err());
    }
}
