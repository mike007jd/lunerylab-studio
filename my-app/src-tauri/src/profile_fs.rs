use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

use crate::profile::profile_dirs;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProfileFsRoot {
    Media,
    Models,
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
    },
}

fn root_path(root: ProfileFsRoot) -> Result<PathBuf, String> {
    let profile = profile_dirs()?;
    Ok(match root {
        ProfileFsRoot::Media => profile.media,
        ProfileFsRoot::Models => profile.models,
    })
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

#[cfg(unix)]
mod unix {
    use super::{relative_components, root_path, ProfileFsRequest, ProfileFsRoot};
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io::{self, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::path::Path;

    fn c_name(value: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| "Invalid profile-relative path".to_string())
    }

    fn errno(error: io::Error, action: &str) -> String {
        format!("{action}: {error}")
    }

    fn open_root(root: ProfileFsRoot) -> Result<OwnedFd, String> {
        let root = root_path(root)?;
        let root = CString::new(root.as_os_str().as_encoded_bytes())
            .map_err(|_| "Profile root contains a NUL byte".to_string())?;
        let fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not open profile root",
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
            return Err(errno(
                io::Error::last_os_error(),
                "Could not open profile file",
            ));
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
    ) -> Result<(), String> {
        let (source_parent, source) = open_parent(root, source_relative_path, false)?;
        let (destination_parent, destination) =
            open_parent(root, destination_relative_path, false)?;
        run_before_rename_test_hook();
        let result = unsafe {
            rename_no_replace(
                source_parent.as_raw_fd(),
                &source,
                destination_parent.as_raw_fd(),
                &destination,
            )
        };
        if result < 0 {
            return Err(errno(
                io::Error::last_os_error(),
                "Could not rename profile file",
            ));
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
        if metadata.st_dev as u64 != expected_device
            || metadata.st_ino as u64 != expected_inode
            || metadata.st_size as u64 != expected_size
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
            } => rename(root, &source_relative_path, &destination_relative_path),
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
            } => unlink_external_identity(
                &absolute_path,
                &expected_device,
                &expected_inode,
                &expected_size,
            ),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{execute, ProfileFsRequest, ProfileFsRoot, BEFORE_RENAME_HOOK};
        use std::fs;
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

        #[test]
        fn rename_uses_captured_directory_descriptors_across_final_seam_swap() {
            let profile = temp_root("seam");
            let models = profile.join("models");
            let inside = models.join("runtime");
            let outside = temp_root("outside");
            fs::create_dir_all(&inside).expect("inside");
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
            })
            .expect("descriptor-relative rename");

            assert!(!outside.join("model.gguf.staged").exists());
            assert_eq!(
                fs::read(models.join("held/model.gguf.staged")).expect("held rename"),
                b"inside"
            );
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
            });

            assert!(result.is_err());
            assert_eq!(
                fs::read(&staged).expect("preserved replacement"),
                b"replacement"
            );
            let _ = fs::remove_dir_all(root);
        }
    }
}
