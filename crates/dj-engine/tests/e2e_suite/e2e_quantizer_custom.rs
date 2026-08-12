//! E2E golden audio case for the quantizer's CUSTOM scale (scale 0).
//!
//! `quantizer-custom-scale`: LFO -> attenuverter -> quantizer (scale 0,
//! custom mask = C minor triad {0, 3, 7} rooted at D) -> oscillator ->
//! mixer. The `custom` mask knob is serialized in the patch like any other
//! knob, so this case also pins the custom scale's save/load round-trip.
//!
//! The shared harness lives in `tests/common/e2e.rs`.

use crate::common::e2e::{check_case, regen, write_events, EventsFile};
use dj_engine::{Engine, EngineConfig};

fn regen_quantizer_custom() {
    let dir = crate::common::e2e::case_dir("quantizer-custom-scale");
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("lfo", "com.dj.oscillator").unwrap();
    e.add_module("att", "com.dj.attenuverter").unwrap();
    e.add_module("quant", "com.dj.quantizer").unwrap();
    e.add_module("voice", "com.dj.oscillator").unwrap();
    e.add_module("mix", "com.dj.mixer").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // Saw LFO at ~8 Hz, attenuated to a two-octave sweep.
    e.set_knob_position("lfo", "waveform", 1.0 / 3.0).unwrap();
    e.set_knob_value("lfo", "pitch", -5.0).unwrap();
    e.connect("lfo", "audio", "att", "in1").unwrap();
    e.set_knob_value("att", "atten1", 0.2).unwrap();

    // Custom scale: minor triad degrees {0, 3, 7} rooted at D.
    e.connect("att", "out1", "quant", "in").unwrap();
    e.set_knob_position("quant", "scale", 0.0).unwrap();
    e.set_knob_position("quant", "root", 2.0 / 11.0).unwrap();
    let mask = (1 << 0) | (1 << 3) | (1 << 7);
    e.set_knob_value("quant", "custom", mask as f32).unwrap();
    e.connect("quant", "out", "voice", "pitch").unwrap();

    // Voice through the mixer at half master level.
    e.connect("voice", "audio", "mix", "in1_l").unwrap();
    e.set_knob_value("mix", "lvl1", 10.0).unwrap();
    e.set_knob_value("mix", "master", 5.0).unwrap();
    e.connect("mix", "out_l", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-quantizer-custom-scale")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

#[test]
fn e2e_quantizer_custom_scale() {
    if regen() {
        regen_quantizer_custom();
    }
    check_case("quantizer-custom-scale");
}
