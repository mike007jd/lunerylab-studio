use serde::Deserialize;
use std::path::{Component, Path};

use crate::profile::ProfileDirs;

const WORKSPACE_INITIALIZATION_LOCK: &str = ".workspace-initialization.lock";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProfileFsRoot {
    Config,
    Media,
    Models,
    Runtime,
}

#[derive(Clone, Copy, Deserialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WorkspaceRestoreRoot {
    Config,
    Media,
}

#[derive(Deserialize)]
pub(crate) struct ProfileFsEnvelope {
    pub(crate) request_id: String,
    #[serde(flatten)]
    pub(crate) request: ProfileFsRequest,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case")]
pub(crate) enum ProfileFsRequest {
    Mkdir {
        root: ProfileFsRoot,
        relative_path: String,
    },
    Write {
        root: ProfileFsRoot,
        relative_path: String,
        source_path: String,
        replace: bool,
    },
    Rename {
        root: ProfileFsRoot,
        source_relative_path: String,
        destination_relative_path: String,
        replace: bool,
    },
    Unlink {
        root: ProfileFsRoot,
        relative_path: String,
        missing_ok: bool,
    },
    UnlinkExternalIdentity {
        absolute_path: String,
        expected_device: String,
        expected_inode: String,
        expected_size: String,
        expected_modified_at_ns: String,
    },
    PrepareWorkspaceRestore {
        token: String,
        config_original_device: String,
        config_original_inode: String,
        media_original_device: String,
        media_original_inode: String,
    },
    WriteWorkspaceRestoreFile {
        token: String,
        root: WorkspaceRestoreRoot,
        relative_path: String,
        source_path: String,
    },
    SealWorkspaceRestoreRoot {
        token: String,
        root: WorkspaceRestoreRoot,
    },
    AttestWorkspaceRestoreStages {
        token: String,
        config_staged_device: String,
        config_staged_inode: String,
        media_staged_device: String,
        media_staged_inode: String,
    },
    PromoteWorkspaceRestoreRoots {
        token: String,
    },
    RollbackWorkspaceRestoreRoots {
        token: String,
        config_original_device: String,
        config_original_inode: String,
        media_original_device: String,
        media_original_inode: String,
        config_staged_device: Option<String>,
        config_staged_inode: Option<String>,
        media_staged_device: Option<String>,
        media_staged_inode: Option<String>,
    },
    CleanupWorkspaceRestore {
        token: String,
        config_original_device: String,
        config_original_inode: String,
        media_original_device: String,
        media_original_inode: String,
        config_staged_device: Option<String>,
        config_staged_inode: Option<String>,
        media_staged_device: Option<String>,
        media_staged_inode: Option<String>,
    },
    RefreshWorkspaceRestoreRoots {
        token: String,
        config_staged_device: Option<String>,
        config_staged_inode: Option<String>,
        media_staged_device: Option<String>,
        media_staged_inode: Option<String>,
    },
}

fn relative_components(value: &str) -> Result<Vec<String>, String> {
    if value.is_empty() || value.contains('\0') || value.contains('\\') {
        return Err("Invalid profile-relative path".to_string());
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err("Invalid profile-relative path".to_string());
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| "Profile-relative path must be UTF-8".to_string())?;
                if value.is_empty() || value == "." || value == ".." || value.contains('/') {
                    return Err("Invalid profile-relative path".to_string());
                }
                components.push(value.to_string());
            }
            _ => return Err("Invalid profile-relative path".to_string()),
        }
    }
    if components.is_empty() {
        return Err("Invalid profile-relative path".to_string());
    }
    Ok(components)
}

pub(crate) fn execute_profile_fs(request: ProfileFsRequest) -> Result<(), String> {
    #[cfg(unix)]
    {
        unix::execute(request)
    }
    #[cfg(not(unix))]
    {
        let _ = request;
        // Windows path mutation is deliberately unavailable until every
        // component can be opened with reparse-point-safe handles. Falling
        // back to pathname operations would reopen the containment race.
        Err("Safe profile file mutation is unavailable on this platform".to_string())
    }
}

pub(crate) fn clear_stale_workspace_initialization_lock() -> Result<(), String> {
    execute_profile_fs(ProfileFsRequest::Unlink {
        root: ProfileFsRoot::Runtime,
        relative_path: WORKSPACE_INITIALIZATION_LOCK.to_string(),
        missing_ok: true,
    })
}

pub(crate) fn initialize_profile_fs_roots(dirs: &ProfileDirs) -> Result<(), String> {
    #[cfg(unix)]
    {
        unix::initialize_roots(dirs)
    }
    #[cfg(not(unix))]
    {
        let _ = dirs;
        Ok(())
    }
}

#[cfg(not(debug_assertions))]
pub(crate) fn refresh_profile_fs_roots(dirs: &ProfileDirs) -> Result<(), String> {
    #[cfg(unix)]
    {
        unix::refresh_roots(dirs)
    }
    #[cfg(not(unix))]
    {
        let _ = dirs;
        Ok(())
    }
}

#[cfg(unix)]
mod unix {
    use super::{
        relative_components, ProfileDirs, ProfileFsRequest, ProfileFsRoot, WorkspaceRestoreRoot,
    };
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io::{self, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Component, Path, PathBuf};
    use std::sync::{Mutex, OnceLock, RwLock};

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct DirectoryIdentity {
        device: u64,
        inode: u64,
    }

    #[derive(Clone, Debug)]
    struct CapturedDirectory {
        canonical_path: PathBuf,
        identity: DirectoryIdentity,
    }

    #[derive(Clone, Debug)]
    struct ProfileFsRoots {
        profile: CapturedDirectory,
        data: CapturedDirectory,
        pglite: CapturedDirectory,
        logs: CapturedDirectory,
        config_parent: CapturedDirectory,
        media_parent: CapturedDirectory,
        config: CapturedDirectory,
        media: CapturedDirectory,
        models: CapturedDirectory,
        runtime: CapturedDirectory,
    }

    #[derive(Clone, Debug)]
    struct RestoreStageAuthority {
        token: String,
        config: DirectoryIdentity,
        media: DirectoryIdentity,
        config_original: DirectoryIdentity,
        media_original: DirectoryIdentity,
    }

    #[derive(Clone, Copy, Debug)]
    struct RestoreOriginalIdentities {
        config: DirectoryIdentity,
        media: DirectoryIdentity,
    }

    #[derive(Clone, Copy, Debug)]
    struct RestoreStagedIdentities {
        config: DirectoryIdentity,
        media: DirectoryIdentity,
    }

    static PROFILE_FS_ROOTS: OnceLock<RwLock<Option<ProfileFsRoots>>> = OnceLock::new();
    static RESTORE_STAGE_AUTHORITY: OnceLock<Mutex<Option<RestoreStageAuthority>>> =
        OnceLock::new();

    fn roots_slot() -> &'static RwLock<Option<ProfileFsRoots>> {
        PROFILE_FS_ROOTS.get_or_init(|| RwLock::new(None))
    }

    fn restore_authority_slot() -> &'static Mutex<Option<RestoreStageAuthority>> {
        RESTORE_STAGE_AUTHORITY.get_or_init(|| Mutex::new(None))
    }

    fn c_name(value: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| "Invalid profile-relative path".to_string())
    }

    fn errno(error: io::Error, action: &str) -> String {
        format!("{action}: {error}")
    }

    fn open_filesystem_root() -> Result<OwnedFd, String> {
        let root = CString::new("/").expect("filesystem root CString");
        let fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not open filesystem root",
            ));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn open_child_dir(parent: RawFd, name: &CStr) -> Result<OwnedFd, io::Error> {
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn descriptor_identity(descriptor: RawFd) -> Result<DirectoryIdentity, String> {
        let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(descriptor, &mut metadata) } < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not inspect profile directory",
            ));
        }
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err("Profile root must be a real directory".to_string());
        }
        Ok(DirectoryIdentity {
            device: metadata.st_dev as u64,
            inode: metadata.st_ino as u64,
        })
    }

    /// Walk a startup-canonicalized absolute path from the filesystem root.
    /// Every component is descriptor-opened with O_NOFOLLOW, so a later
    /// pathname swap can only fail or reach an identity that we reject.
    fn open_absolute_directory(path: &Path) -> Result<OwnedFd, String> {
        if !path.is_absolute() {
            return Err("Profile root must be absolute".to_string());
        }
        let mut current = open_filesystem_root()?;
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let name = CString::new(name.as_bytes())
                        .map_err(|_| "Profile root contains a NUL byte".to_string())?;
                    current = open_child_dir(current.as_raw_fd(), &name)
                        .map_err(|error| errno(error, "Could not open profile root component"))?;
                }
                _ => return Err("Profile root is not a normalized absolute path".to_string()),
            }
        }
        Ok(current)
    }

    fn capture_directory(path: &Path) -> Result<CapturedDirectory, String> {
        let canonical_path = path.canonicalize().map_err(|error| {
            errno(
                error,
                &format!("Could not resolve profile root {}", path.display()),
            )
        })?;
        let descriptor = open_absolute_directory(&canonical_path)?;
        let identity = descriptor_identity(descriptor.as_raw_fd())?;
        Ok(CapturedDirectory {
            canonical_path,
            identity,
        })
    }

    fn capture_roots(dirs: &ProfileDirs) -> Result<ProfileFsRoots, String> {
        let config_parent = dirs
            .config
            .parent()
            .ok_or_else(|| "Config root has no parent".to_string())?;
        let media_parent = dirs
            .media
            .parent()
            .ok_or_else(|| "Media root has no parent".to_string())?;
        Ok(ProfileFsRoots {
            profile: capture_directory(&dirs.root)?,
            data: capture_directory(&dirs.data)?,
            pglite: capture_directory(&dirs.pglite)?,
            logs: capture_directory(&dirs.logs)?,
            config_parent: capture_directory(config_parent)?,
            media_parent: capture_directory(media_parent)?,
            config: capture_directory(&dirs.config)?,
            media: capture_directory(&dirs.media)?,
            models: capture_directory(&dirs.models)?,
            runtime: capture_directory(&dirs.runtime)?,
        })
    }

    pub(super) fn initialize_roots(dirs: &ProfileDirs) -> Result<(), String> {
        let roots = capture_roots(dirs)?;
        let mut guard = roots_slot()
            .write()
            .map_err(|_| "Safe profile filesystem root lock is poisoned".to_string())?;
        if guard.is_some() {
            return Err("Safe profile filesystem roots were already initialized".to_string());
        }
        *guard = Some(roots);
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    pub(super) fn refresh_roots(dirs: &ProfileDirs) -> Result<(), String> {
        // Capture every new identity before publishing any of them. Reset
        // revokes and drains the old bridge first, so this single write-lock
        // swap is the authority handoff to the replacement media tree.
        let roots = capture_roots(dirs)?;
        let mut guard = roots_slot()
            .write()
            .map_err(|_| "Safe profile filesystem root lock is poisoned".to_string())?;
        if guard.is_none() {
            return Err("Safe profile filesystem roots are not initialized".to_string());
        }
        *guard = Some(roots);
        Ok(())
    }

    fn open_captured_directory(directory: &CapturedDirectory) -> Result<OwnedFd, String> {
        let descriptor = open_absolute_directory(&directory.canonical_path)?;
        if descriptor_identity(descriptor.as_raw_fd())? != directory.identity {
            return Err(format!(
                "Profile root identity changed; refusing mutation under {}",
                directory.canonical_path.display()
            ));
        }
        Ok(descriptor)
    }

    fn open_root_with_roots(
        root: ProfileFsRoot,
        roots: &ProfileFsRoots,
    ) -> Result<OwnedFd, String> {
        // The resolved profile root is part of every mutation authority even
        // when a specific resource is overridden outside it.
        let profile = open_captured_directory(&roots.profile)?;
        let selected = match root {
            ProfileFsRoot::Config => &roots.config,
            ProfileFsRoot::Media => &roots.media,
            ProfileFsRoot::Models => &roots.models,
            ProfileFsRoot::Runtime => &roots.runtime,
        };
        if selected.identity == roots.profile.identity {
            return Ok(profile);
        }
        drop(profile);
        open_captured_directory(selected)
    }

    fn open_root(root: ProfileFsRoot) -> Result<OwnedFd, String> {
        #[cfg(not(test))]
        let roots = roots_slot()
            .read()
            .map_err(|_| "Safe profile filesystem root lock is poisoned".to_string())?;
        #[cfg(not(test))]
        let roots = roots
            .as_ref()
            .ok_or_else(|| "Safe profile filesystem roots are not initialized".to_string())?;
        #[cfg(test)]
        let roots = &capture_roots(&crate::profile::profile_dirs()?)?;
        open_root_with_roots(root, roots)
    }

    fn current_roots() -> Result<ProfileFsRoots, String> {
        #[cfg(not(test))]
        {
            let guard = roots_slot()
                .read()
                .map_err(|_| "Safe profile filesystem root lock is poisoned".to_string())?;
            guard
                .clone()
                .ok_or_else(|| "Safe profile filesystem roots are not initialized".to_string())
        }
        #[cfg(test)]
        {
            capture_roots(&crate::profile::profile_dirs()?)
        }
    }

    fn publish_roots(roots: ProfileFsRoots) -> Result<(), String> {
        #[cfg(not(test))]
        {
            let mut guard = roots_slot()
                .write()
                .map_err(|_| "Safe profile filesystem root lock is poisoned".to_string())?;
            if guard.is_none() {
                return Err("Safe profile filesystem roots are not initialized".to_string());
            }
            *guard = Some(roots);
        }
        #[cfg(test)]
        let _ = roots;
        Ok(())
    }

    fn valid_restore_token(token: &str) -> bool {
        let bytes = token.as_bytes();
        (8..=128).contains(&bytes.len())
            && bytes[0].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
    }

    fn checked_restore_token(token: &str) -> Result<(), String> {
        if valid_restore_token(token) {
            Ok(())
        } else {
            Err("Invalid workspace restore token".to_string())
        }
    }

    fn parse_restore_identity(device: &str, inode: &str) -> Result<DirectoryIdentity, String> {
        Ok(DirectoryIdentity {
            device: device
                .parse::<u64>()
                .map_err(|_| "Invalid workspace restore root device".to_string())?,
            inode: inode
                .parse::<u64>()
                .map_err(|_| "Invalid workspace restore root inode".to_string())?,
        })
    }

    fn restore_original_identities(
        config_device: &str,
        config_inode: &str,
        media_device: &str,
        media_inode: &str,
    ) -> Result<RestoreOriginalIdentities, String> {
        Ok(RestoreOriginalIdentities {
            config: parse_restore_identity(config_device, config_inode)?,
            media: parse_restore_identity(media_device, media_inode)?,
        })
    }

    fn expected_original_identity(
        identities: &RestoreOriginalIdentities,
        root: WorkspaceRestoreRoot,
    ) -> DirectoryIdentity {
        match root {
            WorkspaceRestoreRoot::Config => identities.config,
            WorkspaceRestoreRoot::Media => identities.media,
        }
    }

    fn restore_staged_identities(
        config_device: Option<&str>,
        config_inode: Option<&str>,
        media_device: Option<&str>,
        media_inode: Option<&str>,
    ) -> Result<Option<RestoreStagedIdentities>, String> {
        match (config_device, config_inode, media_device, media_inode) {
            (None, None, None, None) => Ok(None),
            (Some(config_device), Some(config_inode), Some(media_device), Some(media_inode)) => {
                Ok(Some(RestoreStagedIdentities {
                    config: parse_restore_identity(config_device, config_inode)?,
                    media: parse_restore_identity(media_device, media_inode)?,
                }))
            }
            _ => Err("Incomplete workspace restore staged identity".to_string()),
        }
    }

    fn expected_staged_identity(
        identities: &RestoreStagedIdentities,
        root: WorkspaceRestoreRoot,
    ) -> DirectoryIdentity {
        match root {
            WorkspaceRestoreRoot::Config => identities.config,
            WorkspaceRestoreRoot::Media => identities.media,
        }
    }

    struct RestoreRootPaths<'a> {
        selected: &'a CapturedDirectory,
        parent: &'a CapturedDirectory,
        live: CString,
        staged: CString,
        previous: CString,
        discarded: CString,
    }

    fn restore_root_paths<'a>(
        root: WorkspaceRestoreRoot,
        token: &str,
        roots: &'a ProfileFsRoots,
    ) -> Result<RestoreRootPaths<'a>, String> {
        checked_restore_token(token)?;
        let (selected, parent) = match root {
            WorkspaceRestoreRoot::Config => (&roots.config, &roots.config_parent),
            WorkspaceRestoreRoot::Media => (&roots.media, &roots.media_parent),
        };
        if selected.canonical_path.parent() != Some(parent.canonical_path.as_path()) {
            return Err("Workspace restore root escaped its pinned parent".to_string());
        }
        let live = selected
            .canonical_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Workspace restore root name must be UTF-8".to_string())?;
        let prefix = format!(".{live}.restore");
        Ok(RestoreRootPaths {
            selected,
            parent,
            live: c_name(live)?,
            staged: c_name(&format!("{prefix}-stage-{token}"))?,
            previous: c_name(&format!("{prefix}-previous-{token}"))?,
            discarded: c_name(&format!("{prefix}-discarded-{token}"))?,
        })
    }

    fn open_restore_parent(
        paths: &RestoreRootPaths<'_>,
        roots: &ProfileFsRoots,
    ) -> Result<OwnedFd, String> {
        // Every restore mutation retains the startup profile identity as an
        // authority boundary, even when media/config is externally resolved.
        let profile = open_captured_directory(&roots.profile)?;
        if paths.parent.identity == roots.profile.identity {
            return Ok(profile);
        }
        drop(profile);
        open_captured_directory(paths.parent)
    }

    fn directory_entry_identity(
        parent: RawFd,
        leaf: &CStr,
    ) -> Result<Option<DirectoryIdentity>, String> {
        let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                parent,
                leaf.as_ptr(),
                &mut metadata,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } < 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOENT) {
                return Ok(None);
            }
            return Err(errno(error, "Could not inspect workspace restore path"));
        }
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err("Workspace restore path must be a real directory".to_string());
        }
        Ok(Some(DirectoryIdentity {
            device: metadata.st_dev as u64,
            inode: metadata.st_ino as u64,
        }))
    }

    fn require_directory_identity(
        parent: RawFd,
        leaf: &CStr,
        expected: DirectoryIdentity,
        label: &str,
    ) -> Result<(), String> {
        match directory_entry_identity(parent, leaf)? {
            Some(identity) if identity == expected => Ok(()),
            Some(_) => Err(format!(
                "{label} identity changed; refusing workspace restore"
            )),
            None => Err(format!("{label} is missing")),
        }
    }

    fn open_parent(
        root: ProfileFsRoot,
        relative_path: &str,
        create: bool,
    ) -> Result<(OwnedFd, CString), String> {
        let components = relative_components(relative_path)?;
        let leaf = c_name(components.last().expect("validated non-empty path"))?;
        let mut current = open_root(root)?;
        for component in &components[..components.len() - 1] {
            let name = c_name(component)?;
            match open_child_dir(current.as_raw_fd(), &name) {
                Ok(next) => current = next,
                Err(error) if create && error.raw_os_error() == Some(libc::ENOENT) => {
                    let created =
                        unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700) };
                    if created < 0 {
                        let error = io::Error::last_os_error();
                        if error.raw_os_error() != Some(libc::EEXIST) {
                            return Err(errno(error, "Could not create profile directory"));
                        }
                    }
                    sync_directory(&current)?;
                    current = open_child_dir(current.as_raw_fd(), &name)
                        .map_err(|error| errno(error, "Could not open profile directory"))?;
                }
                Err(error) => {
                    return Err(errno(error, "Could not open profile directory"));
                }
            }
        }
        Ok((current, leaf))
    }

    fn sync_directory(directory: &OwnedFd) -> Result<(), String> {
        if unsafe { libc::fsync(directory.as_raw_fd()) } < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not sync profile directory",
            ));
        }
        Ok(())
    }

    fn mkdir(root: ProfileFsRoot, relative_path: &str) -> Result<(), String> {
        let (parent, leaf) = open_parent(root, relative_path, true)?;
        let result = unsafe { libc::mkdirat(parent.as_raw_fd(), leaf.as_ptr(), 0o700) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EEXIST) {
                return Err(errno(error, "Could not create profile directory"));
            }
        }
        let opened = open_child_dir(parent.as_raw_fd(), &leaf)
            .map_err(|error| errno(error, "Profile path is not a real directory"))?;
        sync_directory(&opened)?;
        sync_directory(&parent)
    }

    fn source_file(source_path: &str) -> Result<File, String> {
        let source = Path::new(source_path);
        if !source.is_absolute() {
            return Err("Native write source must be absolute".to_string());
        }
        let source = CString::new(source.as_os_str().as_encoded_bytes())
            .map_err(|_| "Native write source contains a NUL byte".to_string())?;
        let fd = unsafe {
            libc::open(
                source.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not open write source",
            ));
        }
        let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut metadata) } < 0 {
            unsafe { libc::close(fd) };
            return Err(errno(
                io::Error::last_os_error(),
                "Could not inspect write source",
            ));
        }
        if metadata.st_mode & libc::S_IFMT != libc::S_IFREG {
            unsafe { libc::close(fd) };
            return Err("Native write source must be a regular file".to_string());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn open_target(parent: RawFd, leaf: &CStr, replace: bool) -> Result<File, String> {
        let create_flags = libc::O_WRONLY
            | libc::O_CREAT
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if replace { 0 } else { libc::O_EXCL };
        let fd = unsafe { libc::openat(parent, leaf.as_ptr(), create_flags, 0o600) };
        if fd < 0 {
            let error = io::Error::last_os_error();
            if !replace && error.raw_os_error() == Some(libc::EEXIST) {
                return Err("Profile destination already exists".to_string());
            }
            return Err(errno(error, "Could not open profile file"));
        }
        let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut metadata) } < 0 {
            unsafe { libc::close(fd) };
            return Err(errno(
                io::Error::last_os_error(),
                "Could not inspect profile file",
            ));
        }
        if metadata.st_mode & libc::S_IFMT != libc::S_IFREG {
            unsafe { libc::close(fd) };
            return Err("Profile file must be regular".to_string());
        }
        if replace && unsafe { libc::ftruncate(fd, 0) } < 0 {
            unsafe { libc::close(fd) };
            return Err(errno(
                io::Error::last_os_error(),
                "Could not truncate profile file",
            ));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn write(
        root: ProfileFsRoot,
        relative_path: &str,
        source_path: &str,
        replace: bool,
    ) -> Result<(), String> {
        let (parent, leaf) = open_parent(root, relative_path, true)?;
        let mut source = source_file(source_path)?;
        let mut target = open_target(parent.as_raw_fd(), &leaf, replace)?;
        let result = io::copy(&mut source, &mut target)
            .and_then(|_| target.flush())
            .and_then(|_| target.sync_all());
        if let Err(error) = result {
            return Err(errno(error, "Could not write profile file"));
        }
        drop(target);
        sync_directory(&parent)
    }

    #[cfg(target_os = "linux")]
    unsafe fn rename_no_replace(
        source_parent: RawFd,
        source: &CStr,
        destination_parent: RawFd,
        destination: &CStr,
    ) -> i32 {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent,
            source.as_ptr(),
            destination_parent,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        ) as i32
    }

    #[cfg(target_os = "macos")]
    unsafe fn rename_no_replace(
        source_parent: RawFd,
        source: &CStr,
        destination_parent: RawFd,
        destination: &CStr,
    ) -> i32 {
        libc::renameatx_np(
            source_parent,
            source.as_ptr(),
            destination_parent,
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    unsafe fn rename_no_replace(
        _source_parent: RawFd,
        _source: &CStr,
        _destination_parent: RawFd,
        _destination: &CStr,
    ) -> i32 {
        libc::set_errno(libc::Errno(libc::ENOTSUP));
        -1
    }

    #[cfg(test)]
    static BEFORE_RENAME_HOOK: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> =
        std::sync::Mutex::new(None);
    #[cfg(test)]
    static BEFORE_RESTORE_PROMOTE_HOOK: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> =
        std::sync::Mutex::new(None);
    #[cfg(test)]
    static BEFORE_RESTORE_RENAME_HOOK: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> =
        std::sync::Mutex::new(None);

    fn run_before_rename_test_hook() {
        #[cfg(test)]
        if let Some(hook) = BEFORE_RENAME_HOOK.lock().expect("test hook lock").take() {
            hook();
        }
    }

    fn run_before_restore_promote_test_hook() {
        #[cfg(test)]
        if let Some(hook) = BEFORE_RESTORE_PROMOTE_HOOK
            .lock()
            .expect("restore hook lock")
            .take()
        {
            hook();
        }
    }

    fn run_before_restore_rename_test_hook() {
        #[cfg(test)]
        if let Some(hook) = BEFORE_RESTORE_RENAME_HOOK
            .lock()
            .expect("restore rename hook lock")
            .take()
        {
            hook();
        }
    }

    fn rename(
        root: ProfileFsRoot,
        source_relative_path: &str,
        destination_relative_path: &str,
        replace: bool,
    ) -> Result<(), String> {
        let (source_parent, source) = open_parent(root, source_relative_path, false)?;
        let (destination_parent, destination) =
            open_parent(root, destination_relative_path, false)?;
        run_before_rename_test_hook();
        let result = unsafe {
            if replace {
                libc::renameat(
                    source_parent.as_raw_fd(),
                    source.as_ptr(),
                    destination_parent.as_raw_fd(),
                    destination.as_ptr(),
                )
            } else {
                rename_no_replace(
                    source_parent.as_raw_fd(),
                    &source,
                    destination_parent.as_raw_fd(),
                    &destination,
                )
            }
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if !replace && error.raw_os_error() == Some(libc::EEXIST) {
                return Err("Profile destination already exists".to_string());
            }
            return Err(errno(error, "Could not rename profile file"));
        }
        sync_directory(&source_parent)?;
        if source_parent.as_raw_fd() != destination_parent.as_raw_fd() {
            sync_directory(&destination_parent)?;
        }
        Ok(())
    }

    fn rename_restore_entry(
        parent: &OwnedFd,
        source: &CStr,
        destination: &CStr,
    ) -> Result<(), String> {
        if unsafe { rename_no_replace(parent.as_raw_fd(), source, parent.as_raw_fd(), destination) }
            < 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EEXIST) {
                return Err("Workspace restore destination already exists".to_string());
            }
            return Err(errno(error, "Could not rename workspace restore directory"));
        }
        sync_directory(parent)
    }

    fn open_relative_parent_from_directory(
        mut current: OwnedFd,
        relative_path: &str,
        create: bool,
    ) -> Result<(OwnedFd, CString), String> {
        let components = relative_components(relative_path)?;
        let leaf = c_name(components.last().expect("validated non-empty path"))?;
        for component in &components[..components.len() - 1] {
            let name = c_name(component)?;
            match open_child_dir(current.as_raw_fd(), &name) {
                Ok(next) => current = next,
                Err(error) if create && error.raw_os_error() == Some(libc::ENOENT) => {
                    if unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700) } < 0 {
                        let error = io::Error::last_os_error();
                        if error.raw_os_error() != Some(libc::EEXIST) {
                            return Err(errno(error, "Could not create restore directory"));
                        }
                    }
                    sync_directory(&current)?;
                    current = open_child_dir(current.as_raw_fd(), &name)
                        .map_err(|error| errno(error, "Could not open restore directory"))?;
                }
                Err(error) => return Err(errno(error, "Could not open restore directory")),
            }
        }
        Ok((current, leaf))
    }

    fn restore_authority(token: &str) -> Result<RestoreStageAuthority, String> {
        checked_restore_token(token)?;
        let guard = restore_authority_slot()
            .lock()
            .map_err(|_| "Workspace restore authority lock is poisoned".to_string())?;
        match guard.as_ref() {
            Some(authority) if authority.token == token => Ok(authority.clone()),
            _ => Err("Workspace restore staging authority is unavailable".to_string()),
        }
    }

    fn stage_identity(
        authority: &RestoreStageAuthority,
        root: WorkspaceRestoreRoot,
    ) -> DirectoryIdentity {
        match root {
            WorkspaceRestoreRoot::Config => authority.config,
            WorkspaceRestoreRoot::Media => authority.media,
        }
    }

    fn clear_restore_authority(token: &str) -> Result<(), String> {
        let mut guard = restore_authority_slot()
            .lock()
            .map_err(|_| "Workspace restore authority lock is poisoned".to_string())?;
        if guard
            .as_ref()
            .is_some_and(|authority| authority.token == token)
        {
            *guard = None;
        }
        Ok(())
    }

    fn prepare_workspace_restore_with_roots(
        token: &str,
        roots: &ProfileFsRoots,
    ) -> Result<RestoreStageAuthority, String> {
        checked_restore_token(token)?;
        if roots.config.canonical_path == roots.media.canonical_path
            || roots
                .config
                .canonical_path
                .starts_with(&roots.media.canonical_path)
            || roots
                .media
                .canonical_path
                .starts_with(&roots.config.canonical_path)
        {
            return Err("Config and media restore roots must not overlap".to_string());
        }
        let protected = [
            &roots.profile,
            &roots.data,
            &roots.pglite,
            &roots.models,
            &roots.runtime,
            &roots.logs,
        ];
        for restore_root in [&roots.config, &roots.media] {
            if protected.iter().any(|resource| {
                resource
                    .canonical_path
                    .starts_with(&restore_root.canonical_path)
            }) {
                return Err(
                    "Workspace restore root must not contain a protected profile resource"
                        .to_string(),
                );
            }
        }
        let mut prepared = Vec::new();
        for root in [WorkspaceRestoreRoot::Media, WorkspaceRestoreRoot::Config] {
            let paths = restore_root_paths(root, token, roots)?;
            let parent = open_restore_parent(&paths, roots)?;
            require_directory_identity(
                parent.as_raw_fd(),
                &paths.live,
                paths.selected.identity,
                "Workspace restore live root",
            )?;
            for residue in [&paths.staged, &paths.previous, &paths.discarded] {
                if directory_entry_identity(parent.as_raw_fd(), residue)?.is_some() {
                    return Err("Workspace restore target already exists".to_string());
                }
            }
            prepared.push((root, parent, paths.staged));
        }

        let mut created: Vec<(OwnedFd, CString)> = Vec::new();
        let creation = (|| -> Result<RestoreStageAuthority, String> {
            let mut identities = Vec::new();
            for (root, parent, staged) in prepared {
                if unsafe { libc::mkdirat(parent.as_raw_fd(), staged.as_ptr(), 0o700) } < 0 {
                    return Err(errno(
                        io::Error::last_os_error(),
                        "Could not create workspace restore staging root",
                    ));
                }
                created.push((parent, staged));
                let (created_parent, created_stage) = created
                    .last()
                    .expect("created workspace restore staging root");
                sync_directory(created_parent)?;
                let identity = directory_entry_identity(created_parent.as_raw_fd(), created_stage)?
                    .ok_or_else(|| "Workspace restore staging root disappeared".to_string())?;
                identities.push((root, identity));
            }
            let media = identities
                .iter()
                .find(|(root, _)| *root == WorkspaceRestoreRoot::Media)
                .map(|(_, identity)| *identity)
                .ok_or_else(|| "Media restore staging identity is missing".to_string())?;
            let config = identities
                .iter()
                .find(|(root, _)| *root == WorkspaceRestoreRoot::Config)
                .map(|(_, identity)| *identity)
                .ok_or_else(|| "Config restore staging identity is missing".to_string())?;
            Ok(RestoreStageAuthority {
                token: token.to_string(),
                config,
                media,
                config_original: roots.config.identity,
                media_original: roots.media.identity,
            })
        })();
        if creation.is_err() {
            for (created_parent, created_leaf) in created.into_iter().rev() {
                unsafe {
                    libc::unlinkat(
                        created_parent.as_raw_fd(),
                        created_leaf.as_ptr(),
                        libc::AT_REMOVEDIR,
                    );
                }
                let _ = sync_directory(&created_parent);
            }
        }
        creation
    }

    fn prepare_workspace_restore(
        token: &str,
        originals: RestoreOriginalIdentities,
    ) -> Result<(), String> {
        let mut guard = restore_authority_slot()
            .lock()
            .map_err(|_| "Workspace restore authority lock is poisoned".to_string())?;
        if guard.is_some() {
            return Err("Another workspace restore staging authority is active".to_string());
        }
        let roots = current_roots()?;
        if roots.config.identity != originals.config || roots.media.identity != originals.media {
            return Err("Workspace restore live root identity changed".to_string());
        }
        let authority = prepare_workspace_restore_with_roots(token, &roots)?;
        *guard = Some(authority);
        Ok(())
    }

    fn attest_workspace_restore_stages(
        token: &str,
        staged: RestoreStagedIdentities,
    ) -> Result<(), String> {
        checked_restore_token(token)?;
        let roots = current_roots()?;
        let authority = restore_authority(token)?;
        for root in [WorkspaceRestoreRoot::Media, WorkspaceRestoreRoot::Config] {
            let paths = restore_root_paths(root, token, &roots)?;
            let parent = open_restore_parent(&paths, &roots)?;
            let durable = expected_staged_identity(&staged, root);
            if durable != stage_identity(&authority, root) {
                return Err(
                    "Workspace restore staged identity changed before attestation".to_string(),
                );
            }
            require_directory_identity(
                parent.as_raw_fd(),
                &paths.staged,
                durable,
                "Workspace restore staging root",
            )?;
        }
        Ok(())
    }

    fn open_authorized_stage(
        token: &str,
        root: WorkspaceRestoreRoot,
        roots: &ProfileFsRoots,
        authority: &RestoreStageAuthority,
    ) -> Result<OwnedFd, String> {
        let paths = restore_root_paths(root, token, roots)?;
        let parent = open_restore_parent(&paths, roots)?;
        require_directory_identity(
            parent.as_raw_fd(),
            &paths.staged,
            stage_identity(authority, root),
            "Workspace restore staging root",
        )?;
        open_child_dir(parent.as_raw_fd(), &paths.staged)
            .map_err(|error| errno(error, "Could not open workspace restore staging root"))
    }

    fn write_workspace_restore_file_with(
        token: &str,
        root: WorkspaceRestoreRoot,
        relative_path: &str,
        source_path: &str,
        roots: &ProfileFsRoots,
        authority: &RestoreStageAuthority,
    ) -> Result<(), String> {
        let stage = open_authorized_stage(token, root, roots, authority)?;
        let (parent, leaf) = open_relative_parent_from_directory(stage, relative_path, true)?;
        let mut source = source_file(source_path)?;
        let mut target = open_target(parent.as_raw_fd(), &leaf, false)?;
        io::copy(&mut source, &mut target)
            .and_then(|_| target.flush())
            .and_then(|_| target.sync_all())
            .map_err(|error| errno(error, "Could not write workspace restore file"))?;
        drop(target);
        sync_directory(&parent)
    }

    fn write_workspace_restore_file(
        token: &str,
        root: WorkspaceRestoreRoot,
        relative_path: &str,
        source_path: &str,
    ) -> Result<(), String> {
        let roots = current_roots()?;
        let authority = restore_authority(token)?;
        write_workspace_restore_file_with(
            token,
            root,
            relative_path,
            source_path,
            &roots,
            &authority,
        )
    }

    fn seal_workspace_restore_root(token: &str, root: WorkspaceRestoreRoot) -> Result<(), String> {
        let roots = current_roots()?;
        let authority = restore_authority(token)?;
        let stage = open_authorized_stage(token, root, &roots, &authority)?;
        sync_directory(&stage)
    }

    struct PreparedRestoreRoot {
        root: WorkspaceRestoreRoot,
        parent: OwnedFd,
        live: CString,
        staged: CString,
        previous: CString,
        discarded: CString,
        selected_identity: DirectoryIdentity,
    }

    fn prepared_restore_root(
        root: WorkspaceRestoreRoot,
        token: &str,
        roots: &ProfileFsRoots,
    ) -> Result<PreparedRestoreRoot, String> {
        let paths = restore_root_paths(root, token, roots)?;
        let parent = open_restore_parent(&paths, roots)?;
        Ok(PreparedRestoreRoot {
            root,
            parent,
            live: paths.live,
            staged: paths.staged,
            previous: paths.previous,
            discarded: paths.discarded,
            selected_identity: paths.selected.identity,
        })
    }

    fn refresh_restore_roots(roots: &mut ProfileFsRoots) -> Result<(), String> {
        let config = prepared_restore_root(WorkspaceRestoreRoot::Config, "refresh-ok", roots)?;
        let media = prepared_restore_root(WorkspaceRestoreRoot::Media, "refresh-ok", roots)?;
        let config_descriptor = open_child_dir(config.parent.as_raw_fd(), &config.live)
            .map_err(|error| errno(error, "Could not open refreshed config root"))?;
        let media_descriptor = open_child_dir(media.parent.as_raw_fd(), &media.live)
            .map_err(|error| errno(error, "Could not open refreshed media root"))?;
        roots.config.identity = descriptor_identity(config_descriptor.as_raw_fd())?;
        roots.media.identity = descriptor_identity(media_descriptor.as_raw_fd())?;
        Ok(())
    }

    fn promote_workspace_restore_roots_with(
        token: &str,
        roots: &mut ProfileFsRoots,
        authority: &RestoreStageAuthority,
    ) -> Result<(), String> {
        let prepared = [
            prepared_restore_root(WorkspaceRestoreRoot::Media, token, roots)?,
            prepared_restore_root(WorkspaceRestoreRoot::Config, token, roots)?,
        ];
        for item in &prepared {
            require_directory_identity(
                item.parent.as_raw_fd(),
                &item.live,
                item.selected_identity,
                "Workspace restore live root",
            )?;
            require_directory_identity(
                item.parent.as_raw_fd(),
                &item.staged,
                stage_identity(authority, item.root),
                "Workspace restore staging root",
            )?;
            for residue in [&item.previous, &item.discarded] {
                if directory_entry_identity(item.parent.as_raw_fd(), residue)?.is_some() {
                    return Err(
                        "Workspace restore promotion destination already exists".to_string()
                    );
                }
            }
        }
        run_before_restore_promote_test_hook();
        // Revalidate every live/staged leaf after the final injected seam and
        // immediately before the first rename. A replacement cannot turn a
        // fully preflighted pair into a partially authorized swap.
        for item in &prepared {
            require_directory_identity(
                item.parent.as_raw_fd(),
                &item.live,
                item.selected_identity,
                "Workspace restore live root",
            )?;
            require_directory_identity(
                item.parent.as_raw_fd(),
                &item.staged,
                stage_identity(authority, item.root),
                "Workspace restore staging root",
            )?;
        }
        for item in &prepared {
            run_before_restore_rename_test_hook();
            rename_restore_entry(&item.parent, &item.live, &item.previous)?;
            require_directory_identity(
                item.parent.as_raw_fd(),
                &item.previous,
                item.selected_identity,
                "Workspace restore previous root",
            )?;
            rename_restore_entry(&item.parent, &item.staged, &item.live)?;
            require_directory_identity(
                item.parent.as_raw_fd(),
                &item.live,
                stage_identity(authority, item.root),
                "Workspace restore promoted root",
            )?;
        }
        refresh_restore_roots(roots)
    }

    fn promote_workspace_restore_roots(token: &str) -> Result<(), String> {
        let authority = restore_authority(token)?;
        let mut roots = current_roots()?;
        let result = promote_workspace_restore_roots_with(token, &mut roots, &authority);
        if result.is_err() {
            if refresh_restore_roots(&mut roots).is_ok() {
                let _ = publish_roots(roots);
            }
            return result;
        }
        publish_roots(roots)?;
        Ok(())
    }

    fn directory_names(directory: &OwnedFd) -> Result<Vec<CString>, String> {
        let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
        if duplicate < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not duplicate restore directory descriptor",
            ));
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            unsafe { libc::close(duplicate) };
            return Err(errno(
                io::Error::last_os_error(),
                "Could not enumerate restore directory",
            ));
        }
        let mut names = Vec::new();
        loop {
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            names.push(name.to_owned());
        }
        if unsafe { libc::closedir(stream) } < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not close restore directory enumeration",
            ));
        }
        Ok(names)
    }

    fn directory_entry_is_empty(
        parent: &OwnedFd,
        leaf: &CStr,
        expected: Option<DirectoryIdentity>,
    ) -> Result<bool, String> {
        let directory = match open_child_dir(parent.as_raw_fd(), leaf) {
            Ok(directory) => directory,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(false),
            Err(error) => return Err(errno(error, "Restore placeholder is not a real directory")),
        };
        let identity = descriptor_identity(directory.as_raw_fd())?;
        if expected.is_some_and(|value| value != identity) {
            return Err("Restore placeholder identity changed; preserving replacement".to_string());
        }
        Ok(directory_names(&directory)?.is_empty())
    }

    fn remove_empty_directory_at(parent: &OwnedFd, leaf: &CStr) -> Result<(), String> {
        let directory = match open_child_dir(parent.as_raw_fd(), leaf) {
            Ok(directory) => directory,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
            Err(error) => return Err(errno(error, "Restore placeholder is not a real directory")),
        };
        let identity = descriptor_identity(directory.as_raw_fd())?;
        if !directory_names(&directory)?.is_empty() {
            return Err("Restore placeholder is not empty; preserving replacement".to_string());
        }
        drop(directory);
        require_directory_identity(parent.as_raw_fd(), leaf, identity, "Restore placeholder")?;
        if unsafe { libc::unlinkat(parent.as_raw_fd(), leaf.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not remove restore placeholder",
            ));
        }
        sync_directory(parent)
    }

    fn remove_tree_at(
        parent: &OwnedFd,
        leaf: &CStr,
        expected: Option<DirectoryIdentity>,
    ) -> Result<(), String> {
        let directory = match open_child_dir(parent.as_raw_fd(), leaf) {
            Ok(directory) => directory,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
            Err(error) => {
                return Err(errno(
                    error,
                    "Restore cleanup target is not a real directory",
                ))
            }
        };
        let opened_identity = descriptor_identity(directory.as_raw_fd())?;
        if expected.is_some_and(|identity| identity != opened_identity) {
            return Err(
                "Restore cleanup root identity changed; preserving replacement".to_string(),
            );
        }
        for name in directory_names(&directory)? {
            let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    &mut metadata,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } < 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ENOENT) {
                    continue;
                }
                return Err(errno(error, "Could not inspect restore cleanup entry"));
            }
            if metadata.st_mode & libc::S_IFMT == libc::S_IFDIR {
                remove_tree_at(&directory, &name, None)?;
            } else if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } < 0 {
                return Err(errno(
                    io::Error::last_os_error(),
                    "Could not remove restore cleanup file",
                ));
            }
        }
        sync_directory(&directory)?;
        drop(directory);
        require_directory_identity(
            parent.as_raw_fd(),
            leaf,
            opened_identity,
            "Restore cleanup root",
        )?;
        if unsafe { libc::unlinkat(parent.as_raw_fd(), leaf.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not remove restore cleanup directory",
            ));
        }
        sync_directory(parent)
    }

    fn cleanup_restore_residue(
        token: &str,
        roots: &ProfileFsRoots,
        include_previous: bool,
        staged: Option<&RestoreStagedIdentities>,
        originals: Option<&RestoreOriginalIdentities>,
    ) -> Result<(), String> {
        for root in [WorkspaceRestoreRoot::Media, WorkspaceRestoreRoot::Config] {
            let item = prepared_restore_root(root, token, roots)?;
            if let Some(staged) = staged {
                remove_tree_at(
                    &item.parent,
                    &item.staged,
                    Some(expected_staged_identity(staged, root)),
                )?;
            } else {
                remove_empty_directory_at(&item.parent, &item.staged)?;
            }
            remove_empty_directory_at(&item.parent, &item.discarded)?;
            if include_previous {
                remove_tree_at(
                    &item.parent,
                    &item.previous,
                    originals.map(|value| expected_original_identity(value, root)),
                )?;
            }
        }
        Ok(())
    }

    fn rollback_workspace_restore_roots_with(
        token: &str,
        roots: &mut ProfileFsRoots,
        authority: Option<&RestoreStageAuthority>,
        originals: &RestoreOriginalIdentities,
        staged: Option<&RestoreStagedIdentities>,
    ) -> Result<(), String> {
        if authority.is_some_and(|value| {
            value.config_original != originals.config || value.media_original != originals.media
        }) {
            return Err("Workspace restore durable root identity changed".to_string());
        }
        if let (Some(authority), Some(staged)) = (authority, staged) {
            if authority.config != staged.config || authority.media != staged.media {
                return Err("Workspace restore durable staged identity changed".to_string());
            }
        }
        // Validate both roots and all token-derived leaves before the first
        // rename. A statically corrupt media previous tree must not partially
        // roll config back into an avoidable old/new split.
        for root in [WorkspaceRestoreRoot::Config, WorkspaceRestoreRoot::Media] {
            let item = prepared_restore_root(root, token, roots)?;
            let previous = directory_entry_identity(item.parent.as_raw_fd(), &item.previous)?;
            let live = directory_entry_identity(item.parent.as_raw_fd(), &item.live)?;
            let stage_entry = directory_entry_identity(item.parent.as_raw_fd(), &item.staged)?;
            let discarded = directory_entry_identity(item.parent.as_raw_fd(), &item.discarded)?;
            if let Some(durable_staged) = staged {
                let expected_stage = expected_staged_identity(durable_staged, root);
                if stage_entry.is_some_and(|identity| identity != expected_stage) {
                    return Err(
                        "Workspace restore staged root identity changed during rollback"
                            .to_string(),
                    );
                }
                if discarded.is_some()
                    && !directory_entry_is_empty(&item.parent, &item.discarded, discarded)?
                {
                    return Err(
                        "Workspace restore discarded root is not empty during rollback".to_string(),
                    );
                }
                if let Some(previous_identity) = previous {
                    if previous_identity != expected_original_identity(originals, root) {
                        return Err(
                            "Workspace restore previous root identity changed during rollback"
                                .to_string(),
                        );
                    }
                    if let Some(live_identity) = live {
                        let is_promoted = live_identity == expected_stage;
                        let is_empty_restart_placeholder = stage_entry == Some(expected_stage)
                            && directory_entry_is_empty(
                                &item.parent,
                                &item.live,
                                Some(live_identity),
                            )?;
                        if !is_promoted && !is_empty_restart_placeholder {
                            return Err(
                                "Workspace restore live root identity changed during rollback"
                                    .to_string(),
                            );
                        }
                        if is_promoted && stage_entry.is_some() {
                            return Err(
                                "Workspace restore rollback staging destination already exists"
                                    .to_string(),
                            );
                        }
                    }
                } else {
                    if live != Some(expected_original_identity(originals, root)) {
                        return Err(
                            "Workspace restore live root identity changed during rollback"
                                .to_string(),
                        );
                    }
                }
            } else {
                if previous.is_some() || discarded.is_some() {
                    return Err("Unattested workspace restore has promoted residue".to_string());
                }
                if live != Some(expected_original_identity(originals, root)) {
                    return Err(
                        "Unattested workspace restore live root identity changed".to_string()
                    );
                }
                if stage_entry.is_some()
                    && !directory_entry_is_empty(&item.parent, &item.staged, stage_entry)?
                {
                    return Err(
                        "Unattested workspace restore stage is not empty; preserving it"
                            .to_string(),
                    );
                }
            }
        }
        for root in [WorkspaceRestoreRoot::Config, WorkspaceRestoreRoot::Media] {
            let item = prepared_restore_root(root, token, roots)?;
            let previous = directory_entry_identity(item.parent.as_raw_fd(), &item.previous)?;
            let live = directory_entry_identity(item.parent.as_raw_fd(), &item.live)?;
            let stage_entry = directory_entry_identity(item.parent.as_raw_fd(), &item.staged)?;
            if let Some(previous_identity) = previous {
                if previous_identity != expected_original_identity(originals, root) {
                    return Err(
                        "Workspace restore previous root identity changed during rollback"
                            .to_string(),
                    );
                }
                if let Some(live_identity) = live {
                    let expected_stage = staged
                        .map(|value| expected_staged_identity(value, root))
                        .ok_or_else(|| {
                            "Unattested workspace restore cannot have previous roots".to_string()
                        })?;
                    if live_identity == expected_stage {
                        rename_restore_entry(&item.parent, &item.live, &item.staged)?;
                        require_directory_identity(
                            item.parent.as_raw_fd(),
                            &item.staged,
                            live_identity,
                            "Workspace restore displaced root",
                        )?;
                    } else {
                        if stage_entry != Some(expected_stage)
                            || !directory_entry_is_empty(
                                &item.parent,
                                &item.live,
                                Some(live_identity),
                            )?
                        {
                            return Err(
                                "Workspace restore live root identity changed during rollback"
                                    .to_string(),
                            );
                        }
                        if directory_entry_identity(item.parent.as_raw_fd(), &item.discarded)?
                            .is_some()
                        {
                            // A prior rollback attempt may already have moved
                            // the first startup placeholder aside before
                            // crashing. Never overwrite it; remove only the
                            // newly recreated, still-empty live placeholder.
                            remove_empty_directory_at(&item.parent, &item.live)?;
                        } else {
                            rename_restore_entry(&item.parent, &item.live, &item.discarded)?;
                            require_directory_identity(
                                item.parent.as_raw_fd(),
                                &item.discarded,
                                live_identity,
                                "Workspace restore displaced root",
                            )?;
                        }
                    }
                }
                rename_restore_entry(&item.parent, &item.previous, &item.live)?;
                require_directory_identity(
                    item.parent.as_raw_fd(),
                    &item.live,
                    expected_original_identity(originals, root),
                    "Workspace restore rolled-back root",
                )?;
            } else if live.is_none() {
                return Err("Workspace restore root is missing during rollback".to_string());
            }
        }
        refresh_restore_roots(roots)?;
        cleanup_restore_residue(token, roots, true, staged, Some(originals))
    }

    fn rollback_workspace_restore_roots(
        token: &str,
        originals: RestoreOriginalIdentities,
        staged: Option<RestoreStagedIdentities>,
    ) -> Result<(), String> {
        checked_restore_token(token)?;
        let mut roots = current_roots()?;
        let authority = restore_authority(token).ok();
        rollback_workspace_restore_roots_with(
            token,
            &mut roots,
            authority.as_ref(),
            &originals,
            staged.as_ref(),
        )?;
        publish_roots(roots)?;
        clear_restore_authority(token)
    }

    fn cleanup_workspace_restore(
        token: &str,
        originals: RestoreOriginalIdentities,
        staged: Option<RestoreStagedIdentities>,
    ) -> Result<(), String> {
        checked_restore_token(token)?;
        let staged = staged.ok_or_else(|| {
            "Committed workspace restore is missing staged identities".to_string()
        })?;
        let roots = current_roots()?;
        validate_promoted_restore_roots(token, &roots, &staged)?;
        for root in [WorkspaceRestoreRoot::Media, WorkspaceRestoreRoot::Config] {
            let item = prepared_restore_root(root, token, &roots)?;
            if let Some(stage_entry) =
                directory_entry_identity(item.parent.as_raw_fd(), &item.staged)?
            {
                if stage_entry != expected_staged_identity(&staged, root) {
                    return Err(
                        "Workspace restore staged root identity changed during cleanup".to_string(),
                    );
                }
            }
            if let Some(discarded) =
                directory_entry_identity(item.parent.as_raw_fd(), &item.discarded)?
            {
                if !directory_entry_is_empty(&item.parent, &item.discarded, Some(discarded))? {
                    return Err(
                        "Workspace restore discarded root is not empty during cleanup".to_string(),
                    );
                }
            }
            if let Some(previous) =
                directory_entry_identity(item.parent.as_raw_fd(), &item.previous)?
            {
                if previous != expected_original_identity(&originals, root) {
                    return Err(
                        "Workspace restore previous root identity changed during cleanup"
                            .to_string(),
                    );
                }
            }
        }
        cleanup_restore_residue(token, &roots, true, Some(&staged), Some(&originals))?;
        clear_restore_authority(token)
    }

    fn validate_promoted_restore_roots(
        token: &str,
        roots: &ProfileFsRoots,
        staged: &RestoreStagedIdentities,
    ) -> Result<(), String> {
        for root in [WorkspaceRestoreRoot::Media, WorkspaceRestoreRoot::Config] {
            let item = prepared_restore_root(root, token, roots)?;
            require_directory_identity(
                item.parent.as_raw_fd(),
                &item.live,
                expected_staged_identity(staged, root),
                "Workspace restore live root",
            )?;
        }
        Ok(())
    }

    fn refresh_workspace_restore_roots(
        token: &str,
        staged: Option<RestoreStagedIdentities>,
    ) -> Result<(), String> {
        checked_restore_token(token)?;
        let staged = staged.ok_or_else(|| {
            "Committed workspace restore is missing staged identities".to_string()
        })?;
        let mut roots = current_roots()?;
        validate_promoted_restore_roots(token, &roots, &staged)?;
        refresh_restore_roots(&mut roots)?;
        publish_roots(roots)
    }

    fn unlink(root: ProfileFsRoot, relative_path: &str, missing_ok: bool) -> Result<(), String> {
        let (parent, leaf) = open_parent(root, relative_path, false)?;
        let result = unsafe { libc::unlinkat(parent.as_raw_fd(), leaf.as_ptr(), 0) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if !(missing_ok && error.raw_os_error() == Some(libc::ENOENT)) {
                return Err(errno(error, "Could not unlink profile file"));
            }
        }
        sync_directory(&parent)
    }

    fn unlink_external_identity(
        absolute_path: &str,
        expected_device: &str,
        expected_inode: &str,
        expected_size: &str,
        expected_modified_at_ns: &str,
    ) -> Result<(), String> {
        let absolute = Path::new(absolute_path);
        if !absolute.is_absolute() {
            return Err("External unlink path must be absolute".to_string());
        }
        let parent = absolute
            .parent()
            .ok_or_else(|| "External unlink path has no parent".to_string())?
            .canonicalize()
            .map_err(|error| errno(error, "Could not resolve external file parent"))?;
        let leaf = absolute
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "External unlink path has no UTF-8 file name".to_string())?;
        if !leaf.starts_with('.') || !leaf.contains(".lunery-delete-") {
            return Err("External unlink is limited to Lunery deletion staging files".to_string());
        }
        let canonical_target = parent.join(leaf);
        let parent_string = parent
            .to_str()
            .ok_or_else(|| "External file parent must be UTF-8".to_string())?;
        let relative_parent = parent_string.trim_start_matches('/');
        let parent_components = if relative_parent.is_empty() {
            Vec::new()
        } else {
            relative_components(relative_parent)?
        };
        let root = CString::new("/").expect("root CString");
        let root_fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if root_fd < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not open filesystem root",
            ));
        }
        let mut current = unsafe { OwnedFd::from_raw_fd(root_fd) };
        for component in parent_components {
            let name = c_name(&component)?;
            current = open_child_dir(current.as_raw_fd(), &name)
                .map_err(|error| errno(error, "Could not open external file parent"))?;
        }
        let leaf = c_name(leaf)?;
        let file_fd = unsafe {
            libc::openat(
                current.as_raw_fd(),
                leaf.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if file_fd < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not open staged external file",
            ));
        }
        let file = unsafe { OwnedFd::from_raw_fd(file_fd) };
        let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(file.as_raw_fd(), &mut metadata) } < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not inspect staged external file",
            ));
        }
        let expected_device = expected_device
            .parse::<u64>()
            .map_err(|_| "Invalid expected external device".to_string())?;
        let expected_inode = expected_inode
            .parse::<u64>()
            .map_err(|_| "Invalid expected external inode".to_string())?;
        let expected_size = expected_size
            .parse::<u64>()
            .map_err(|_| "Invalid expected external size".to_string())?;
        let expected_modified_at_ns = expected_modified_at_ns
            .parse::<i128>()
            .map_err(|_| "Invalid expected external modification time".to_string())?;
        let modified_at_ns =
            i128::from(metadata.st_mtime) * 1_000_000_000 + i128::from(metadata.st_mtime_nsec);
        if metadata.st_dev as u64 != expected_device
            || metadata.st_ino as u64 != expected_inode
            || metadata.st_size as u64 != expected_size
            || modified_at_ns != expected_modified_at_ns
            || metadata.st_mode & libc::S_IFMT != libc::S_IFREG
        {
            return Err(format!(
                "Staged external file identity changed; preserved {}",
                canonical_target.display()
            ));
        }
        let result = unsafe { libc::unlinkat(current.as_raw_fd(), leaf.as_ptr(), 0) };
        if result < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not unlink staged external file",
            ));
        }
        sync_directory(&current)
    }

    pub(super) fn execute(request: ProfileFsRequest) -> Result<(), String> {
        match request {
            ProfileFsRequest::Mkdir {
                root,
                relative_path,
            } => mkdir(root, &relative_path),
            ProfileFsRequest::Write {
                root,
                relative_path,
                source_path,
                replace,
            } => write(root, &relative_path, &source_path, replace),
            ProfileFsRequest::Rename {
                root,
                source_relative_path,
                destination_relative_path,
                replace,
            } => rename(
                root,
                &source_relative_path,
                &destination_relative_path,
                replace,
            ),
            ProfileFsRequest::Unlink {
                root,
                relative_path,
                missing_ok,
            } => unlink(root, &relative_path, missing_ok),
            ProfileFsRequest::UnlinkExternalIdentity {
                absolute_path,
                expected_device,
                expected_inode,
                expected_size,
                expected_modified_at_ns,
            } => unlink_external_identity(
                &absolute_path,
                &expected_device,
                &expected_inode,
                &expected_size,
                &expected_modified_at_ns,
            ),
            ProfileFsRequest::PrepareWorkspaceRestore {
                token,
                config_original_device,
                config_original_inode,
                media_original_device,
                media_original_inode,
            } => prepare_workspace_restore(
                &token,
                restore_original_identities(
                    &config_original_device,
                    &config_original_inode,
                    &media_original_device,
                    &media_original_inode,
                )?,
            ),
            ProfileFsRequest::WriteWorkspaceRestoreFile {
                token,
                root,
                relative_path,
                source_path,
            } => write_workspace_restore_file(&token, root, &relative_path, &source_path),
            ProfileFsRequest::SealWorkspaceRestoreRoot { token, root } => {
                seal_workspace_restore_root(&token, root)
            }
            ProfileFsRequest::AttestWorkspaceRestoreStages {
                token,
                config_staged_device,
                config_staged_inode,
                media_staged_device,
                media_staged_inode,
            } => attest_workspace_restore_stages(
                &token,
                restore_staged_identities(
                    Some(&config_staged_device),
                    Some(&config_staged_inode),
                    Some(&media_staged_device),
                    Some(&media_staged_inode),
                )?
                .expect("all staged restore identities were provided"),
            ),
            ProfileFsRequest::PromoteWorkspaceRestoreRoots { token } => {
                promote_workspace_restore_roots(&token)
            }
            ProfileFsRequest::RollbackWorkspaceRestoreRoots {
                token,
                config_original_device,
                config_original_inode,
                media_original_device,
                media_original_inode,
                config_staged_device,
                config_staged_inode,
                media_staged_device,
                media_staged_inode,
            } => rollback_workspace_restore_roots(
                &token,
                restore_original_identities(
                    &config_original_device,
                    &config_original_inode,
                    &media_original_device,
                    &media_original_inode,
                )?,
                restore_staged_identities(
                    config_staged_device.as_deref(),
                    config_staged_inode.as_deref(),
                    media_staged_device.as_deref(),
                    media_staged_inode.as_deref(),
                )?,
            ),
            ProfileFsRequest::CleanupWorkspaceRestore {
                token,
                config_original_device,
                config_original_inode,
                media_original_device,
                media_original_inode,
                config_staged_device,
                config_staged_inode,
                media_staged_device,
                media_staged_inode,
            } => cleanup_workspace_restore(
                &token,
                restore_original_identities(
                    &config_original_device,
                    &config_original_inode,
                    &media_original_device,
                    &media_original_inode,
                )?,
                restore_staged_identities(
                    config_staged_device.as_deref(),
                    config_staged_inode.as_deref(),
                    media_staged_device.as_deref(),
                    media_staged_inode.as_deref(),
                )?,
            ),
            ProfileFsRequest::RefreshWorkspaceRestoreRoots {
                token,
                config_staged_device,
                config_staged_inode,
                media_staged_device,
                media_staged_inode,
            } => refresh_workspace_restore_roots(
                &token,
                restore_staged_identities(
                    config_staged_device.as_deref(),
                    config_staged_inode.as_deref(),
                    media_staged_device.as_deref(),
                    media_staged_inode.as_deref(),
                )?,
            ),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            capture_roots, execute, open_relative_parent_from_directory, open_root_with_roots,
            open_target, prepare_workspace_restore_with_roots,
            promote_workspace_restore_roots_with, rollback_workspace_restore_roots_with,
            validate_promoted_restore_roots, write_workspace_restore_file_with, ProfileFsRequest,
            ProfileFsRoot, RestoreOriginalIdentities, RestoreStagedIdentities,
            WorkspaceRestoreRoot, BEFORE_RENAME_HOOK, BEFORE_RESTORE_PROMOTE_HOOK,
            BEFORE_RESTORE_RENAME_HOOK,
        };
        use crate::{profile::ProfileDirs, test_global_lock};
        use std::ffi::CString;
        use std::fs;
        use std::io::{Seek, SeekFrom, Write};
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::symlink;
        use std::os::unix::fs::MetadataExt;
        use std::path::PathBuf;

        fn temp_root(label: &str) -> PathBuf {
            let path = std::env::temp_dir().join(format!(
                "lunery-profile-fs-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ));
            fs::create_dir_all(&path).expect("temp root");
            path
        }

        fn profile_dirs(root: PathBuf) -> ProfileDirs {
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

        fn create_profile(dirs: &ProfileDirs) {
            for directory in [
                &dirs.root,
                &dirs.config,
                &dirs.data,
                &dirs.pglite,
                &dirs.media,
                &dirs.models,
                &dirs.logs,
                &dirs.runtime,
            ] {
                fs::create_dir_all(directory).expect("profile directory");
            }
        }

        fn modified_at_ns(metadata: &fs::Metadata) -> String {
            (i128::from(metadata.mtime()) * 1_000_000_000 + i128::from(metadata.mtime_nsec()))
                .to_string()
        }

        #[test]
        fn no_replace_write_reports_a_stable_destination_collision() {
            let root = temp_root("write-collision");
            let directory = fs::File::open(&root).expect("open fixture directory");
            let leaf = CString::new("workspace.lock").expect("lock name");
            let first =
                open_target(directory.as_raw_fd(), &leaf, false).expect("create first lock");
            first.sync_all().expect("sync first lock");

            let error = open_target(directory.as_raw_fd(), &leaf, false)
                .expect_err("second no-replace write must collide");

            assert_eq!(error, "Profile destination already exists");
            drop(first);
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn captured_profile_root_rejects_an_intermediate_parent_replacement() {
            let fixture = temp_root("parent-replacement");
            let container = fixture.join("container");
            let dirs = profile_dirs(container.join("profile"));
            create_profile(&dirs);
            let roots = capture_roots(&dirs).expect("capture startup roots");

            fs::rename(&container, fixture.join("held")).expect("displace parent");
            let replacement = profile_dirs(container.join("profile"));
            create_profile(&replacement);

            let error = open_root_with_roots(ProfileFsRoot::Models, &roots)
                .expect_err("replaced intermediate parent must fail closed");
            assert!(error.contains("identity changed"));
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn captured_profile_root_rejects_an_intermediate_parent_symlink() {
            let fixture = temp_root("parent-symlink");
            let container = fixture.join("container");
            let dirs = profile_dirs(container.join("profile"));
            create_profile(&dirs);
            let roots = capture_roots(&dirs).expect("capture startup roots");

            let held = fixture.join("held");
            fs::rename(&container, &held).expect("displace parent");
            symlink(&held, &container).expect("install parent symlink");

            assert!(open_root_with_roots(ProfileFsRoot::Models, &roots).is_err());
            let _ = fs::remove_file(container);
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn reset_requires_an_atomic_root_identity_recapture() {
            let fixture = temp_root("reset-recapture");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            let before_reset = capture_roots(&dirs).expect("capture startup roots");

            fs::remove_dir_all(&dirs.data).expect("remove reset data");
            fs::create_dir_all(&dirs.pglite).expect("recreate pglite");
            fs::create_dir_all(&dirs.media).expect("recreate media");

            assert!(open_root_with_roots(ProfileFsRoot::Media, &before_reset).is_err());
            let after_reset = capture_roots(&dirs).expect("capture replacement roots");
            assert!(open_root_with_roots(ProfileFsRoot::Media, &after_reset).is_ok());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn restore_promotion_rejects_a_live_root_replaced_at_the_final_seam() {
            let _g = test_global_lock();
            let fixture = temp_root("restore-root-seam");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            let mut roots = capture_roots(&dirs).expect("capture startup roots");
            let token = "restore-root-seam-token";
            let authority =
                prepare_workspace_restore_with_roots(token, &roots).expect("prepare restore");

            let media = dirs.media.clone();
            let held = dirs.data.join("media-held");
            *BEFORE_RESTORE_PROMOTE_HOOK
                .lock()
                .expect("restore hook lock") = Some(Box::new(move || {
                fs::rename(&media, &held).expect("move pinned media root");
                fs::create_dir(&media).expect("install replacement media root");
            }));

            let error = promote_workspace_restore_roots_with(token, &mut roots, &authority)
                .expect_err("replacement must fail closed before any root move");
            assert!(error.contains("identity changed"));
            assert!(!dirs
                .data
                .join(format!(".media.restore-previous-{token}"))
                .exists());
            assert!(!dirs
                .root
                .join(format!(".config.restore-previous-{token}"))
                .exists());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn restore_promotion_rejects_identity_moved_after_the_final_check() {
            let _g = test_global_lock();
            let fixture = temp_root("restore-rename-seam");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            let mut roots = capture_roots(&dirs).expect("capture startup roots");
            let token = "restore-rename-seam-token";
            let authority =
                prepare_workspace_restore_with_roots(token, &roots).expect("prepare restore");
            let media = dirs.media.clone();
            let held = dirs.data.join("media-held-after-check");
            *BEFORE_RESTORE_RENAME_HOOK
                .lock()
                .expect("restore rename hook lock") = Some(Box::new(move || {
                fs::rename(&media, &held).expect("move root after final check");
                fs::create_dir(&media).expect("install replacement after final check");
            }));

            let error = promote_workspace_restore_roots_with(token, &mut roots, &authority)
                .expect_err("post-rename identity mismatch must fail closed");
            assert!(error.contains("identity changed"));
            assert!(dirs
                .data
                .join(format!(".media.restore-previous-{token}"))
                .is_dir());
            assert!(!dirs
                .root
                .join(format!(".config.restore-previous-{token}"))
                .exists());
            let rollback = rollback_workspace_restore_roots_with(
                token,
                &mut roots,
                Some(&authority),
                &RestoreOriginalIdentities {
                    config: authority.config_original,
                    media: authority.media_original,
                },
                Some(&RestoreStagedIdentities {
                    config: authority.config,
                    media: authority.media,
                }),
            )
            .expect_err("rollback must not adopt the moved replacement");
            assert!(rollback.contains("previous root identity changed"));
            assert!(dirs
                .data
                .join(format!(".media.restore-previous-{token}"))
                .is_dir());
            assert!(dirs
                .data
                .join(format!(".media.restore-stage-{token}"))
                .is_dir());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn restore_promotion_rejects_a_staging_symlink_at_the_final_seam() {
            let _g = test_global_lock();
            let fixture = temp_root("restore-stage-seam");
            let outside = temp_root("restore-stage-outside");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            let mut roots = capture_roots(&dirs).expect("capture startup roots");
            let token = "restore-stage-seam-token";
            let authority =
                prepare_workspace_restore_with_roots(token, &roots).expect("prepare restore");
            let staged = dirs.data.join(format!(".media.restore-stage-{token}"));
            let held = dirs.data.join("held-stage");
            let staged_for_hook = staged.clone();
            let outside_for_hook = outside.clone();
            *BEFORE_RESTORE_PROMOTE_HOOK
                .lock()
                .expect("restore hook lock") = Some(Box::new(move || {
                fs::rename(&staged_for_hook, &held).expect("move authorized stage");
                symlink(&outside_for_hook, &staged_for_hook).expect("replace stage with symlink");
            }));

            let error = promote_workspace_restore_roots_with(token, &mut roots, &authority)
                .expect_err("staging symlink must fail closed");
            assert!(error.contains("real directory"));
            assert!(!outside.join("escaped").exists());
            assert!(dirs.media.exists());
            fs::remove_file(staged).expect("remove test symlink");
            let _ = fs::remove_dir_all(fixture);
            let _ = fs::remove_dir_all(outside);
        }

        #[test]
        fn restore_rejects_overlapping_config_and_media_before_staging() {
            let fixture = temp_root("restore-overlap");
            let mut dirs = profile_dirs(fixture.join("profile"));
            dirs.media = dirs.config.join("media");
            create_profile(&dirs);
            let roots = capture_roots(&dirs).expect("capture overlapping roots");
            let token = "restore-overlap-token";

            let error = prepare_workspace_restore_with_roots(token, &roots)
                .expect_err("overlapping roots must fail before mkdir");
            assert!(error.contains("must not overlap"));
            assert!(!dirs
                .root
                .join(format!(".config.restore-stage-{token}"))
                .exists());
            assert!(!dirs
                .config
                .join(format!(".media.restore-stage-{token}"))
                .exists());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn restore_rejects_media_that_would_swap_the_database_parent() {
            let fixture = temp_root("restore-media-data");
            let mut dirs = profile_dirs(fixture.join("profile"));
            dirs.media = dirs.data.clone();
            create_profile(&dirs);
            let roots = capture_roots(&dirs).expect("capture media=data roots");
            let token = "restore-media-data-token";

            let error = prepare_workspace_restore_with_roots(token, &roots)
                .expect_err("media=data must fail before staging");
            assert!(error.contains("protected profile resource"));
            assert!(!dirs
                .root
                .join(format!(".data.restore-stage-{token}"))
                .exists());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn restore_rejects_config_that_would_swap_the_profile_root() {
            let fixture = temp_root("restore-config-profile");
            let mut dirs = profile_dirs(fixture.join("profile"));
            dirs.config = dirs.root.clone();
            create_profile(&dirs);
            let roots = capture_roots(&dirs).expect("capture config=profile roots");
            let token = "restore-config-profile-token";

            let error = prepare_workspace_restore_with_roots(token, &roots)
                .expect_err("config=profile must fail before staging");
            assert!(error.contains("must not overlap") || error.contains("protected profile"));
            assert!(!fixture
                .join(format!(".profile.restore-stage-{token}"))
                .exists());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn successful_restore_refreshes_roots_for_followup_native_writes() {
            let fixture = temp_root("restore-refresh");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            fs::write(dirs.media.join("old.txt"), b"old media").expect("old media");
            fs::write(dirs.config.join("old.json"), b"old config").expect("old config");
            let mut roots = capture_roots(&dirs).expect("capture startup roots");
            let token = "restore-refresh-token";
            let authority =
                prepare_workspace_restore_with_roots(token, &roots).expect("prepare restore");
            let media_source = fixture.join("media-source");
            let config_source = fixture.join("config-source");
            fs::write(&media_source, b"new media").expect("media source");
            fs::write(&config_source, b"new config").expect("config source");
            write_workspace_restore_file_with(
                token,
                WorkspaceRestoreRoot::Media,
                "generated/new.txt",
                media_source.to_str().expect("media source UTF-8"),
                &roots,
                &authority,
            )
            .expect("stage media through native boundary");
            write_workspace_restore_file_with(
                token,
                WorkspaceRestoreRoot::Config,
                "new.json",
                config_source.to_str().expect("config source UTF-8"),
                &roots,
                &authority,
            )
            .expect("stage config through native boundary");

            promote_workspace_restore_roots_with(token, &mut roots, &authority)
                .expect("promote and refresh roots");
            let media =
                open_root_with_roots(ProfileFsRoot::Media, &roots).expect("refreshed media pin");
            let (parent, leaf) =
                open_relative_parent_from_directory(media, "generated/after.txt", true)
                    .expect("followup parent");
            let mut target =
                open_target(parent.as_raw_fd(), &leaf, false).expect("followup native target");
            target.write_all(b"after restore").expect("followup write");
            target.sync_all().expect("followup sync");

            assert_eq!(
                fs::read(dirs.media.join("generated/new.txt")).expect("promoted media"),
                b"new media"
            );
            assert_eq!(
                fs::read(dirs.media.join("generated/after.txt")).expect("followup media"),
                b"after restore"
            );
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn rollback_recovers_every_native_promotion_crash_phase() {
            for phase in ["media-moved", "config-moved", "fully-promoted"] {
                let fixture = temp_root(&format!("restore-rollback-{phase}"));
                let dirs = profile_dirs(fixture.join("profile"));
                create_profile(&dirs);
                fs::write(dirs.media.join("old.txt"), b"old media").expect("old media");
                fs::write(dirs.config.join("old.json"), b"old config").expect("old config");
                let mut roots = capture_roots(&dirs).expect("capture startup roots");
                let token = format!("restore-rollback-{phase}-token");
                let authority = prepare_workspace_restore_with_roots(&token, &roots)
                    .expect("prepare restore stages");
                let media_stage = dirs.data.join(format!(".media.restore-stage-{token}"));
                let media_previous = dirs.data.join(format!(".media.restore-previous-{token}"));
                let config_stage = dirs.root.join(format!(".config.restore-stage-{token}"));
                let config_previous = dirs.root.join(format!(".config.restore-previous-{token}"));
                fs::write(media_stage.join("new.txt"), b"new media").expect("stage media");
                fs::write(config_stage.join("new.json"), b"new config").expect("stage config");

                match phase {
                    "media-moved" => {
                        fs::rename(&dirs.media, &media_previous).expect("media live to previous");
                    }
                    "config-moved" => {
                        fs::rename(&dirs.media, &media_previous).expect("media live to previous");
                        fs::rename(&media_stage, &dirs.media).expect("promote media");
                        fs::rename(&dirs.config, &config_previous)
                            .expect("config live to previous");
                    }
                    "fully-promoted" => {
                        promote_workspace_restore_roots_with(&token, &mut roots, &authority)
                            .expect("full promotion");
                    }
                    _ => unreachable!(),
                }

                rollback_workspace_restore_roots_with(
                    &token,
                    &mut roots,
                    Some(&authority),
                    &RestoreOriginalIdentities {
                        config: authority.config_original,
                        media: authority.media_original,
                    },
                    Some(&RestoreStagedIdentities {
                        config: authority.config,
                        media: authority.media,
                    }),
                )
                .expect("native rollback");
                assert_eq!(
                    fs::read(dirs.media.join("old.txt")).expect("restored media"),
                    b"old media"
                );
                assert_eq!(
                    fs::read(dirs.config.join("old.json")).expect("restored config"),
                    b"old config"
                );
                for residue in [
                    media_stage,
                    media_previous,
                    dirs.data.join(format!(".media.restore-discarded-{token}")),
                    config_stage,
                    config_previous,
                    dirs.root.join(format!(".config.restore-discarded-{token}")),
                ] {
                    assert!(!residue.exists(), "rollback residue: {}", residue.display());
                }

                let media = open_root_with_roots(ProfileFsRoot::Media, &roots)
                    .expect("rollback refreshed media pin");
                let (parent, leaf) =
                    open_relative_parent_from_directory(media, "after-rollback.txt", true)
                        .expect("post-rollback target");
                let mut target = open_target(parent.as_raw_fd(), &leaf, false)
                    .expect("post-rollback native file");
                target.write_all(b"ok").expect("post-rollback write");
                target.sync_all().expect("post-rollback sync");
                assert_eq!(
                    fs::read(dirs.media.join("after-rollback.txt")).expect("post-rollback content"),
                    b"ok"
                );
                let _ = fs::remove_dir_all(fixture);
            }
        }

        #[test]
        fn cold_committed_validation_rejects_a_replaced_promoted_root() {
            let fixture = temp_root("restore-cold-committed-replacement");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            fs::write(dirs.media.join("old.txt"), b"old media").expect("old media");
            fs::write(dirs.config.join("old.json"), b"old config").expect("old config");
            let mut roots = capture_roots(&dirs).expect("capture original roots");
            let token = "restore-cold-committed-replacement-token";
            let authority = prepare_workspace_restore_with_roots(token, &roots)
                .expect("prepare restore stages");
            let staged = RestoreStagedIdentities {
                config: authority.config,
                media: authority.media,
            };
            promote_workspace_restore_roots_with(token, &mut roots, &authority)
                .expect("promote roots");

            fs::remove_dir_all(&dirs.media).expect("remove promoted media");
            fs::create_dir(&dirs.media).expect("install replacement media");
            fs::write(dirs.media.join("replacement.txt"), b"replacement")
                .expect("replacement marker");
            let cold_roots = capture_roots(&dirs).expect("capture cold-start replacement roots");

            let error = validate_promoted_restore_roots(token, &cold_roots, &staged)
                .expect_err("committed replacement must fail closed");
            assert!(error.contains("identity changed"));
            assert_eq!(
                fs::read(dirs.media.join("replacement.txt")).expect("replacement preserved"),
                b"replacement"
            );
            assert!(dirs
                .data
                .join(format!(".media.restore-previous-{token}"))
                .is_dir());
            assert!(dirs
                .root
                .join(format!(".config.restore-previous-{token}"))
                .is_dir());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn cold_uncommitted_rollback_rejects_replacement_before_mutating_other_root() {
            let fixture = temp_root("restore-cold-uncommitted-replacement");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            fs::write(dirs.media.join("old.txt"), b"old media").expect("old media");
            fs::write(dirs.config.join("old.json"), b"old config").expect("old config");
            let mut roots = capture_roots(&dirs).expect("capture original roots");
            let token = "restore-cold-uncommitted-replacement-token";
            let authority = prepare_workspace_restore_with_roots(token, &roots)
                .expect("prepare restore stages");
            fs::write(
                dirs.data
                    .join(format!(".media.restore-stage-{token}/new.txt")),
                b"new media",
            )
            .expect("stage media");
            fs::write(
                dirs.root
                    .join(format!(".config.restore-stage-{token}/new.json")),
                b"new config",
            )
            .expect("stage config");
            promote_workspace_restore_roots_with(token, &mut roots, &authority)
                .expect("promote roots");
            let staged = RestoreStagedIdentities {
                config: authority.config,
                media: authority.media,
            };
            let originals = RestoreOriginalIdentities {
                config: authority.config_original,
                media: authority.media_original,
            };

            fs::remove_dir_all(&dirs.media).expect("remove promoted media");
            fs::create_dir(&dirs.media).expect("install replacement media");
            fs::write(dirs.media.join("replacement.txt"), b"replacement")
                .expect("replacement marker");
            let mut cold_roots =
                capture_roots(&dirs).expect("capture cold-start replacement roots");

            let error = rollback_workspace_restore_roots_with(
                token,
                &mut cold_roots,
                None,
                &originals,
                Some(&staged),
            )
            .expect_err("uncommitted replacement must fail before rollback mutation");
            assert!(error.contains("live root identity changed"));
            assert_eq!(
                fs::read(dirs.config.join("new.json")).expect("config remains promoted"),
                b"new config"
            );
            assert_eq!(
                fs::read(dirs.media.join("replacement.txt")).expect("replacement preserved"),
                b"replacement"
            );
            assert!(dirs
                .root
                .join(format!(".config.restore-previous-{token}/old.json"))
                .is_file());
            assert!(dirs
                .data
                .join(format!(".media.restore-previous-{token}/old.txt"))
                .is_file());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn cold_rollback_accepts_only_an_empty_startup_placeholder() {
            let fixture = temp_root("restore-cold-empty-placeholder");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            fs::write(dirs.media.join("old.txt"), b"old media").expect("old media");
            let roots = capture_roots(&dirs).expect("capture original roots");
            let token = "restore-cold-empty-placeholder-token";
            let authority = prepare_workspace_restore_with_roots(token, &roots)
                .expect("prepare restore stages");
            let previous = dirs.data.join(format!(".media.restore-previous-{token}"));
            fs::rename(&dirs.media, &previous).expect("move media to previous");
            fs::create_dir(&dirs.media).expect("startup creates empty live placeholder");
            let mut cold_roots = capture_roots(&dirs).expect("capture startup placeholder roots");

            rollback_workspace_restore_roots_with(
                token,
                &mut cold_roots,
                None,
                &RestoreOriginalIdentities {
                    config: authority.config_original,
                    media: authority.media_original,
                },
                Some(&RestoreStagedIdentities {
                    config: authority.config,
                    media: authority.media,
                }),
            )
            .expect("empty startup placeholder is recoverable");

            assert_eq!(
                fs::read(dirs.media.join("old.txt")).expect("old media restored"),
                b"old media"
            );
            assert!(!previous.exists());
            assert!(!dirs
                .data
                .join(format!(".media.restore-stage-{token}"))
                .exists());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn cold_rollback_resumes_after_placeholder_was_already_discarded() {
            let fixture = temp_root("restore-cold-discarded-placeholder");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            fs::write(dirs.media.join("old.txt"), b"old media").expect("old media");
            let roots = capture_roots(&dirs).expect("capture original roots");
            let token = "restore-cold-discarded-placeholder-token";
            let authority = prepare_workspace_restore_with_roots(token, &roots)
                .expect("prepare restore stages");
            let previous = dirs.data.join(format!(".media.restore-previous-{token}"));
            let discarded = dirs.data.join(format!(".media.restore-discarded-{token}"));
            fs::rename(&dirs.media, &previous).expect("move media to previous");
            fs::create_dir(&dirs.media).expect("first startup placeholder");
            fs::rename(&dirs.media, &discarded).expect("first rollback discards placeholder");
            fs::create_dir(&dirs.media).expect("second startup placeholder");
            let mut cold_roots = capture_roots(&dirs).expect("capture second startup roots");

            rollback_workspace_restore_roots_with(
                token,
                &mut cold_roots,
                None,
                &RestoreOriginalIdentities {
                    config: authority.config_original,
                    media: authority.media_original,
                },
                Some(&RestoreStagedIdentities {
                    config: authority.config,
                    media: authority.media,
                }),
            )
            .expect("rollback resumes from discarded placeholder");

            assert_eq!(
                fs::read(dirs.media.join("old.txt")).expect("old media restored"),
                b"old media"
            );
            for residue in [
                previous,
                discarded,
                dirs.data.join(format!(".media.restore-stage-{token}")),
                dirs.root.join(format!(".config.restore-stage-{token}")),
            ] {
                assert!(!residue.exists(), "rollback residue: {}", residue.display());
            }
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn cold_rollback_cleans_only_empty_unattested_stages() {
            let fixture = temp_root("restore-cold-unattested-stage");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            let mut roots = capture_roots(&dirs).expect("capture original roots");
            let token = "restore-cold-unattested-stage-token";
            let authority = prepare_workspace_restore_with_roots(token, &roots)
                .expect("prepare empty restore stages");

            rollback_workspace_restore_roots_with(
                token,
                &mut roots,
                None,
                &RestoreOriginalIdentities {
                    config: authority.config_original,
                    media: authority.media_original,
                },
                None,
            )
            .expect("empty unattested stages are safe to remove");

            assert!(!dirs
                .data
                .join(format!(".media.restore-stage-{token}"))
                .exists());
            assert!(!dirs
                .root
                .join(format!(".config.restore-stage-{token}"))
                .exists());
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn rollback_preflights_second_root_collisions_before_mutating_config() {
            let fixture = temp_root("restore-rollback-collision");
            let dirs = profile_dirs(fixture.join("profile"));
            create_profile(&dirs);
            fs::write(dirs.media.join("old.txt"), b"old media").expect("old media");
            fs::write(dirs.config.join("old.json"), b"old config").expect("old config");
            let mut roots = capture_roots(&dirs).expect("capture startup roots");
            let token = "restore-rollback-collision-token";
            let authority =
                prepare_workspace_restore_with_roots(token, &roots).expect("prepare restore");
            let media_stage = dirs.data.join(format!(".media.restore-stage-{token}"));
            let config_stage = dirs.root.join(format!(".config.restore-stage-{token}"));
            fs::write(media_stage.join("new.txt"), b"new media").expect("new media");
            fs::write(config_stage.join("new.json"), b"new config").expect("new config");
            promote_workspace_restore_roots_with(token, &mut roots, &authority)
                .expect("promote roots");
            fs::create_dir(&media_stage).expect("install conflicting stage");
            fs::create_dir(dirs.data.join(format!(".media.restore-discarded-{token}")))
                .expect("install conflicting discard");

            let error = rollback_workspace_restore_roots_with(
                token,
                &mut roots,
                Some(&authority),
                &RestoreOriginalIdentities {
                    config: authority.config_original,
                    media: authority.media_original,
                },
                Some(&RestoreStagedIdentities {
                    config: authority.config,
                    media: authority.media,
                }),
            )
            .expect_err("second-root collision must fail before config rollback");
            assert!(
                error.contains("destination already exists")
                    || error.contains("staged root identity changed")
            );
            assert_eq!(
                fs::read(dirs.config.join("new.json")).expect("config remains promoted"),
                b"new config"
            );
            assert_eq!(
                fs::read(
                    dirs.root
                        .join(format!(".config.restore-previous-{token}/old.json"))
                )
                .expect("config previous remains recoverable"),
                b"old config"
            );
            let _ = fs::remove_dir_all(fixture);
        }

        #[test]
        fn rename_uses_captured_directory_descriptors_across_final_seam_swap() {
            let _g = test_global_lock();
            let profile = temp_root("seam");
            let models = profile.join("models");
            let inside = models.join("runtime");
            let outside = temp_root("outside");
            fs::create_dir_all(&inside).expect("inside");
            fs::create_dir_all(profile.join("config")).expect("config");
            fs::create_dir_all(profile.join("data/pglite")).expect("pglite");
            fs::create_dir_all(profile.join("data/media")).expect("media");
            fs::create_dir_all(profile.join("logs")).expect("logs");
            fs::create_dir_all(profile.join("runtime")).expect("runtime");
            fs::write(inside.join("model.gguf"), b"inside").expect("model");
            std::env::set_var("LUNERY_HOME", &profile);
            std::env::set_var("LUNERY_MODELS_DIR", &models);

            let models_for_hook = models.clone();
            let outside_for_hook = outside.clone();
            *BEFORE_RENAME_HOOK.lock().expect("hook lock") = Some(Box::new(move || {
                fs::rename(
                    models_for_hook.join("runtime"),
                    models_for_hook.join("held"),
                )
                .expect("move captured directory");
                symlink(&outside_for_hook, models_for_hook.join("runtime"))
                    .expect("swap lexical directory");
            }));

            execute(ProfileFsRequest::Rename {
                root: ProfileFsRoot::Models,
                source_relative_path: "runtime/model.gguf".to_string(),
                destination_relative_path: "runtime/model.gguf.staged".to_string(),
                replace: false,
            })
            .expect("descriptor-relative rename");

            assert!(!outside.join("model.gguf.staged").exists());
            assert_eq!(
                fs::read(models.join("held/model.gguf.staged")).expect("held rename"),
                b"inside"
            );
            std::env::remove_var("LUNERY_HOME");
            std::env::remove_var("LUNERY_MODELS_DIR");
            let _ = fs::remove_dir_all(profile);
            let _ = fs::remove_dir_all(outside);
        }

        #[test]
        fn external_unlink_preserves_a_replacement_with_a_different_identity() {
            let root = temp_root("external-replacement");
            let staged = root.join(".model.gguf.lunery-delete-deadbeef-token");
            fs::write(&staged, b"original").expect("original stage");
            let expected = fs::metadata(&staged).expect("original metadata");
            fs::remove_file(&staged).expect("replace unlink");
            fs::write(&staged, b"replacement").expect("replacement stage");

            let result = execute(ProfileFsRequest::UnlinkExternalIdentity {
                absolute_path: staged.display().to_string(),
                expected_device: expected.dev().to_string(),
                expected_inode: expected.ino().to_string(),
                expected_size: expected.size().to_string(),
                expected_modified_at_ns: modified_at_ns(&expected),
            });

            assert!(result.is_err());
            assert_eq!(
                fs::read(&staged).expect("preserved replacement"),
                b"replacement"
            );
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn external_unlink_preserves_same_inode_same_size_modified_content() {
            let root = temp_root("external-in-place-rewrite");
            let staged = root.join(".model.gguf.lunery-delete-deadbeef-token");
            fs::write(&staged, b"original").expect("original stage");
            let expected = fs::metadata(&staged).expect("original metadata");
            std::thread::sleep(std::time::Duration::from_millis(2));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .open(&staged)
                .expect("open in-place replacement");
            file.seek(SeekFrom::Start(0)).expect("rewind");
            file.write_all(b"changed!").expect("same-size rewrite");
            file.sync_all().expect("sync replacement");
            drop(file);
            let changed = fs::metadata(&staged).expect("changed metadata");
            assert_eq!(expected.ino(), changed.ino());
            assert_eq!(expected.size(), changed.size());
            assert_ne!(modified_at_ns(&expected), modified_at_ns(&changed));

            let result = execute(ProfileFsRequest::UnlinkExternalIdentity {
                absolute_path: staged.display().to_string(),
                expected_device: expected.dev().to_string(),
                expected_inode: expected.ino().to_string(),
                expected_size: expected.size().to_string(),
                expected_modified_at_ns: modified_at_ns(&expected),
            });

            assert!(result.is_err());
            assert_eq!(fs::read(&staged).expect("preserved rewrite"), b"changed!");
            let _ = fs::remove_dir_all(root);
        }
    }
}
