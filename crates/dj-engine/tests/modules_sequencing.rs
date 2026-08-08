//! Behaviour tests for the Clock & Sequencing modules.
//!
//! Each test renders a small patch offline and asserts on the samples: the
//! module outputs under test are wired straight into the two master
//! channels, so `render_offline` hands back their raw signals.

mod common;

use dj_engine::{Engine, EngineConfig};

const SR: f32 = 48_000.0;

/// Engine with a stereo master used as a two-channel probe.
fn probe_engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 2,
            ..EngineConfig::default()
        },
        common::registry(),
    )
    .unwrap()
}

/// Wire `(module, jack)` into master channel `ch` (0 = L, 1 = R).
fn probe(e: &mut Engine, ch: usize, module: &str, jack: &str) {
    let out = if ch == 0 { "l" } else { "r" };
    if e.nodes.iter().all(|n| n.instance_id != "probe") {
        e.add_module("probe", "builtin.audio_out").unwrap();
    }
    e.connect(module, jack, "probe", out).unwrap();
}

/// Set a stepped knob to an exact detent. `set_knob_value` inverts the knob
/// curve by binary search, which converges on a step boundary rather than
/// the detent itself; tests want the detent.
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

/// Frames at which a gate signal crosses from low to high.
fn rising_edges(signal: &[f32]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut prev = 0.0f32;
    for (i, &x) in signal.iter().enumerate() {
        if x >= 1.0 && prev < 1.0 {
            out.push(i);
        }
        prev = x;
    }
    out
}

/// Length in samples of each high region of a gate signal.
fn high_runs(signal: &[f32]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut run = 0usize;
    for &x in signal {
        if x >= 1.0 {
            run += 1;
        } else if run > 0 {
            out.push(run);
            run = 0;
        }
    }
    if run > 0 {
        out.push(run);
    }
    out
}

fn assert_edges_near(edges: &[usize], expected_secs: &[f32], tol: usize, what: &str) {
    assert_eq!(
        edges.len(),
        expected_secs.len(),
        "{what}: expected {} pulses, got {} at {:?}",
        expected_secs.len(),
        edges.len(),
        edges
    );
    for (i, (&got, &want_s)) in edges.iter().zip(expected_secs).enumerate() {
        let want = (want_s * SR).round() as usize;
        assert!(
            got.abs_diff(want) <= tol,
            "{what}: pulse {i} at frame {got}, expected ~{want} ({want_s} s)"
        );
    }
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

#[test]
fn clock_beat_and_multiplication_are_phase_locked() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.set_knob_value("clk", "bpm", 120.0).unwrap(); // 0.5 s per beat
    probe(&mut e, 0, "clk", "clock");
    probe(&mut e, 1, "clk", "mul4");
    let out = e.render_offline((2.05 * SR) as usize).unwrap();

    assert_edges_near(
        &rising_edges(&out[0]),
        &[0.0, 0.5, 1.0, 1.5, 2.0],
        1,
        "clock",
    );
    let quarters: Vec<f32> = (0..17).map(|i| i as f32 * 0.125).collect();
    assert_edges_near(&rising_edges(&out[1]), &quarters, 1, "mul4");
}

#[test]
fn clock_divisions_and_bar_track_the_beat() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap(); // 0.25 s per beat
    set_stepped(&mut e, "clk", "beats", 3.0);
    probe(&mut e, 0, "clk", "div4");
    probe(&mut e, 1, "clk", "bar");
    let out = e.render_offline((2.1 * SR) as usize).unwrap();

    // /4 fires every 4 beats = 1 s; the bar output every 3 beats = 0.75 s.
    assert_edges_near(&rising_edges(&out[0]), &[0.0, 1.0, 2.0], 1, "div4");
    assert_edges_near(
        &rising_edges(&out[1]),
        &[0.0, 0.75, 1.5],
        1,
        "bar (3 beats)",
    );
}

#[test]
fn clock_swing_delays_binary_offbeats_only() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.set_knob_value("clk", "bpm", 120.0).unwrap();
    e.set_knob_value("clk", "swing", 1.0).unwrap(); // maximum shuffle: 75 %
    probe(&mut e, 0, "clk", "mul2");
    probe(&mut e, 1, "clk", "clock");
    let out = e.render_offline((1.1 * SR) as usize).unwrap();

    // Off-beats land at 75 % of each beat pair instead of 50 %.
    assert_edges_near(
        &rising_edges(&out[0]),
        &[0.0, 0.375, 0.5, 0.875, 1.0],
        1,
        "mul2 swung",
    );
    // The beat itself stays on the grid.
    assert_edges_near(&rising_edges(&out[1]), &[0.0, 0.5, 1.0], 1, "clock");
}

#[test]
fn clock_pulse_width_is_five_ms_and_clamped_when_fast() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.set_knob_value("clk", "bpm", 120.0).unwrap();
    probe(&mut e, 0, "clk", "clock");
    probe(&mut e, 1, "clk", "mul4");
    let out = e.render_offline((1.0 * SR) as usize).unwrap();
    let nominal = (0.005 * SR) as usize;
    for &run in &high_runs(&out[0]) {
        assert_eq!(run, nominal, "clock pulse width");
    }

    // At 300 BPM the x4 interval is 50 ms, so 5 ms still fits; push the CV
    // up 3 octaves (2400 BPM) and the pulse must clamp to 45 % of 6.25 ms.
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.set_knob_value("clk", "bpm", 300.0).unwrap();
    e.set_knob_value("clk", "cv", 3.0).unwrap();
    probe(&mut e, 0, "clk", "mul4");
    let out = e.render_offline((0.5 * SR) as usize).unwrap();
    let interval = 60.0 / 2400.0 / 4.0 * SR;
    let expect = (0.45 * interval) as usize;
    for &run in &high_runs(&out[0]) {
        assert_eq!(run, expect, "clamped x4 pulse width");
    }
}

#[test]
fn clock_run_gate_stops_and_reset_rephases() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.set_knob_value("clk", "bpm", 120.0).unwrap();
    e.set_knob_position("clk", "run", 0.0).unwrap();
    probe(&mut e, 0, "clk", "clock");
    let stopped = e.render_offline((1.0 * SR) as usize).unwrap();
    assert!(
        stopped[0].iter().all(|&x| x == 0.0),
        "stopped clock emitted pulses"
    );

    // Start it: the first pulse lands immediately, then every 0.5 s.
    e.set_knob_position("clk", "run", 1.0).unwrap();
    let run = e.render_offline((0.7 * SR) as usize).unwrap();
    assert_edges_near(&rising_edges(&run[0]), &[0.0, 0.5], 1, "clock after run");

    // A reset re-phases: a pulse right away, and the grid restarts there.
    e.set_knob_position("clk", "reset", 1.0).unwrap();
    let a = e.render_offline(64).unwrap();
    e.set_knob_position("clk", "reset", 0.0).unwrap();
    let b = e.render_offline((0.6 * SR) as usize).unwrap();
    let mut sig = a[0].clone();
    sig.extend_from_slice(&b[0]);
    assert_edges_near(&rising_edges(&sig), &[0.0, 0.5], 1, "clock after reset");
}
