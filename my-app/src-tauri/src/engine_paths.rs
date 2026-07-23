use std::path::{Path, PathBuf};

fn join_segments(mut root: PathBuf, segments: &[&str]) -> PathBuf {
    for segment in segments {
        root.push(segment);
    }
    root
}

pub(crate) fn resolve_engine_path(
    executable: Option<&Path>,
    bundled_suffix: &[&str],
    dev_cwd: Option<&Path>,
    allow_dev_cwd: bool,
    is_valid: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if let Some(executable_dir) = executable.and_then(Path::parent) {
        for root in [
            executable_dir.join("engine"),
            executable_dir.join("..").join("Resources").join("engine"),
            executable_dir
                .join("..")
                .join("Resources")
                .join("_up_")
                .join("engine"),
        ] {
            let candidate = join_segments(root, bundled_suffix);
            if is_valid(&candidate) {
                return Some(candidate);
            }
        }
    }

    if allow_dev_cwd {
        if let Some(cwd) = dev_cwd {
            let candidate = join_segments(cwd.join("engine"), bundled_suffix);
            if is_valid(&candidate) {
                return Some(candidate);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("lunery-engine-path-{name}-{nonce}"))
    }

    #[test]
    fn release_resolution_rejects_a_planted_cwd_engine() {
        let root = test_root("release-cwd");
        let executable = root.join("app").join("lunerylab-studio");
        let cwd = root.join("cwd");
        let planted = cwd.join("engine").join("mlx");
        std::fs::create_dir_all(&planted).expect("create planted cwd engine");

        assert_eq!(
            resolve_engine_path(Some(&executable), &["mlx"], Some(&cwd), false, Path::is_dir,),
            None
        );
        assert_eq!(
            resolve_engine_path(Some(&executable), &["mlx"], Some(&cwd), true, Path::is_dir,),
            Some(planted)
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn release_resolution_accepts_only_bundled_resource_layouts() {
        let root = test_root("resources");
        let executable = root.join("MacOS").join("lunerylab-studio");
        std::fs::create_dir_all(executable.parent().expect("executable parent"))
            .expect("create executable layout");
        let bundled = root
            .join("Resources")
            .join("_up_")
            .join("engine")
            .join("sd")
            .join("sd-cli");
        std::fs::create_dir_all(bundled.parent().expect("bundled parent"))
            .expect("create bundled engine");
        std::fs::write(&bundled, b"binary").expect("write bundled engine");
        let resolved_bundled = executable
            .parent()
            .expect("executable parent")
            .join("..")
            .join("Resources")
            .join("_up_")
            .join("engine")
            .join("sd")
            .join("sd-cli");

        assert_eq!(
            resolve_engine_path(
                Some(&executable),
                &["sd", "sd-cli"],
                None,
                false,
                Path::is_file,
            ),
            Some(resolved_bundled)
        );

        let _ = std::fs::remove_dir_all(root);
    }
}
