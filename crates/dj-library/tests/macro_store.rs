//! Macro module storage (M4, PRD §6/§8.1): the library DB is the canonical
//! store for macro definitions (stable ID + version + JSON definition).

use dj_library::{Library, MacroRecord};

fn record(id: &str, version: i64) -> MacroRecord {
    MacroRecord {
        id: id.into(),
        name: format!("Macro {id}"),
        version,
        definition: format!("{{\"id\":\"{id}\",\"version\":{version}}}"),
    }
}

#[test]
fn macros_roundtrip_and_upsert_by_stable_id() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path()).unwrap();

    assert!(lib.macros().unwrap().is_empty());
    lib.save_macro(&record("macro.tone", 1)).unwrap();
    lib.save_macro(&record("macro.rig", 1)).unwrap();

    let got = lib.macro_by_id("macro.tone").unwrap().unwrap();
    assert_eq!(got, record("macro.tone", 1));
    assert_eq!(
        lib.macros()
            .unwrap()
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["macro.rig", "macro.tone"]
    );

    // Editing bumps the version under the same stable id (upsert).
    lib.save_macro(&record("macro.tone", 2)).unwrap();
    assert_eq!(lib.macros().unwrap().len(), 2);
    assert_eq!(lib.macro_by_id("macro.tone").unwrap().unwrap().version, 2);

    lib.delete_macro("macro.rig").unwrap();
    assert!(lib.macro_by_id("macro.rig").unwrap().is_none());
}

#[test]
fn macros_persist_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    {
        let lib = Library::open(dir.path()).unwrap();
        lib.save_macro(&record("macro.tone", 3)).unwrap();
    }
    let lib = Library::open(dir.path()).unwrap();
    assert_eq!(lib.macro_by_id("macro.tone").unwrap().unwrap().version, 3);
}
