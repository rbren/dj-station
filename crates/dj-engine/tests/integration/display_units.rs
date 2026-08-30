//! Units & display-value mapping (PRD §7.2): manifests declare how a
//! jack's raw engine value reads to a human (`display`: unit + optional
//! transform + per-step labels), and the app formats tooltips from it.
//!
//! The engine never computes on display specs, so these tests pin two
//! things the frontend can't: the schema survives manifest parsing, and —
//! the LFO displayed-rate bug — a module whose display declares an
//! identity Hz mapping really oscillates at the knob's value.

use dj_engine::manifest::{DisplayMap, Manifest};
use dj_engine::{Engine, EngineConfig};

const SR: f32 = 48_000.0;

fn mono_engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap()
}

/// Rising zero crossings per second.
fn zero_cross_rate(x: &[f32]) -> f32 {
    let mut n = 0usize;
    for w in x.windows(2) {
        if w[0] <= 0.0 && w[1] > 0.0 {
            n += 1;
        }
    }
    n as f32 / (x.len() as f32 / SR)
}

fn manifest(id: &str) -> Manifest {
    crate::common::registry().extensions[id].manifest.clone()
}

/// The LFO's `rate` display is `{ unit: "Hz" }` with no transform: the
/// knob VALUE is the displayed number, so it must equal the true output
/// frequency. (The historical bug was app-side — the TS exp knob curve
/// diverged from knob.rs, so a knob whose engine value was 1 Hz displayed
/// ~290 — but this is the engine half of the pin: rate value == real Hz.)
#[test]
fn lfo_rate_value_is_true_output_frequency() {
    for hz in [2.0f32, 10.0, 100.0] {
        let mut e = mono_engine();
        e.add_module("lfo", "com.dj.lfo").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("lfo", "bi", "out1", "l").unwrap();
        e.set_knob_value("lfo", "rate", hz).unwrap();
        // Enough cycles that ±1 crossing is well inside 2 %.
        let secs = (100.0 / hz).clamp(1.0, 4.0);
        let out = e.render_offline((secs * SR) as usize).unwrap().remove(0);
        let measured = zero_cross_rate(&out);
        let tol = 0.02 * hz + 1.0 / secs;
        assert!(
            (measured - hz).abs() <= tol,
            "displayed {hz} Hz but LFO ran at {measured} Hz"
        );
    }
}

#[test]
fn display_specs_parse_from_manifests() {
    let lfo = manifest("com.dj.lfo");
    let rate = lfo.inputs.iter().find(|j| j.id == "rate").unwrap();
    let d = rate.display.as_ref().expect("lfo rate declares display");
    assert_eq!(d.unit.as_deref(), Some("Hz"));
    assert!(d.map.is_none(), "rate is identity-mapped: value IS the Hz");

    let osc = manifest("com.dj.oscillator");
    let pitch = osc.inputs.iter().find(|j| j.id == "pitch").unwrap();
    let d = pitch.display.as_ref().expect("osc pitch declares display");
    assert_eq!(d.unit.as_deref(), Some("Hz"));
    match d.map.as_ref().expect("pitch is 1 V/oct mapped") {
        DisplayMap::VoltPerOctave { base } => {
            // Default base = middle C, dj_module_sdk::pitch_to_hz(0.0).
            assert!((base - 261.626).abs() < 1e-3);
        }
        other => panic!("pitch mapped as {other:?}"),
    }

    // The clock ratio map carries no numbers of its own: the raw value IS
    // the ratio, and only its spelling ("1/3", "4x") is app-side.
    let cm = manifest("com.dj.clock_mult");
    let mult = cm.inputs.iter().find(|j| j.id == "mult").unwrap();
    let d = mult.display.as_ref().expect("mult declares display");
    assert_eq!(d.map.as_ref(), Some(&DisplayMap::ClockRatio));
    assert_eq!(d.unit.as_deref(), Some(""));
    assert!(d.steps.is_none(), "a continuous ratio has no step labels");

    // Volts is the default: undeclared jacks carry no display spec.
    let att = manifest("com.dj.attenuverter");
    assert!(att.inputs.iter().all(|j| j.display.is_none()));
    assert!(att.outputs.iter().all(|o| o.display.is_none()));
}

#[test]
fn quantizer_scale_and_root_declare_step_labels() {
    let q = manifest("com.dj.quantizer");
    let scale = q.inputs.iter().find(|j| j.id == "scale").unwrap();
    let labels = scale.display.as_ref().unwrap().steps.as_ref().unwrap();
    assert_eq!(labels[0], "custom");
    assert_eq!(labels[1], "major");
    assert_eq!(labels.len(), 10);
    let root = q.inputs.iter().find(|j| j.id == "root").unwrap();
    let labels = root.display.as_ref().unwrap().steps.as_ref().unwrap();
    assert_eq!(labels[0], "C");
    assert_eq!(labels.len(), 12);
}

/// Generic invariant: any stepped input that declares step labels must
/// declare exactly one label per knob detent, or the app would show the
/// wrong step name off-by-N.
#[test]
fn step_labels_match_knob_step_counts() {
    for ext in crate::common::registry().extensions.values() {
        for j in &ext.manifest.inputs {
            let Some(labels) = j.display.as_ref().and_then(|d| d.steps.as_ref()) else {
                continue;
            };
            let steps = j.knob.as_ref().and_then(|k| k.steps).unwrap_or_else(|| {
                panic!(
                    "{}:{} has step labels but no stepped knob",
                    ext.manifest.id, j.id
                )
            });
            assert_eq!(
                labels.len() as u32,
                steps,
                "{}:{}: {} labels for {} steps",
                ext.manifest.id,
                j.id,
                labels.len(),
                steps
            );
        }
    }
}
