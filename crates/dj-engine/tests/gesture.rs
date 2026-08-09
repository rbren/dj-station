//! M5 acceptance: the Gesture Control module in the engine graph
//! (PRD §7.3). Wheel zones land as gates, landmark presence/distance
//! semantics hold through the RT graph, mappings round-trip through the
//! patch directory format, the learn flow works via app commands, and a
//! stub third mode registers with zero module-core changes.

mod common;

use dj_engine::dj_gesture::{
    fixtures, Detection, GestureMode, MappingEval, ModeCtx, Point, WheelLayout, GATE_HIGH,
    ZONES_PER_WHEEL,
};
use dj_engine::{Engine, EngineConfig};

const FPS_DT: f32 = 1.0 / 30.0;

fn hand_in(layout: &WheelLayout, wheel: usize, zone: usize) -> Detection {
    Detection {
        hands: vec![
            fixtures::centered_hand('R', layout.zone_center(wheel, zone))
                .to_hand()
                .unwrap(),
        ],
    }
}

fn pinch_hand() -> Detection {
    Detection {
        hands: vec![
            fixtures::synth_hand_at('L', Point { x: 0.5, y: 0.5 }, 0.022)
                .to_hand()
                .unwrap(),
        ],
    }
}

/// [A] Wheel mode: a hand placed in each of the 18 zones toggles exactly
/// that zone's switch output and no others, and the values land in the
/// graph as §4 gates (high 10 / low 0) readable at wired inputs.
#[test]
fn wheel_zones_gate_exactly_one_output_in_graph() {
    let mut engine = common::default_engine();
    engine.add_module("gest1", "builtin.gesture").unwrap();
    let layout = *engine.gesture("gest1").unwrap().wheels();
    // 18 mappings, each wired into its own VCA cv input so the gate is
    // observable in the graph via telemetry.
    let mut names = Vec::new();
    for wheel in 0..2 {
        for zone in 0..ZONES_PER_WHEEL {
            let name = format!("w{wheel}z{zone}");
            engine
                .add_gesture_mapping(
                    "gest1",
                    &name,
                    "wheel",
                    serde_json::json!({ "wheel": wheel, "zone": zone }),
                )
                .unwrap();
            let vca = format!("vca_{name}");
            engine.add_module(&vca, "com.dj.vca").unwrap();
            engine.connect("gest1", &name, &vca, "cv").unwrap();
            engine.set_knob_value(&vca, "cv", 0.0).unwrap();
            names.push((name, vca, wheel, zone));
        }
    }
    for visit in 0..names.len() {
        let (_, _, wheel, zone) = names[visit];
        engine
            .gesture_feed("gest1", 0, Some(&hand_in(&layout, wheel, zone)), FPS_DT)
            .unwrap();
        engine.process_blocks(2).unwrap();
        for (i, (name, vca, ..)) in names.iter().enumerate() {
            let v = engine.tap(vca, "cv").unwrap().instantaneous;
            let expect = if i == visit { GATE_HIGH } else { 0.0 };
            assert_eq!(v, expect, "hand in zone {visit}: output {name} wrong");
        }
    }
}

/// [A] Landmark presence: gate 1 while detected; holds through dropped
/// frames; decays to 0 after the configured timeout — all observed
/// through the RT graph.
#[test]
fn presence_gate_decays_after_timeout_in_graph() {
    let mut engine = common::default_engine();
    engine.add_module("gest1", "builtin.gesture").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine
        .add_gesture_mapping(
            "gest1",
            "idx",
            "landmark",
            serde_json::json!({ "type": "presence", "point": "L.index.tip", "timeout": 0.1 }),
        )
        .unwrap();
    engine.connect("gest1", "idx", "vca1", "cv").unwrap();
    engine.set_knob_value("vca1", "cv", 0.0).unwrap();

    let det = pinch_hand();
    engine.gesture_feed("gest1", 0, Some(&det), FPS_DT).unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(engine.tap("vca1", "cv").unwrap().instantaneous, GATE_HIGH);

    // Two dropped frames (< 0.1 s): the gate holds.
    engine.gesture_feed("gest1", 0, None, FPS_DT).unwrap();
    engine.gesture_feed("gest1", 0, None, FPS_DT).unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(engine.tap("vca1", "cv").unwrap().instantaneous, GATE_HIGH);

    // Third dropped frame crosses the timeout: gate decays to 0.
    engine.gesture_feed("gest1", 0, None, FPS_DT).unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(engine.tap("vca1", "cv").unwrap().instantaneous, 0.0);
}

/// [A] Landmark distance drives a VCA: offline render of
/// Gesture(distance) -> VCA(cv) with Osc -> VCA -> Out tracks the scripted
/// pinch fixture's amplitude monotonically (up, then down). The
/// byte-identical golden for this patch lives in e2e_golden.rs.
#[test]
fn pinch_distance_tracks_amplitude_in_render() {
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    let mut engine = Engine::new(config, common::registry()).unwrap();
    engine.add_module("gest1", "builtin.gesture").unwrap();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine
        .add_gesture_mapping(
            "gest1",
            "pinch",
            "landmark",
            serde_json::json!({
                "type": "distance",
                "a": "L.thumb.tip", "b": "L.index.tip",
                "min": 0.04, "max": 0.3,
            }),
        )
        .unwrap();
    engine.connect("osc1", "audio", "vca1", "in").unwrap();
    engine.connect("gest1", "pinch", "vca1", "cv").unwrap();
    engine.set_knob_value("vca1", "cv", 0.0).unwrap();
    engine.connect("vca1", "out", "out1", "l").unwrap();

    let trace = fixtures::pinch_trace(30.0, 45, 0.04, 0.3);
    engine.gesture_feed_trace("gest1", &trace, 0).unwrap();
    let seconds = trace.frames.len() as f32 / trace.fps;
    let frames = (seconds * engine.config.sample_rate) as usize;
    let out = engine.render_offline(frames).unwrap();

    // Peak amplitude per gesture-frame window must rise to a peak and
    // fall back, tracking the pinch (tolerance: one window either side
    // of the scripted turnaround for smoothing lag).
    let window = (engine.config.sample_rate / trace.fps) as usize;
    let peaks = common::window_peaks(&out[0], window);
    let peak_at = (0..peaks.len())
        .max_by(|&a, &b| peaks[a].total_cmp(&peaks[b]))
        .unwrap();
    let turnaround = (trace.frames.len() - 1) / 2;
    assert!(
        peak_at.abs_diff(turnaround) <= 2,
        "amplitude peak at window {peak_at}, gesture turnaround at {turnaround}"
    );
    let eps = 1e-4;
    for i in 2..=peak_at {
        assert!(
            peaks[i] >= peaks[i - 1] - eps,
            "amplitude not rising at window {i}: {} < {}",
            peaks[i],
            peaks[i - 1]
        );
    }
    for i in peak_at + 1..peaks.len() - 1 {
        assert!(
            peaks[i] <= peaks[i - 1] + eps,
            "amplitude not falling at window {i}"
        );
    }
    assert!(peaks[peak_at] > 0.5, "peak amplitude too low");
    assert!(peaks[1] < 0.2, "start amplitude too high");
}

/// [A] Mappings (zone -> switch, presence -> switch, distance ->
/// continuous), mode selection, and wheel layout round-trip through patch
/// save/load, including wires from mapping jacks and sparse jack indices.
#[test]
fn gesture_state_round_trips_through_patch() {
    let dir = tempfile::tempdir().unwrap();
    let patch_dir = dir.path().join("patch");
    {
        let mut engine = common::default_engine();
        engine.add_module("gest1", "builtin.gesture").unwrap();
        engine.add_module("vca1", "com.dj.vca").unwrap();
        engine.gesture_set_mode("gest1", "landmark").unwrap();
        let mut wheels = WheelLayout::default();
        wheels.wheels[0].cx = 0.31;
        wheels.wheels[1].center_radius = 0.11;
        engine.gesture_set_wheels("gest1", wheels).unwrap();
        engine
            .add_gesture_mapping(
                "gest1",
                "zone",
                "wheel",
                serde_json::json!({ "wheel": 1, "zone": 4 }),
            )
            .unwrap();
        engine
            .add_gesture_mapping(
                "gest1",
                "seen",
                "landmark",
                serde_json::json!({ "type": "presence", "point": "R.thumb.tip", "timeout": 0.25 }),
            )
            .unwrap();
        engine
            .add_gesture_mapping(
                "gest1",
                "dist",
                "landmark",
                serde_json::json!({
                    "type": "distance",
                    "a": "L.thumb.tip", "b": "L.index.tip",
                    "min": 0.05, "max": 0.4, "smooth": 0.2,
                }),
            )
            .unwrap();
        // Sparse jacks: removing the middle mapping leaves jack 1 free;
        // reload must keep "dist" on jack 2.
        engine.remove_gesture_mapping("gest1", "seen").unwrap();
        engine.connect("gest1", "dist", "vca1", "cv").unwrap();
        engine.set_knob_value("vca1", "cv", 0.0).unwrap();
        engine.save_patch(&patch_dir, "gesture-rt").unwrap();
    }

    let mut engine = Engine::load_patch(&patch_dir, common::registry()).unwrap();
    let g = engine.gesture("gest1").unwrap();
    assert_eq!(g.active_mode(), "landmark");
    assert_eq!(g.wheels().wheels[0].cx, 0.31);
    assert_eq!(g.wheels().wheels[1].center_radius, 0.11);
    let mappings = engine.gesture_mappings("gest1").unwrap();
    assert_eq!(mappings.len(), 2);
    assert_eq!(
        (mappings[0].name.as_str(), mappings[0].jack),
        ("zone", 0),
        "wheel mapping"
    );
    assert_eq!(
        (mappings[1].name.as_str(), mappings[1].jack),
        ("dist", 2),
        "sparse jack index must survive reload"
    );
    assert_eq!(
        mappings[1].config,
        serde_json::json!({
            "type": "distance",
            "a": "L.thumb.tip", "b": "L.index.tip",
            "min": 0.05, "max": 0.4, "smooth": 0.2,
        })
    );

    // The wire reconnected to the mapping jack: feeding an open pinch
    // (tips 0.2 apart, inside the mapping's 0.05..0.4 range) shows up at
    // the VCA input. dt >> smooth so smoothing settles in one tick.
    let open = Detection {
        hands: vec![fixtures::synth_hand(
            'L',
            Point { x: 0.5, y: 0.4 },
            0.022,
            Point { x: 0.4, y: 0.7 },
            Point { x: 0.6, y: 0.7 },
        )
        .to_hand()
        .unwrap()],
    };
    engine.gesture_feed("gest1", 0, Some(&open), 10.0).unwrap();
    engine.process_blocks(2).unwrap();
    assert!(engine.tap("vca1", "cv").unwrap().instantaneous > 0.0);

    // Re-saving the loaded engine writes an identical document.
    let doc = engine.snapshot("gesture-rt");
    let reread = dj_engine::PatchDoc::read(&patch_dir).unwrap();
    assert_eq!(doc, reread, "save/load/save is not idempotent");
}

/// [A] Learn-style mapping flow via app commands: arm, present a hand in
/// a zone, poll — the mapping materializes as a wired-up jack.
#[test]
fn learn_flow_creates_mapping_from_detection() {
    let mut engine = common::default_engine();
    engine.add_module("gest1", "builtin.gesture").unwrap();
    let layout = *engine.gesture("gest1").unwrap().wheels();

    engine.gesture_learn_begin("gest1").unwrap();
    assert!(engine.gesture_learn_poll("gest1", "pad").unwrap().is_none());
    engine
        .gesture_feed("gest1", 0, Some(&hand_in(&layout, 0, 5)), FPS_DT)
        .unwrap();
    let info = engine
        .gesture_learn_poll("gest1", "pad")
        .unwrap()
        .expect("learn candidate after detection");
    assert_eq!(info.name, "pad");
    assert_eq!(info.mode, "wheel");
    assert_eq!(info.config, serde_json::json!({ "wheel": 0, "zone": 5 }));

    // The new jack is immediately wireable and live.
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.connect("gest1", "pad", "vca1", "cv").unwrap();
    engine.set_knob_value("vca1", "cv", 0.0).unwrap();
    engine
        .gesture_feed("gest1", 0, Some(&hand_in(&layout, 0, 5)), FPS_DT)
        .unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(engine.tap("vca1", "cv").unwrap().instantaneous, GATE_HIGH);
}

/// Removing a mapping drops its wires and zeroes the RT value.
#[test]
fn remove_mapping_drops_wires_and_zeroes_value() {
    let mut engine = common::default_engine();
    engine.add_module("gest1", "builtin.gesture").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    let layout = *engine.gesture("gest1").unwrap().wheels();
    engine
        .add_gesture_mapping(
            "gest1",
            "pad",
            "wheel",
            serde_json::json!({ "wheel": 0, "zone": 0 }),
        )
        .unwrap();
    engine.connect("gest1", "pad", "vca1", "cv").unwrap();
    engine.set_knob_value("vca1", "cv", 0.0).unwrap();
    engine
        .gesture_feed("gest1", 0, Some(&hand_in(&layout, 0, 0)), FPS_DT)
        .unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(engine.tap("vca1", "cv").unwrap().instantaneous, GATE_HIGH);

    engine.remove_gesture_mapping("gest1", "pad").unwrap();
    assert!(engine.wire_specs().is_empty(), "wire must be dropped");
    engine.process_blocks(2).unwrap();
    assert!(engine.gesture_mappings("gest1").unwrap().is_empty());
    // The jack's RT value was zeroed for the next tenant.
    assert_eq!(engine.gesture("gest1").unwrap().value(0), 0.0);
}

// ---------------------------------------------------------------------------
// [A] Extensible mode registry: a stub third mode plugs in through the
// public registration hook — zero changes to the module core, the engine,
// or the persistence layer were needed for this test to pass.
// ---------------------------------------------------------------------------

struct SpreadMode;

struct SpreadEval {
    value: f32,
}

impl MappingEval for SpreadEval {
    fn update(&mut self, det: Option<&Detection>, _dt: f32, _ctx: &ModeCtx) -> f32 {
        if let Some(d) = det {
            // "Spread": wrist-to-middle-tip distance of the first hand.
            if let Some(h) = d.hands.first() {
                self.value = (h.points[0].distance(h.points[12]) * 50.0).clamp(0.0, 10.0);
            }
        }
        self.value
    }
}

impl GestureMode for SpreadMode {
    fn id(&self) -> &str {
        "spread"
    }
    fn create(&self, _config: &serde_json::Value) -> anyhow::Result<Box<dyn MappingEval>> {
        Ok(Box::new(SpreadEval { value: 0.0 }))
    }
    fn learn(&self, _det: &Detection, _ctx: &ModeCtx) -> Option<serde_json::Value> {
        Some(serde_json::json!({}))
    }
}

#[test]
fn stub_third_mode_registers_against_engine_without_core_changes() {
    let mut engine = common::default_engine();
    engine.add_module("gest1", "builtin.gesture").unwrap();
    assert_eq!(
        engine.gesture("gest1").unwrap().mode_ids(),
        vec!["wheel", "landmark"]
    );

    // The only integration step: registration.
    engine
        .gesture_register_mode("gest1", Box::new(SpreadMode))
        .unwrap();
    engine.gesture_set_mode("gest1", "spread").unwrap();

    // Learn flow + mapping + graph output all route through the new mode.
    engine.gesture_learn_begin("gest1").unwrap();
    engine
        .gesture_feed("gest1", 0, Some(&pinch_hand()), FPS_DT)
        .unwrap();
    let info = engine
        .gesture_learn_poll("gest1", "spread1")
        .unwrap()
        .expect("stub mode learn candidate");
    assert_eq!(info.mode, "spread");

    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.connect("gest1", "spread1", "vca1", "cv").unwrap();
    engine.set_knob_value("vca1", "cv", 0.0).unwrap();
    engine
        .gesture_feed("gest1", 0, Some(&pinch_hand()), FPS_DT)
        .unwrap();
    engine.process_blocks(2).unwrap();
    assert!(
        engine.tap("vca1", "cv").unwrap().instantaneous > 0.0,
        "stub mode output must reach the graph"
    );
}

/// Frame drops hold the last value for continuous mappings (graph-level).
#[test]
fn frame_drops_hold_continuous_values() {
    let mut engine = common::default_engine();
    engine.add_module("gest1", "builtin.gesture").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine
        .add_gesture_mapping(
            "gest1",
            "dist",
            "landmark",
            serde_json::json!({
                "type": "distance",
                "a": "L.thumb.tip", "b": "L.index.tip",
                "min": 0.0, "max": 0.2, "smooth": 0.0,
            }),
        )
        .unwrap();
    engine.connect("gest1", "dist", "vca1", "cv").unwrap();
    engine.set_knob_value("vca1", "cv", 0.0).unwrap();
    engine
        .gesture_feed("gest1", 0, Some(&pinch_hand()), FPS_DT)
        .unwrap();
    engine.process_blocks(2).unwrap();
    let held = engine.tap("vca1", "cv").unwrap().instantaneous;
    assert!(held > 0.0);
    for _ in 0..30 {
        engine.gesture_feed("gest1", 0, None, FPS_DT).unwrap();
    }
    engine.process_blocks(2).unwrap();
    assert_eq!(
        engine.tap("vca1", "cv").unwrap().instantaneous,
        held,
        "continuous value must hold through drops"
    );
}
