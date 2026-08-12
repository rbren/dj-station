//! E2E golden audio case for the Choreography module: all three track
//! kinds drive a clocked two-voice patch from one serialized timeline.

use crate::common::e2e::{check_case, regen, write_events, EventsFile};
use dj_engine::choreo::NoteStep;
use dj_engine::{Engine, EngineConfig};

fn set_stepped(e: &mut Engine, module: &str, jack: &str, value: f32) {
    let node = e.nodes.iter().find(|n| n.instance_id == module).unwrap();
    let decl = node
        .manifest
        .inputs
        .iter()
        .find(|i| i.id == jack)
        .unwrap_or_else(|| panic!("no jack {jack}"));
    let cfg = decl.knob.clone().unwrap();
    let steps = cfg.steps.unwrap() as f32;
    let idx = ((value - cfg.min) / (cfg.max - cfg.min) * (steps - 1.0)).round();
    e.set_knob_position(module, jack, idx / (steps - 1.0))
        .unwrap();
}

/// Clock -> choreography (note melody + boolean gate + continuous sweep)
/// -> oscillator voice with a filter sweep and a gated noise hat.
fn regen_choreo_song() {
    let dir = crate::common::e2e::case_dir("choreo-song");
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("ch", "builtin.choreo").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("flt", "com.dj.filter").unwrap();
    e.add_module("nz", "com.dj.noise").unwrap();
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    e.set_knob_value("clk", "bpm", 480.0).unwrap(); // 8 beats per second
    e.connect("clk", "clock", "ch", "clock").unwrap();

    e.choreo_set_beats("ch", 8).unwrap();
    e.choreo_add_track("ch", "lead", "note").unwrap();
    e.choreo_add_track("ch", "hat", "boolean").unwrap();
    e.choreo_add_track("ch", "sweep", "continuous").unwrap();
    e.choreo_set_note_settings("ch", 0, 2, "penta min", 57)
        .unwrap();
    for (beat, degree, vel) in [
        (0usize, 0u16, 1.0f32),
        (1, 2, 0.6),
        (3, 4, 0.8),
        (4, 5, 1.0),
        (6, 3, 0.5),
    ] {
        e.choreo_set_note(
            "ch",
            0,
            beat,
            Some(NoteStep {
                degree,
                velocity: vel,
            }),
        )
        .unwrap();
    }
    for beat in [1usize, 3, 5, 7] {
        e.choreo_set_bool("ch", 1, beat, true).unwrap();
    }
    e.choreo_set_values("ch", 2, 0, &[1.0, 2.0, 3.5, 5.0, 6.5, 5.0, 3.0, 1.5])
        .unwrap();

    // Lead voice: note -> pitch, velocity -> VCA, sweep -> filter cutoff.
    e.connect("ch", "t0", "osc1", "pitch").unwrap();
    set_stepped(&mut e, "osc1", "waveform", 1.0); // saw
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("ch", "t1", "vca1", "cv").unwrap();
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("vca1", "out", "flt", "in").unwrap();
    e.connect("ch", "t2", "flt", "cutoff").unwrap();
    e.connect("flt", "lp", "out1", "l").unwrap();

    // Hat: boolean gate opens a noise VCA.
    e.connect("nz", "white", "vca2", "in").unwrap();
    e.connect("ch", "t3", "vca2", "cv").unwrap();
    e.set_knob_value("vca2", "cv", 0.0).unwrap();
    e.connect("vca2", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-choreo-song").unwrap();
    write_events(&dir, &EventsFile::seconds(2.0));
}

#[test]
fn e2e_choreo_song() {
    if regen() {
        regen_choreo_song();
    }
    check_case("choreo-song");
}
