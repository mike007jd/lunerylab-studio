use fs4::FileExt;
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::path::PathBuf;

const DEFAULT_PROFILE_NAME: &str = "studio";
const PROFILE_LOCK_FILE_NAME: &str = "profile.lock";

#[derive(Clone)]
pub(crate) struct ProfileDirs {
    pub(crate) root: PathBuf,
    pub(crate) config: PathBuf,
    pub(crate) data: PathBuf,
    pub(crate) pglite: PathBuf,
    pub(crate) media: PathBuf,
    pub(crate) models: PathBuf,
    pub(crate) logs: PathBuf,
    pub(crate) runtime: PathBuf,
}

#[derive(Serialize)]
pub(crate) struct ProfileStorageDirs {
    pub(crate) config: String,
    pub(crate) data: String,
    pub(crate) pglite: String,
    pub(crate) media: String,
    pub(crate) models: String,
    pub(crate) logs: String,
    pub(crate) runtime: String,
}

impl ProfileDirs {
    pub(crate) fn storage_dirs(&self) -> ProfileStorageDirs {
        ProfileStorageDirs {
            config: self.config.display().to_string(),
            data: self.data.display().to_string(),
            pglite: self.pglite.display().to_string(),
            media: self.media.display().to_string(),
            models: self.models.display().to_string(),
            logs: self.logs.display().to_string(),
            runtime: self.runtime.display().to_string(),
        }
    }
}

fn env_abs_path(name: &str) -> Result<Option<PathBuf>, String> {
    let Some(value) = std::env::var_os(name) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty() {
        return Ok(None);
    }
    if !path.is_absolute() {
        return Err(format!("{name} must be an absolute path"));
    }
    Ok(Some(path))
}

fn home_dir_path() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "Could not resolve home directory".to_string())
}

pub(crate) fn profile_root() -> Result<PathBuf, String> {
    if let Some(path) = env_abs_path("LUNERY_HOME")? {
        return Ok(path);
    }
    Ok(home_dir_path()?
        .join(".lunerylab")
        .join(DEFAULT_PROFILE_NAME))
}

pub(crate) fn profile_dirs() -> Result<ProfileDirs, String> {
    let root = profile_root()?;
    let config = env_abs_path("LUNERY_CONFIG_DIR")?.unwrap_or_else(|| root.join("config"));
    let data = env_abs_path("LUNERY_DATA_DIR")?.unwrap_or_else(|| root.join("data"));
    let pglite = env_abs_path("LUNERY_PGLITE_DIR")?.unwrap_or_else(|| data.join("pglite"));
    let media = env_abs_path("LUNERY_MEDIA_DIR")?.unwrap_or_else(|| data.join("media"));
    let models = env_abs_path("LUNERY_MODELS_DIR")?.unwrap_or_else(|| root.join("models"));
    let logs = env_abs_path("LUNERY_LOG_DIR")?.unwrap_or_else(|| root.join("logs"));
    let runtime = env_abs_path("LUNERY_RUNTIME_DIR")?.unwrap_or_else(|| root.join("runtime"));

    Ok(ProfileDirs {
        root,
        config,
        data,
        pglite,
        media,
        models,
        logs,
        runtime,
    })
}

pub(crate) fn ensure_profile_dirs(dirs: &ProfileDirs) -> Result<(), String> {
    for dir in [
        &dirs.root,
        &dirs.config,
        &dirs.data,
        &dirs.pglite,
        &dirs.media,
        &dirs.models,
        &dirs.logs,
        &dirs.runtime,
    ] {
        std::fs::create_dir_all(dir).map_err(|err| {
            format!(
                "Could not create profile directory {}: {err}",
                dir.display()
            )
        })?;
    }
    Ok(())
}

/// Exclusive non-blocking OS advisory lock for the resolved Lunery profile.
/// The lock file is persistent and must not be unlinked on unlock; dropping the
/// returned `File` releases the advisory lock for the process lifetime holder.
pub(crate) fn acquire_profile_advisory_lock(dirs: &ProfileDirs) -> Result<File, String> {
    ensure_profile_dirs(dirs)?;
    let path = dirs.runtime.join(PROFILE_LOCK_FILE_NAME);
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .map_err(|err| format!("Could not open profile lock {}: {err}", path.display()))?;
    // Call fs4 explicitly: Rust 1.89+ adds an inherent File::try_lock that
    // returns std::fs::TryLockError and would otherwise shadow FileExt.
    FileExt::try_lock(&file).map_err(|err| match err {
        fs4::TryLockError::WouldBlock => {
            "Another Lunery Lab Studio instance already holds this profile".to_string()
        }
        fs4::TryLockError::Error(io_err) => {
            format!("Could not lock profile {}: {io_err}", path.display())
        }
    })?;
    Ok(file)
}

pub(crate) fn profile_models_root_path() -> Result<PathBuf, String> {
    Ok(profile_dirs()?.models)
}

pub(crate) fn profile_runtime_root_path() -> Result<PathBuf, String> {
    Ok(profile_dirs()?.runtime)
}

#[cfg(test)]
mod tests {
    use super::{acquire_profile_advisory_lock, ensure_profile_dirs, ProfileDirs};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_profile(name: &str) -> ProfileDirs {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lunery-profile-{name}-{nonce}"));
        let data = root.join("data");
        ProfileDirs {
            root: root.clone(),
            config: root.join("config"),
            data: data.clone(),
            pglite: data.join("pglite"),
            media: data.join("media"),
            models: root.join("models"),
            logs: root.join("logs"),
            runtime: root.join("runtime"),
        }
    }

    #[test]
    fn profile_advisory_lock_is_exclusive_and_persistent() {
        let dirs = unique_profile("lock");
        ensure_profile_dirs(&dirs).expect("dirs");
        let first = acquire_profile_advisory_lock(&dirs).expect("first lock");
        let lock_path = dirs.runtime.join("profile.lock");
        assert!(lock_path.is_file());
        let second = acquire_profile_advisory_lock(&dirs);
        assert!(second.is_err());
        drop(first);
        // Persistent lock file must remain after unlock.
        assert!(lock_path.is_file());
        let third = acquire_profile_advisory_lock(&dirs).expect("lock after drop");
        drop(third);
        assert!(lock_path.is_file());
        let _ = std::fs::remove_dir_all(&dirs.root);
    }
}
