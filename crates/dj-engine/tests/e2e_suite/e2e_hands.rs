//! E2E golden audio case for the Hands module (camera hand-tracking CV).
//!
//! Landmark frames come from the webview tracker at runtime, so this case
//! carries a deterministic synthetic `HandsTrace` in its sidecar (the
//! hands analogue of gesture pose traces): a right hand whose pinch opens
//! then closes, wired `r_pinch -> VCA cv`, so the render's amplitude
//! envelope IS the pinch curve.

use crate::common::e2e::{check_case, regen, write_events, EventsFile, HandsTraceSpec};
use dj_engine::hands::{HandsDetection, HandsTrace, N_LANDMARKS};
use dj_engine::{Engine, EngineConfig};

/// Synthetic right hand at frame center with a given pinch ratio: palm
/// span fixed at 0.3, thumb/index tips `pinch * span` apart.
fn hand_with_pinch(pinch_ratio: f32) -> [[f32; 3]; N_LANDMARKS] {
    let span = 0.3;
    let mut pts = [[0.0f32; 3]; N_LANDMARKS];
    for (i, p) in pts.iter_mut().enumerate() {
        *p = [0.005 * i as f32, 0.005 * i as f32, 0.0];
    }
    pts[0] = [0.0, -0.2, 0.0]; // wrist
    pts[9] = [0.0, 0.1, 0.0]; // middle MCP
    pts[2] = [0.05, -0.1, 0.0]; // thumb MCP
    pts[4] = [0.1, 0.0, 0.0]; // thumb tip
    pts[8] = [0.1 + pinch_ratio * span, 0.0, 0.0]; // index tip
    pts
}

fn regen_hands_pinch() {
    let dir = crate::common::e2e::case_dir("hands-pinch-vca");

    // 30 fps, 1.5 s: pinch opens 0.1 -> 1.4 over the first half, then
    // closes back down.
    let n = 45;
    let frames = (0..n)
        .map(|i| {
            let t = i as f32 / (n - 1) as f32;
            let pinch = 0.1 + 1.3 * (1.0 - (2.0 * t - 1.0).abs());
            HandsDetection {
                left: None,
                right: Some(hand_with_pinch(pinch)),
            }
        })
        .collect();
    let trace = HandsTrace { fps: 30.0, frames };
    trace.save(&dir.join("pinch.json")).unwrap();

    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("hands1", "builtin.hands").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("hands1", "r_pinch", "vca1", "cv").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    // Wired inputs add to the knob baseline; zero the cv knob so the
    // pinch alone drives the amplitude.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.save_patch(&dir.join("patch"), "e2e-hands-pinch-vca")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 1.5,
            hands: vec![HandsTraceSpec {
                instance: "hands1".into(),
                trace: "pinch.json".into(),
            }],
            ..EventsFile::default()
        },
    );
}

#[test]
fn e2e_hands_pinch_vca() {
    if regen() {
        regen_hands_pinch();
    }
    check_case("hands-pinch-vca");
}
