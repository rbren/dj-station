//! Copy/paste of module selections as clipboard `PatchDoc`s:
//! `PatchDoc::extract_selection` keeps only wires internal to the selection,
//! and `PatchDoc::paste` merges a clipboard back in under fresh ids with
//! internal wires remapped.

use dj_engine::PatchDoc;

/// osc1 -> vca1 -> out1, with adsr1 -> vca1 cv (the demo patch shape,
/// minus MIDI).
fn three_module_engine() -> dj_engine::Engine {
    let mut e = crate::common::default_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_knob_value("osc1", "pitch", 0.25).unwrap();
    e
}

#[test]
fn extract_selection_keeps_internal_wires_and_drops_external_ones() {
    let e = three_module_engine();
    let doc = e.snapshot("test");

    let clip = doc.extract_selection(&["osc1".into(), "vca1".into()]);
    assert_eq!(
        clip.modules.keys().collect::<Vec<_>>(),
        ["osc1", "vca1"],
        "only the selection is copied"
    );
    // osc1 -> vca1 survives (both ends selected); vca1 -> out1 does not.
    let wires: Vec<(&str, &str, &str, &str)> = clip
        .wires
        .iter()
        .flat_map(|(src, wf)| {
            wf.wires.iter().map(move |w| {
                (
                    src.as_str(),
                    w.from_jack.as_str(),
                    w.to.as_str(),
                    w.to_jack.as_str(),
                )
            })
        })
        .collect();
    assert_eq!(wires, [("osc1", "audio", "vca1", "in")]);

    // Knob state rides along.
    assert!(clip.modules["osc1"].knobs.contains_key("pitch"));
}

#[test]
fn paste_creates_fresh_ids_and_remaps_internal_wires() {
    let mut e = three_module_engine();
    let doc = e.snapshot("test");
    let clip = doc.extract_selection(&["osc1".into(), "vca1".into()]);

    // Paste into the live document and apply.
    let mut next = doc.clone();
    let renames = next.paste(&clip);
    assert_eq!(renames.len(), 2);
    let new_osc = &renames["osc1"];
    let new_vca = &renames["vca1"];
    assert_ne!(new_osc, "osc1");
    assert_ne!(new_vca, "vca1");
    assert!(next.modules.contains_key(new_osc));
    assert!(next.modules.contains_key(new_vca));

    // The pasted internal wire connects the NEW instances.
    let pasted_wires = &next.wires[new_osc].wires;
    assert_eq!(pasted_wires.len(), 1);
    assert_eq!(&pasted_wires[0].to, new_vca);

    // No pasted wire touches out1 (external to the copied set).
    let to_out: usize = next
        .wires
        .iter()
        .filter(|(src, _)| *src == new_osc || *src == new_vca)
        .flat_map(|(_, wf)| &wf.wires)
        .filter(|w| w.to == "out1")
        .count();
    assert_eq!(to_out, 0, "external wires are not duplicated");

    // The merged doc applies cleanly to the live engine (the GUI path).
    e.apply_doc(&next).unwrap();
    assert!(e.nodes.iter().any(|n| &n.instance_id == new_osc));
    assert!(e.nodes.iter().any(|n| &n.instance_id == new_vca));
    // Originals still there, original wiring intact.
    assert!(e.nodes.iter().any(|n| n.instance_id == "osc1"));
    let specs = e.wire_specs();
    assert_eq!(specs.len(), 3, "2 original wires + 1 pasted internal");
}

#[test]
fn paste_a_single_module_copy() {
    let mut e = three_module_engine();
    let doc = e.snapshot("test");
    let clip = doc.extract_selection(&["osc1".into()]);
    assert!(clip.wires.is_empty(), "no internal wires for a lone module");

    let mut next = doc.clone();
    let renames = next.paste(&clip);
    let new_osc = &renames["osc1"];
    // Copied knob state carries over to the new instance.
    assert_eq!(
        next.modules[new_osc].knobs["pitch"],
        next.modules["osc1"].knobs["pitch"]
    );
    e.apply_doc(&next).unwrap();
    assert!(e.nodes.iter().any(|n| &n.instance_id == new_osc));
}

#[test]
fn clipboard_roundtrips_through_json() {
    let e = three_module_engine();
    let clip = e
        .snapshot("test")
        .extract_selection(&["osc1".into(), "vca1".into()]);
    let json = serde_json::to_string(&clip).unwrap();
    let back: PatchDoc = serde_json::from_str(&json).unwrap();
    assert_eq!(back, clip);
}

#[test]
fn extract_selection_drops_external_sync_targets() {
    let mut e = crate::common::default_engine();
    e.add_module("deckA", "builtin.deck").unwrap();
    e.add_module("deckB", "builtin.deck").unwrap();
    let doc = {
        let mut doc = e.snapshot("test");
        // Simulate a sync relationship in the document (deck_sync needs
        // loaded tracks; the doc-level field is what copy must handle).
        doc.modules.get_mut("deckA").unwrap().sync_to = Some("deckB".into());
        doc
    };

    // Copying only deckA severs the external sync reference…
    let clip = doc.extract_selection(&["deckA".into()]);
    assert_eq!(clip.modules["deckA"].sync_to, None);

    // …while copying both keeps it, remapped on paste.
    let clip = doc.extract_selection(&["deckA".into(), "deckB".into()]);
    assert_eq!(clip.modules["deckA"].sync_to.as_deref(), Some("deckB"));
    let mut next = doc.clone();
    let renames = next.paste(&clip);
    assert_eq!(
        next.modules[&renames["deckA"]].sync_to.as_ref(),
        Some(&renames["deckB"])
    );
}
