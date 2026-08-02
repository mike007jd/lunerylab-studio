use fs4::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
#[cfg(not(unix))]
use std::fs::OpenOptions;
use std::path::{Component, Path, PathBuf};

const DEFAULT_PROFILE_NAME: &str = "studio";

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

pub(crate) struct ProfileAdvisoryLock {
    _files: Vec<File>,
}

fn normalize_absolute_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!(
            "Profile resource path must be absolute: {}",
            path.display()
        ));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!(
                        "Profile resource path escapes its filesystem root: {}",
                        path.display()
                    ));
                }
            }
        }
    }
    Ok(normalized)
}

fn resource_identity_paths(dirs: &ProfileDirs) -> Result<HashMap<PathBuf, bool>, String> {
    let mut identities = HashMap::new();
    for resource in [
        &dirs.root,
        &dirs.config,
        &dirs.data,
        &dirs.pglite,
        &dirs.media,
        &dirs.models,
        &dirs.logs,
        &dirs.runtime,
    ] {
        let lexical = normalize_absolute_path(resource)?;
        let canonical = resource.canonicalize().map_err(|error| {
            format!(
                "Could not resolve profile resource {} for locking: {error}",
                resource.display()
            )
        })?;
        for exact in [lexical, canonical] {
            for (index, ancestor) in exact.ancestors().enumerate() {
                let exclusive = index == 0;
                identities
                    .entry(ancestor.to_path_buf())
                    .and_modify(|current| *current |= exclusive)
                    .or_insert(exclusive);
            }
        }
    }
    Ok(identities)
}

#[cfg(unix)]
fn update_path_hash(hasher: &mut Sha256, path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    hasher.update(path.as_os_str().as_bytes());
}

#[cfg(windows)]
fn update_path_hash(hasher: &mut Sha256, path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    for value in path.as_os_str().encode_wide() {
        hasher.update(value.to_le_bytes());
    }
}

#[cfg(not(any(unix, windows)))]
fn update_path_hash(hasher: &mut Sha256, path: &Path) {
    hasher.update(path.to_string_lossy().as_bytes());
}

fn resource_lock_path(identity: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    update_path_hash(&mut hasher, identity);
    let digest = hasher.finalize();
    let key = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    std::env::temp_dir().join(format!(".lunery-resource-{key}.lock"))
}

fn open_resource_lock(path: &Path) -> Result<File, String> {
    #[cfg(unix)]
    {
        use rustix::fs::{open, Mode, OFlags};
        let descriptor = open(
            path,
            OFlags::CREATE | OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|error| format!("Could not open resource lock {}: {error}", path.display()))?;
        Ok(File::from(descriptor))
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .map_err(|error| format!("Could not open resource lock {}: {error}", path.display()))
    }
}

fn map_profile_lock_error(error: fs4::TryLockError, identity: &Path) -> String {
    match error {
        fs4::TryLockError::WouldBlock => format!(
            "Another Lunery Lab Studio instance already holds an overlapping profile resource: {}",
            identity.display()
        ),
        fs4::TryLockError::Error(io_error) => format!(
            "Could not lock profile resource {}: {io_error}",
            identity.display()
        ),
    }
}

/// Non-blocking hierarchical OS locks for every resolved mutable resource.
/// Exact logical and canonical identities are exclusive; their ancestors are
/// shared intention locks. This rejects aliases and parent/child overlaps while
/// allowing disjoint profiles, and the lock identity survives directory swaps.
pub(crate) fn acquire_profile_advisory_lock(
    dirs: &ProfileDirs,
) -> Result<ProfileAdvisoryLock, String> {
    ensure_profile_dirs(dirs)?;
    let mut identities = resource_identity_paths(dirs)?
        .into_iter()
        .collect::<Vec<_>>();
    identities.sort_by(|(left, _), (right, _)| left.cmp(right));
    let mut files = Vec::with_capacity(identities.len());
    for (identity, exclusive) in identities {
        let file = open_resource_lock(&resource_lock_path(&identity))?;
        let result = if exclusive {
            FileExt::try_lock(&file)
        } else {
            FileExt::try_lock_shared(&file)
        };
        result.map_err(|error| map_profile_lock_error(error, &identity))?;
        files.push(file);
    }
    Ok(ProfileAdvisoryLock { _files: files })
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
        let second = acquire_profile_advisory_lock(&dirs);
        assert!(second.is_err());
        drop(first);
        let third = acquire_profile_advisory_lock(&dirs).expect("lock after drop");
        drop(third);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    #[test]
    fn shared_mutable_override_conflicts_even_with_different_runtime_dirs() {
        let first_dirs = unique_profile("shared-first");
        let mut second_dirs = unique_profile("shared-second");
        second_dirs.pglite = first_dirs.pglite.clone();
        second_dirs.models = first_dirs.models.clone();
        ensure_profile_dirs(&first_dirs).expect("first dirs");
        ensure_profile_dirs(&second_dirs).expect("second dirs");

        let first = acquire_profile_advisory_lock(&first_dirs).expect("first lock");
        let error = acquire_profile_advisory_lock(&second_dirs)
            .err()
            .expect("shared PGlite/models must conflict");
        assert!(error.contains("overlapping profile resource"));

        drop(first);
        let second = acquire_profile_advisory_lock(&second_dirs).expect("lock after release");
        drop(second);
        let _ = std::fs::remove_dir_all(&first_dirs.root);
        let _ = std::fs::remove_dir_all(&second_dirs.root);
    }

    #[test]
    fn runtime_directory_replacement_cannot_bypass_logical_identity_lock() {
        let dirs = unique_profile("runtime-replacement");
        ensure_profile_dirs(&dirs).expect("dirs");
        let first = acquire_profile_advisory_lock(&dirs).expect("first lock");
        let displaced = dirs.root.join("runtime-displaced");
        std::fs::rename(&dirs.runtime, &displaced).expect("replace runtime directory");
        std::fs::create_dir(&dirs.runtime).expect("new runtime directory");

        let error = acquire_profile_advisory_lock(&dirs)
            .err()
            .expect("replacement must not bypass logical path lock");
        assert!(error.contains("overlapping profile resource"));

        drop(first);
        let replacement = acquire_profile_advisory_lock(&dirs).expect("lock after release");
        drop(replacement);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    #[test]
    fn disjoint_profiles_can_hold_resource_locks_concurrently() {
        let first_dirs = unique_profile("disjoint-first");
        let second_dirs = unique_profile("disjoint-second");
        let first = acquire_profile_advisory_lock(&first_dirs).expect("first lock");
        let second = acquire_profile_advisory_lock(&second_dirs).expect("disjoint second lock");
        drop((first, second));
        let _ = std::fs::remove_dir_all(&first_dirs.root);
        let _ = std::fs::remove_dir_all(&second_dirs.root);
    }
}
