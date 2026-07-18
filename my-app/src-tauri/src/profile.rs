use serde::Serialize;
use std::path::PathBuf;

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
    let media = env_abs_path("ECOM_STORAGE_DIR")?.unwrap_or_else(|| data.join("media"));
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

pub(crate) fn profile_models_root_path() -> Result<PathBuf, String> {
    Ok(profile_dirs()?.models)
}

pub(crate) fn profile_runtime_root_path() -> Result<PathBuf, String> {
    Ok(profile_dirs()?.runtime)
}
