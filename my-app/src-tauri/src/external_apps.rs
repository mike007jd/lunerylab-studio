#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Command;
use std::sync::OnceLock;

// External runtime install detection — Tauri sandbox PATH differs from
// Terminal, so we check known absolute paths rather than `which`.
//
// Install state cannot change without restarting the app (user would have to
// install Ollama / LM Studio while we're running), so we cache the first
// stat-storm into a OnceLock and serve subsequent calls from memory.
static OLLAMA_INSTALLED_CACHE: OnceLock<bool> = OnceLock::new();
static LMSTUDIO_INSTALLED_CACHE: OnceLock<bool> = OnceLock::new();

fn probe_ollama_installed() -> bool {
    #[cfg(not(windows))]
    {
        [
            "/usr/local/bin/ollama",
            "/opt/homebrew/bin/ollama",
            "/usr/bin/ollama",
        ]
        .iter()
        .any(|p| std::path::Path::new(p).exists())
    }
    #[cfg(windows)]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        if local_app_data.is_empty() {
            return false;
        }
        std::path::Path::new(&local_app_data)
            .join("Programs")
            .join("Ollama")
            .join("ollama.exe")
            .exists()
    }
}

pub(crate) fn is_ollama_installed() -> bool {
    *OLLAMA_INSTALLED_CACHE.get_or_init(probe_ollama_installed)
}

pub(crate) fn is_lmstudio_installed() -> bool {
    *LMSTUDIO_INSTALLED_CACHE.get_or_init(probe_lmstudio_installed)
}

fn probe_lmstudio_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new("/Applications/LM Studio.app").exists()
    }
    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        if local_app_data.is_empty() {
            return false;
        }
        std::path::Path::new(&local_app_data)
            .join("Programs")
            .join("LM Studio")
            .join("LM Studio.exe")
            .exists()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Fire-and-forget launcher for known external runtimes.
pub(crate) fn launch_external_app(app_id: &str) -> Result<(), String> {
    match app_id {
        "ollama" => {
            #[cfg(target_os = "macos")]
            {
                Command::new("open")
                    .args(["-a", "Ollama"])
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Could not launch Ollama: {e}"))
            }
            #[cfg(target_os = "windows")]
            {
                let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
                let exe = std::path::Path::new(&local_app_data)
                    .join("Programs")
                    .join("Ollama")
                    .join("ollama.exe");
                if !exe.exists() {
                    return Err("Ollama is not installed".to_string());
                }
                Command::new(exe)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Could not launch Ollama: {e}"))
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                Err("Launching external apps is unsupported on this platform.".to_string())
            }
        }
        "lm-studio" => {
            #[cfg(target_os = "macos")]
            {
                Command::new("open")
                    .args(["-a", "LM Studio"])
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Could not launch LM Studio: {e}"))
            }
            #[cfg(target_os = "windows")]
            {
                let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
                let exe = std::path::Path::new(&local_app_data)
                    .join("Programs")
                    .join("LM Studio")
                    .join("LM Studio.exe");
                if !exe.exists() {
                    return Err("LM Studio is not installed".to_string());
                }
                Command::new(exe)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Could not launch LM Studio: {e}"))
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                Err("Launching external apps is unsupported on this platform.".to_string())
            }
        }
        "comfyui" => Err(
            "ComfyUI has no standard launch path — start it from its own install directory."
                .to_string(),
        ),
        _ => Err(format!("Unknown app_id: {app_id}")),
    }
}
