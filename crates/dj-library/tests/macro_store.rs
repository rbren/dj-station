//! The retired `macros` table (PRD §6): macros are global objects in the
//! macro store (`<data_dir>/macros/`), so the library only hands over what
//! older builds left behind and then forgets it.

use dj_library::Library;

/// A DB as an older build left it: a `macros` table with rows in it.
fn write_legacy_table(dir: &std::path::Path) {
    let conn = rusqlite::Connection::open(dir.join("library.sqlite")).unwrap();
    conn.execute(
        "CREATE TABLE IF NOT EXISTS macros (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL,
            definition TEXT NOT NULL, updated_at TEXT NOT NULL)",
        [],
    )
    .unwrap();
    for (id, version) in [("macro.tone", 2), ("macro.rig", 1)] {
        conn.execute(
            "INSERT INTO macros (id, name, version, definition, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'now')",
            rusqlite::params![
                id,
                format!("Macro {id}"),
                version,
                format!("{{\"id\":\"{id}\"}}")
            ],
        )
        .unwrap();
    }
}

#[test]
fn fresh_libraries_have_no_macro_table() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path()).unwrap();
    assert!(lib.legacy_macros().unwrap().is_empty());
    // Dropping a table that was never created is fine.
    lib.drop_legacy_macros().unwrap();
}

#[test]
fn legacy_macro_rows_are_readable_once_and_then_dropped() {
    let dir = tempfile::tempdir().unwrap();
    write_legacy_table(dir.path());

    let lib = Library::open(dir.path()).unwrap();
    let rows = lib.legacy_macros().unwrap();
    assert_eq!(
        rows.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["macro.rig", "macro.tone"]
    );
    assert_eq!(rows[1].version, 2);
    assert_eq!(rows[1].definition, "{\"id\":\"macro.tone\"}");

    lib.drop_legacy_macros().unwrap();
    assert!(lib.legacy_macros().unwrap().is_empty());
    // Still gone after a reopen: the migration runs once.
    let lib = Library::open(dir.path()).unwrap();
    assert!(lib.legacy_macros().unwrap().is_empty());
}
