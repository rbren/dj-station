//! Workspace tags ([`Workspace`]): the Rack tab and the Decks tab are two
//! separate racks sharing one engine. Every module belongs to exactly one
//! workspace; the tag round-trips through patches, splits per-tab saves
//! (`PatchDoc::retain_workspace` / `strip_workspaces`) and merged loads
//! (`PatchDoc::merge_workspace`), and audio focus plays only the open
//! page's workspace.

use dj_engine::{AudioFocus, Engine, EngineConfig, MacroInterface, MacroJack, Workspace};

const BLOCK: usize = 128;

fn engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 1,
            block_size: BLOCK,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap()
}

/// One oscillator per workspace, both into one shared output.
fn split_pair() -> Engine {
    let mut e = engine();
    e.add_module("rack_osc", "com.dj.oscillator").unwrap();
    e.add_module("deck_osc", "com.dj.oscillator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("rack_osc", "audio", "out1", "l").unwrap();
    e.connect("deck_osc", "audio", "out1", "l").unwrap();
    e.set_module_workspace("deck_osc", Workspace::Decks)
        .unwrap();
    e
}

fn peak(e: &mut Engine, frames: usize) -> f32 {
    e.render_offline(frames)
        .unwrap()
        .remove(0)
        .iter()
        .fold(0.0f32, |a, s| a.max(s.abs()))
}

/// Collapse osc1+vca1 (already wired) into one macro instance `voice1`.
fn collapse_voice(e: &mut Engine, macro_id: &str) {
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "voice1",
        macro_id,
        "Voice",
        MacroInterface {
            inputs: vec![MacroJack {
                id: "pitch".into(),
                node: "osc1".into(),
                jack: "pitch".into(),
            }],
            outputs: vec![MacroJack {
                id: "out".into(),
                node: "vca1".into(),
                jack: "out".into(),
            }],
            params: vec![],
        },
    )
    .unwrap();
}

#[test]
fn modules_default_to_the_rack_workspace() {
    let mut e = engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    assert_eq!(e.module_workspace("osc1").unwrap(), Workspace::Rack);
}

#[test]
fn the_tag_survives_a_patch_round_trip() {
    let e = split_pair();
    let doc = e.snapshot("t");
    let e2 = Engine::from_doc(&doc, crate::common::registry()).unwrap();
    assert_eq!(e2.module_workspace("rack_osc").unwrap(), Workspace::Rack);
    assert_eq!(e2.module_workspace("deck_osc").unwrap(), Workspace::Decks);
}

#[test]
fn a_rack_module_writes_no_workspace_bytes() {
    // Pre-workspace patches (and every single-workspace file) stay
    // byte-identical: the default tag is skipped entirely.
    let e = split_pair();
    let doc = e.snapshot("t");
    let rack = serde_json::to_string(&doc.modules["rack_osc"]).unwrap();
    let deck = serde_json::to_string(&doc.modules["deck_osc"]).unwrap();
    assert!(!rack.contains("workspace"), "default tag leaked: {rack}");
    assert!(deck.contains("\"workspace\":\"decks\""), "got: {deck}");
}

#[test]
fn undo_restores_the_workspace_a_module_was_in() {
    let mut e = split_pair();
    let before = e.snapshot("undo");
    e.set_module_workspace("deck_osc", Workspace::Rack).unwrap();
    e.apply_doc(&before).unwrap();
    assert_eq!(e.module_workspace("deck_osc").unwrap(), Workspace::Decks);
}

#[test]
fn a_macro_instance_moves_with_all_its_members() {
    let mut e = engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    collapse_voice(&mut e, "macro.ws-move");
    e.set_module_workspace("voice1", Workspace::Decks).unwrap();
    assert_eq!(e.module_workspace("voice1").unwrap(), Workspace::Decks);
    for n in e.nodes.iter() {
        assert_eq!(n.workspace, Workspace::Decks, "{}", n.instance_id);
    }
}

#[test]
fn collapsing_keeps_the_members_workspace() {
    let mut e = engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.set_module_workspace("osc1", Workspace::Decks).unwrap();
    e.set_module_workspace("vca1", Workspace::Decks).unwrap();
    collapse_voice(&mut e, "macro.ws-keep");
    assert_eq!(e.module_workspace("voice1").unwrap(), Workspace::Decks);
    // And the tag stays out of the DEFINITION: an adopted macro is
    // workspace-neutral however its instance is tagged.
    let doc = e.snapshot("t");
    for (iid, mf) in &doc.macros["voice1"].def.modules {
        assert!(mf.workspace.is_rack(), "definition tagged via {iid}");
    }
}

#[test]
fn breaking_a_macro_frees_members_into_its_workspace() {
    let mut e = engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    collapse_voice(&mut e, "macro.ws-break");
    e.set_module_workspace("voice1", Workspace::Decks).unwrap();
    e.break_macro("voice1").unwrap();
    for n in e.nodes.iter() {
        assert_eq!(n.workspace, Workspace::Decks, "{}", n.instance_id);
    }
}

#[test]
fn each_page_plays_its_own_workspace() {
    let mut e = split_pair();
    // Rack focus (the default): the rack oscillator sounds.
    assert!(peak(&mut e, BLOCK * 8) > 0.1);
    e.set_module_workspace("rack_osc", Workspace::Decks)
        .unwrap();
    // Now nothing lives in the rack workspace: the rack page goes quiet…
    e.render_offline(BLOCK * 2).unwrap(); // fade
    assert_eq!(
        peak(&mut e, BLOCK * 8),
        0.0,
        "rack page plays decks modules"
    );
    // …and the decks page plays both oscillators.
    e.set_audio_focus(AudioFocus::Decks).unwrap();
    e.render_offline(BLOCK * 2).unwrap(); // fade
    assert!(peak(&mut e, BLOCK * 8) > 0.1, "decks page is silent");
}

#[test]
fn retain_workspace_splits_a_snapshot_per_tab() {
    let e = split_pair();
    let mut rack = e.snapshot("t");
    rack.retain_workspace(Workspace::Rack);
    assert!(rack.modules.contains_key("rack_osc"));
    assert!(!rack.modules.contains_key("deck_osc"));
    // The shared output stays with the rack (its tag) and the departed
    // oscillator's wire onto it is gone.
    assert!(rack.modules.contains_key("out1"));
    assert!(!rack.wires.contains_key("deck_osc"));

    let mut decks = e.snapshot("t");
    decks.retain_workspace(Workspace::Decks);
    assert_eq!(
        decks.modules.keys().collect::<Vec<_>>(),
        vec!["deck_osc"],
        "the decks side is the tagged module alone"
    );
    // A wire whose OTHER END left goes with it.
    assert!(decks
        .wires
        .get("deck_osc")
        .is_none_or(|w| w.wires.is_empty()));
}

#[test]
fn strip_workspaces_normalizes_a_save() {
    let e = split_pair();
    let mut doc = e.snapshot("t");
    doc.retain_workspace(Workspace::Decks);
    doc.strip_workspaces();
    assert!(doc.modules["deck_osc"].workspace.is_rack());
}

#[test]
fn merge_workspace_keeps_free_ids_and_renames_collisions() {
    // The live engine: a rack-side filter, plus one leftover decks module
    // that the incoming patch will replace.
    let mut e = engine();
    e.add_module("flt", "com.dj.filter").unwrap();
    let mut live = e.snapshot("live");

    // The incoming deck patch: `flt` collides with the rack's, `osc9` is
    // free and keeps its name.
    let mut src = engine();
    src.add_module("flt", "com.dj.filter").unwrap();
    src.add_module("osc9", "com.dj.oscillator").unwrap();
    src.connect("osc9", "audio", "flt", "in").unwrap();
    let incoming = src.snapshot("deckpatch");

    let renames = live.merge_workspace(&incoming, Workspace::Decks);
    assert_eq!(renames.len(), 1);
    let new_flt = renames["flt"].clone();
    assert_ne!(new_flt, "flt");
    assert!(live.modules["flt"].workspace.is_rack(), "rack side intact");
    assert_eq!(live.modules["osc9"].workspace, Workspace::Decks);
    assert_eq!(live.modules[&new_flt].workspace, Workspace::Decks);
    // The incoming wire follows the rename.
    assert_eq!(live.wires["osc9"].wires[0].to, new_flt);
    // And the merged document loads.
    let e2 = Engine::from_doc(&live, crate::common::registry()).unwrap();
    assert_eq!(e2.module_workspace("osc9").unwrap(), Workspace::Decks);
    assert_eq!(e2.module_workspace(&new_flt).unwrap(), Workspace::Decks);
    assert_eq!(e2.module_workspace("flt").unwrap(), Workspace::Rack);
}

#[test]
fn a_workspace_load_leaves_the_other_side_untouched() {
    // The shell's open-into-a-workspace sequence, end to end: keep the
    // OTHER workspace from the live engine, merge the file in, apply.
    let mut e = split_pair();
    let mut doc = e.snapshot("load");
    doc.retain_workspace(Workspace::Rack);

    let mut src = engine();
    src.add_module("lfo1", "com.dj.lfo").unwrap();
    let incoming = src.snapshot("deckpatch");

    doc.merge_workspace(&incoming, Workspace::Decks);
    e.apply_doc(&doc).unwrap();
    assert_eq!(e.module_workspace("rack_osc").unwrap(), Workspace::Rack);
    assert_eq!(e.module_workspace("lfo1").unwrap(), Workspace::Decks);
    assert!(
        !e.nodes.iter().any(|n| n.instance_id == "deck_osc"),
        "the old decks workspace was replaced"
    );
}
