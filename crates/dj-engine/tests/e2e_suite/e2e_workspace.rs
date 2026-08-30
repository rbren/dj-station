//! E2E golden audio for workspace tags (Rack tab vs Decks tab racks).
//!
//! `workspace-focus-split`: two oscillators into one shared Audio Output —
//! one in the default Rack workspace, one tagged `decks` — rendered with
//! the DECKS page focused. The golden is the decks oscillator's tone
//! ALONE, so it pins two things at once: the workspace tag surviving the
//! patch round-trip (a dropped tag would let the rack oscillator through),
//! and the focus gates playing exactly the open page's workspace.
//!
//! Regenerate with `./scripts/regen-goldens.sh`.

use crate::common::e2e::{case_dir, check_case, regen, write_events, EventsFile};
use dj_engine::{Engine, EngineConfig, Workspace};

fn regen_workspace_focus_split() {
    let dir = case_dir("workspace-focus-split");
    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("rack_osc", "com.dj.oscillator").unwrap();
    e.add_module("deck_osc", "com.dj.oscillator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    // Different pitches so a leak would be unmistakable in the waveform.
    e.set_knob_value("rack_osc", "pitch", -1.0).unwrap();
    e.set_knob_value("deck_osc", "pitch", 1.0).unwrap();
    e.connect("rack_osc", "audio", "out1", "l").unwrap();
    e.connect("deck_osc", "audio", "out1", "r").unwrap();
    e.set_module_workspace("deck_osc", Workspace::Decks)
        .unwrap();

    e.save_patch(&dir.join("patch"), "e2e-workspace-focus-split")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            focus: Some("decks".into()),
            ..EventsFile::seconds(0.5)
        },
    );
}

#[test]
fn e2e_workspace_focus_split() {
    if regen() {
        regen_workspace_focus_split();
    }
    check_case("workspace-focus-split");
}
