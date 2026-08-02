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
    use super::{relative_components, ProfileDirs, ProfileFsRequest, ProfileFsRoot};
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io::{self, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Component, Path, PathBuf};
    use std::sync::{OnceLock, RwLock};

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
        config: CapturedDirectory,
        media: CapturedDirectory,
        models: CapturedDirectory,
        runtime: CapturedDirectory,
    }

    static PROFILE_FS_ROOTS: OnceLock<RwLock<Option<ProfileFsRoots>>> = OnceLock::new();

    fn roots_slot() -> &'static RwLock<Option<ProfileFsRoots>> {
        PROFILE_FS_ROOTS.get_or_init(|| RwLock::new(None))
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
        Ok(ProfileFsRoots {
            profile: capture_directory(&dirs.root)?,
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

    fn run_before_rename_test_hook() {
        #[cfg(test)]
        if let Some(hook) = BEFORE_RENAME_HOOK.lock().expect("test hook lock").take() {
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
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            capture_roots, execute, open_root_with_roots, open_target, ProfileFsRequest,
            ProfileFsRoot, BEFORE_RENAME_HOOK,
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
        fn rename_uses_captured_directory_descriptors_across_final_seam_swap() {
            let _g = test_global_lock();
            let profile = temp_root("seam");
            let models = profile.join("models");
            let inside = models.join("runtime");
            let outside = temp_root("outside");
            fs::create_dir_all(&inside).expect("inside");
            fs::create_dir_all(profile.join("config")).expect("config");
            fs::create_dir_all(profile.join("data/media")).expect("media");
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
