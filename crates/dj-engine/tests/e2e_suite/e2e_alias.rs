//! E2E golden audio case for the Alias module (a nameable 1-in/1-out
//! pass-through).
//!
//! `utilities-alias-passthrough`: an oscillator routed through a renamed
//! alias ("To Mixer") into the mixer — the alias must not change the
//! audio, and the user-typed display name must round-trip through the
//! serialized patch.
//!
//! The shared harness lives in `tests/common/e2e.rs`.

use crate::common::e2e::{check_case, regen, write_events, EventsFile};
use dj_engine::{Engine, EngineConfig};

fn regen_alias_passthrough() {
    let dir = crate::common::e2e::case_dir("utilities-alias-passthrough");
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("osc", "com.dj.oscillator").unwrap();
    e.add_module("alias1", "com.dj.alias").unwrap();
    e.add_module("mix", "com.dj.mixer").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // C4 sine straight through the alias into the mixer at half master.
    e.connect("osc", "audio", "alias1", "in").unwrap();
    e.connect("alias1", "out", "mix", "in1_l").unwrap();
    e.set_knob_value("mix", "lvl1", 10.0).unwrap();
    e.set_knob_value("mix", "master", 5.0).unwrap();
    e.connect("mix", "out_l", "out1", "l").unwrap();

    // Give the pass-through its name; the typed form persists in the patch.
    let id = e.rename_module("alias1", "To Mixer").unwrap();
    assert_eq!(id, "to_mixer");

    e.save_patch(&dir.join("patch"), "e2e-utilities-alias-passthrough")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

#[test]
fn e2e_utilities_alias_passthrough() {
    if regen() {
        regen_alias_passthrough();
    }
    check_case("utilities-alias-passthrough");
}
