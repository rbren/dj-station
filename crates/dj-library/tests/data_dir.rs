//! Data-dir resolution (`<repo>/custom`, env override) and the one-shot,
//! non-destructive copy of pre-`custom/` platform data.

use dj_library::paths::{
    find_repo_root, migrate_legacy_data, resolve_data_dir, Migration, DATA_DIR_NAME,
    MIGRATION_MARKER,
};
use std::fs;
use std::path::Path;

/// A repo checkout as `find_repo_root` recognizes one: `run.sh` + `.git`.
fn fake_repo(root: &Path) {
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("run.sh"), "#!/usr/bin/env bash\n").unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
}

fn write(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

#[test]
fn repo_root_is_found_from_any_subdirectory() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("dj-station");
    fake_repo(&root);
    let deep = root.join("app/src-tauri/target/release");
    fs::create_dir_all(&deep).unwrap();

    assert_eq!(find_repo_root(&deep).unwrap(), root);
    assert_eq!(find_repo_root(&root).unwrap(), root);
    // A git checkout without run.sh is some other repo, not ours.
    let other = tmp.path().join("other");
    fs::create_dir_all(other.join(".git")).unwrap();
    assert_eq!(find_repo_root(&other), None);
}

#[test]
fn data_dir_is_custom_in_the_repo_unless_overridden() {
    let repo = Path::new("/checkout/dj-station");
    let cwd = Path::new("/somewhere/else");

    assert_eq!(
        resolve_data_dir(None, Some(repo), cwd),
        repo.join(DATA_DIR_NAME)
    );
    // No checkout (packaged bundle): fall back to the launch directory.
    assert_eq!(
        resolve_data_dir(None, None, cwd),
        cwd.join(DATA_DIR_NAME),
        "fallback keeps the custom/ layout"
    );
    // The env var wins over the checkout, and blanks count as unset.
    assert_eq!(
        resolve_data_dir(Some("/var/dj"), Some(repo), cwd),
        Path::new("/var/dj")
    );
    assert_eq!(
        resolve_data_dir(Some("  "), Some(repo), cwd),
        repo.join(DATA_DIR_NAME)
    );
}

#[test]
fn first_run_copies_legacy_data_and_leaves_the_originals() {
    let tmp = tempfile::tempdir().unwrap();
    let legacy = tmp.path().join("platform-data");
    let data = tmp.path().join("repo/custom");
    write(&legacy.join("library.sqlite"), "db");
    write(&legacy.join("patches/set/patch.json"), "{}");
    write(&legacy.join("stems/abc/drums.flac"), "flac");

    let outcome = migrate_legacy_data(&legacy, &data).unwrap();

    assert_eq!(outcome, Migration::Copied { files: 3 });
    assert_eq!(read(&data.join("library.sqlite")), "db");
    assert_eq!(read(&data.join("patches/set/patch.json")), "{}");
    assert_eq!(read(&data.join("stems/abc/drums.flac")), "flac");
    assert!(data.join(MIGRATION_MARKER).is_file());
    // Copy, never move: the originals are untouched.
    assert!(legacy.join("library.sqlite").is_file());
    assert!(legacy.join("patches/set/patch.json").is_file());
}

#[test]
fn migration_runs_once_and_never_clobbers_newer_state() {
    let tmp = tempfile::tempdir().unwrap();
    let legacy = tmp.path().join("platform-data");
    let data = tmp.path().join("repo/custom");
    write(&legacy.join("patches/set/patch.json"), "old");

    assert_eq!(
        migrate_legacy_data(&legacy, &data).unwrap(),
        Migration::Copied { files: 1 }
    );

    // The user keeps working in custom/ while the legacy dir goes stale.
    write(&data.join("patches/set/patch.json"), "edited in custom");
    write(
        &legacy.join("patches/other/patch.json"),
        "written by old app",
    );

    assert_eq!(
        migrate_legacy_data(&legacy, &data).unwrap(),
        Migration::AlreadyMigrated
    );
    assert_eq!(
        read(&data.join("patches/set/patch.json")),
        "edited in custom"
    );
    assert!(
        !data.join("patches/other/patch.json").exists(),
        "a migrated dir never picks up later legacy writes"
    );
}

#[test]
fn a_populated_data_dir_is_left_alone_without_a_marker() {
    let tmp = tempfile::tempdir().unwrap();
    let legacy = tmp.path().join("platform-data");
    let data = tmp.path().join("repo/custom");
    write(&legacy.join("library.sqlite"), "legacy db");
    write(&data.join("library.sqlite"), "existing db");
    write(&data.join(".gitignore"), "stems/\n");

    let outcome = migrate_legacy_data(&legacy, &data).unwrap();

    assert_eq!(outcome, Migration::TargetNotEmpty);
    assert_eq!(read(&data.join("library.sqlite")), "existing db");
    assert!(data.join(MIGRATION_MARKER).is_file());
}

#[test]
fn bookkeeping_files_do_not_count_as_state() {
    let tmp = tempfile::tempdir().unwrap();
    let legacy = tmp.path().join("platform-data");
    let data = tmp.path().join("repo/custom");
    write(&legacy.join("library.sqlite"), "legacy db");
    // A fresh checkout ships custom/.gitignore; that must not block the copy.
    write(&data.join(".gitignore"), "stems/\n");

    assert_eq!(
        migrate_legacy_data(&legacy, &data).unwrap(),
        Migration::Copied { files: 1 }
    );
    assert_eq!(read(&data.join("library.sqlite")), "legacy db");
}

#[test]
fn nothing_to_migrate_still_creates_the_dir_and_marks_it() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("repo/custom");

    let outcome = migrate_legacy_data(&tmp.path().join("no-such-dir"), &data).unwrap();

    assert_eq!(outcome, Migration::NothingToMigrate);
    assert!(data.is_dir());
    assert!(data.join(MIGRATION_MARKER).is_file());
}

#[test]
fn legacy_pointing_at_the_data_dir_is_a_no_op() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("custom");
    write(&data.join("library.sqlite"), "db");

    assert_eq!(
        migrate_legacy_data(&data, &data).unwrap(),
        Migration::NothingToMigrate
    );
    assert_eq!(read(&data.join("library.sqlite")), "db");
}
