//! Behaviour tests for the Clock & Sequencing modules.
//!
//! Each test renders a small patch offline and asserts on the samples: the
//! module outputs under test are wired straight into the two master
//! channels, so `render_offline` hands back their raw signals.

use dj_engine::{Engine, EngineConfig};

const SR: f32 = 48_000.0;

/// Engine with a stereo master used as a two-channel probe.
fn probe_engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 2,
            ..EngineConfig::default()
        },
        crate::common::registry(),
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

    // At 300 BPM the x4 interval is 50 ms, so 5 ms still fits; at 2400 BPM
    // (bpm knob reconfigured past its stock 300 max, as the config menu
    // allows) the pulse must clamp to 45 % of the 6.25 ms interval.
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.set_knob_config(
        "clk",
        "bpm",
        Some(dj_engine::KnobConfig {
            min: 20.0,
            max: 3000.0,
            ..Default::default()
        }),
    )
    .unwrap();
    e.set_knob_value("clk", "bpm", 2400.0).unwrap();
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

// ---------------------------------------------------------------------------
// Clock multiplier
// ---------------------------------------------------------------------------

/// `mult` detent indices, in manifest order: /8 /4 /3 /2 1x 2x 3x 4x 6x 8x.
const MULT_DIV3: f32 = 2.0;
const MULT_DIV2: f32 = 3.0;
const MULT_X4: f32 = 7.0;

/// A 240 BPM master clock (4 Hz, one edge every 0.25 s) feeding a
/// multiplier whose output is probed on master L.
fn clock_mult_patch() -> Engine {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("cm", "com.dj.clock_mult").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap();
    e.connect("clk", "clock", "cm", "clock").unwrap();
    probe(&mut e, 0, "cm", "out");
    e
}

#[test]
fn clock_mult_free_runs_at_two_hz_without_an_input_clock() {
    let mut e = probe_engine();
    e.add_module("cm", "com.dj.clock_mult").unwrap();
    probe(&mut e, 0, "cm", "out");
    let out = e.render_offline((2.05 * SR) as usize).unwrap();

    // Nothing patched into `clock` and the knob at its 1x default: the
    // module is a 2 Hz clock source on its own.
    assert_edges_near(
        &rising_edges(&out[0]),
        &[0.0, 0.5, 1.0, 1.5, 2.0],
        1,
        "free-running clock",
    );
    let nominal = (0.005 * SR) as usize;
    for &run in high_runs(&out[0]).iter().take(4) {
        assert_eq!(run, nominal, "free-running pulse width");
    }
}

#[test]
fn clock_mult_free_run_rate_follows_the_multiplier() {
    let mut e = probe_engine();
    e.add_module("cm", "com.dj.clock_mult").unwrap();
    set_stepped(&mut e, "cm", "mult", MULT_DIV2);
    probe(&mut e, 0, "cm", "out");
    let out = e.render_offline((2.05 * SR) as usize).unwrap();

    // The 2 Hz fallback is an assumed INPUT rate, so the knob still
    // multiplies it: /2 of 2 Hz is one pulse per second.
    assert_edges_near(
        &rising_edges(&out[0]),
        &[0.0, 1.0, 2.0],
        1,
        "free-running /2",
    );
}

#[test]
fn clock_mult_passes_the_clock_through_at_the_default_1x() {
    let mut e = clock_mult_patch();
    let out = e.render_offline((1.55 * SR) as usize).unwrap();

    let beats: Vec<f32> = (0..7).map(|i| i as f32 * 0.25).collect();
    assert_edges_near(&rising_edges(&out[0]), &beats, 1, "1x");
}

#[test]
fn clock_mult_fills_in_pulses_between_clock_edges() {
    let mut e = clock_mult_patch();
    set_stepped(&mut e, "cm", "mult", MULT_X4);
    let out = e.render_offline((1.01 * SR) as usize).unwrap();

    // The interval is unknown until the second edge, so the first beat
    // only carries the pulses the free-running 2 Hz estimate predicts
    // (0.125 s apart); from the second edge on, x4 of 4 Hz is 16 Hz.
    let mut expected = vec![0.0, 0.125];
    expected.extend((0..=12).map(|i| 0.25 + i as f32 * 0.0625));
    // The in-between pulses are interpolated from the measured interval,
    // so they land within a couple of samples of the ideal grid rather
    // than exactly on it (the pulses on clock edges are exact).
    assert_edges_near(&rising_edges(&out[0]), &expected, 4, "x4");
}

#[test]
fn clock_mult_divides_in_step_with_the_clock() {
    let mut e = clock_mult_patch();
    set_stepped(&mut e, "cm", "mult", MULT_DIV2);
    let out = e.render_offline((1.55 * SR) as usize).unwrap();
    assert_edges_near(&rising_edges(&out[0]), &[0.0, 0.5, 1.0, 1.5], 1, "/2");

    // Odd divisions stay exact (no float drift off the third edge).
    let mut e = clock_mult_patch();
    set_stepped(&mut e, "cm", "mult", MULT_DIV3);
    let out = e.render_offline((1.55 * SR) as usize).unwrap();
    assert_edges_near(&rising_edges(&out[0]), &[0.0, 0.75, 1.5], 1, "/3");
}

#[test]
fn clock_mult_falls_back_to_free_running_when_the_clock_stops() {
    let mut e = clock_mult_patch();
    let running = e.render_offline((1.0 * SR) as usize).unwrap();
    assert_edges_near(
        &rising_edges(&running[0]),
        &[0.0, 0.25, 0.5, 0.75],
        1,
        "clocked",
    );

    // Stop the master clock: after four missed intervals (1 s here) the
    // multiplier decides the clock is gone and free-runs at 2 Hz again.
    e.set_knob_position("clk", "run", 0.0).unwrap();
    let out = e.render_offline((2.0 * SR) as usize).unwrap();
    assert_edges_near(
        &rising_edges(&out[0]),
        &[0.75, 1.25, 1.75],
        100,
        "free-running after the clock stopped",
    );
}

// ---------------------------------------------------------------------------
// Poisson clock
// ---------------------------------------------------------------------------

/// Mean inter-event interval (seconds) and its coefficient of variation —
/// the two numbers a gamma renewal process is defined by.
fn interval_stats(edges: &[usize]) -> (f32, f32) {
    assert!(
        edges.len() > 30,
        "too few events to measure: {}",
        edges.len()
    );
    let gaps: Vec<f32> = edges
        .windows(2)
        .map(|w| (w[1] - w[0]) as f32 / SR)
        .collect();
    let mean = gaps.iter().sum::<f32>() / gaps.len() as f32;
    let var = gaps.iter().map(|g| (g - mean) * (g - mean)).sum::<f32>() / gaps.len() as f32;
    (mean, var.sqrt() / mean)
}

/// A Poisson Clock probed on master L, at `rate` Hz and density `k`.
fn poisson_patch(rate: f32, k: f32) -> Engine {
    let mut e = probe_engine();
    e.add_module("pz", "com.dj.poisson").unwrap();
    e.set_knob_value("pz", "rate", rate).unwrap();
    e.set_knob_value("pz", "density", k).unwrap();
    probe(&mut e, 0, "pz", "out");
    e
}

#[test]
fn poisson_clock_at_k_one_has_exponential_intervals() {
    let mut e = poisson_patch(20.0, 1.0);
    let out = e.render_offline((30.0 * SR) as usize).unwrap();
    let (mean, cv) = interval_stats(&rising_edges(&out[0]));

    // k = 1 is the exponential/Poisson case: mean interval 1/rate and a
    // coefficient of variation of exactly 1.
    assert!((mean - 0.05).abs() < 0.005, "mean interval {mean} s");
    assert!((cv - 1.0).abs() < 0.15, "CV {cv}, expected ~1");
}

#[test]
fn poisson_density_sets_the_spread_and_leaves_the_rate_alone() {
    // CV = 1/sqrt(k): clumpy below 1, tightening toward a regular clock
    // above it, with the mean rate untouched throughout.
    for k in [0.25f32, 1.0, 4.0, 16.0] {
        let mut e = poisson_patch(20.0, k);
        let out = e.render_offline((30.0 * SR) as usize).unwrap();
        let (mean, cv) = interval_stats(&rising_edges(&out[0]));
        let want = 1.0 / k.sqrt();
        assert!(
            (mean - 0.05).abs() < 0.008,
            "k {k}: mean interval {mean} s, expected ~0.05"
        );
        assert!(
            (cv - want).abs() < 0.25 * want,
            "k {k}: CV {cv}, expected ~{want}"
        );
    }
}

#[test]
fn poisson_pulses_stay_separate_triggers_even_when_clumped() {
    // k = 1/16 draws gaps far shorter than a sample often enough that a
    // naive gate would fuse whole bursts into one long high — and lose
    // every event inside them. The run is long (10 000 events) because a
    // CV of 4 makes a short one say very little about the mean.
    let mut e = poisson_patch(50.0, 0.0625);
    let out = e.render_offline((200.0 * SR) as usize).unwrap();
    let nominal = (0.005 * SR) as usize;

    for &run in &high_runs(&out[0]) {
        assert!(run >= 1 && run <= nominal, "pulse width {run} samples");
    }
    let (mean, _) = interval_stats(&rising_edges(&out[0]));
    assert!(
        (mean - 0.02).abs() < 0.003,
        "clumped mean interval {mean} s, expected ~0.02 (no events lost)"
    );
}

#[test]
fn poisson_clock_takes_its_mean_rate_from_a_wired_clock() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("pz", "com.dj.poisson").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap(); // 4 Hz
    e.set_knob_value("pz", "rate", 0.05).unwrap(); // far off the clock's
    e.connect("clk", "clock", "pz", "clock").unwrap();
    probe(&mut e, 0, "pz", "out");

    let out = e.render_offline((30.0 * SR) as usize).unwrap();
    let (mean, cv) = interval_stats(&rising_edges(&out[0]));
    assert!(
        (mean - 0.25).abs() < 0.025,
        "mean interval {mean} s, expected ~0.25 (one event per clock pulse)"
    );
    // Still a Poisson process, just one whose rate the clock sets.
    assert!((cv - 1.0).abs() < 0.15, "CV {cv}, expected ~1");
}

#[test]
fn poisson_clock_renders_identically_every_time() {
    let a = poisson_patch(20.0, 1.0)
        .render_offline((2.0 * SR) as usize)
        .unwrap();
    let b = poisson_patch(20.0, 1.0)
        .render_offline((2.0 * SR) as usize)
        .unwrap();
    assert_eq!(a[0], b[0], "fixed-seed randomness must be reproducible");
}

#[test]
fn poisson_clock_bypassed_hands_the_clock_straight_through() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("pz", "com.dj.poisson").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap();
    e.connect("clk", "clock", "pz", "clock").unwrap();
    probe(&mut e, 0, "pz", "out");
    probe(&mut e, 1, "clk", "clock");
    e.set_bypass("pz", true).unwrap();

    let out = e.render_offline((1.05 * SR) as usize).unwrap();
    assert_eq!(
        out[0], out[1],
        "bypassed module must pass the clock through"
    );
    assert_edges_near(
        &rising_edges(&out[0]),
        &[0.0, 0.25, 0.5, 0.75, 1.0],
        1,
        "bypassed clock",
    );
}

// ---------------------------------------------------------------------------
// Step sequencer
// ---------------------------------------------------------------------------

/// Clock + step sequencer, `cv` on master L and `gate` on master R.
fn step_seq_patch(bpm: f32, length: f32, dir: f32) -> Engine {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("seq", "com.dj.step_seq").unwrap();
    e.set_knob_value("clk", "bpm", bpm).unwrap();
    e.connect("clk", "clock", "seq", "clock").unwrap();
    set_stepped(&mut e, "seq", "length", length);
    set_stepped(&mut e, "seq", "dir", dir);
    for (i, v) in [1.0f32, 2.0, 3.0, 4.0].iter().enumerate() {
        e.set_knob_value("seq", &format!("cv{}", i + 1), *v)
            .unwrap();
    }
    probe(&mut e, 0, "seq", "cv");
    probe(&mut e, 1, "seq", "gate");
    e
}

/// CV value sampled just before each gate edge's step boundary.
fn cv_at_edges(cv: &[f32], edges: &[usize]) -> Vec<f32> {
    edges.iter().map(|&i| cv[i + 16]).collect()
}

#[test]
fn step_seq_walks_forward_with_gates_on_every_clock() {
    // 240 BPM: one step every 0.25 s.
    let mut e = step_seq_patch(240.0, 4.0, 0.0);
    let out = e.render_offline((1.1 * SR) as usize).unwrap();
    let edges = rising_edges(&out[1]);
    assert_edges_near(&edges, &[0.0, 0.25, 0.5, 0.75, 1.0], 2, "seq gate");
    let cvs = cv_at_edges(&out[0], &edges);
    for (i, (&got, &want)) in cvs.iter().zip(&[1.0f32, 2.0, 3.0, 4.0, 1.0]).enumerate() {
        assert!((got - want).abs() < 1e-3, "step {i}: cv {got} != {want}");
    }
    // Gate is high for half the step (the first step still uses the 20 ms
    // fallback interval — no two clock edges have been seen yet).
    for &run in &high_runs(&out[1])[1..4] {
        let expect = 0.5 * 0.25 * SR;
        assert!(
            (run as f32 - expect).abs() < 0.1 * expect,
            "gate width {run} != ~{expect}"
        );
    }
}

#[test]
fn step_seq_direction_modes_change_the_step_order() {
    let mut rev = step_seq_patch(240.0, 4.0, 1.0);
    let out = rev.render_offline((1.1 * SR) as usize).unwrap();
    let cvs = cv_at_edges(&out[0], &rising_edges(&out[1]));
    let want = [4.0f32, 3.0, 2.0, 1.0, 4.0];
    for (i, (&got, &w)) in cvs.iter().zip(&want).enumerate() {
        assert!((got - w).abs() < 1e-3, "reverse step {i}: {got} != {w}");
    }

    let mut pp = step_seq_patch(240.0, 4.0, 2.0);
    let out = pp.render_offline((1.7 * SR) as usize).unwrap();
    let cvs = cv_at_edges(&out[0], &rising_edges(&out[1]));
    let want = [1.0f32, 2.0, 3.0, 4.0, 3.0, 2.0, 1.0];
    for (i, (&got, &w)) in cvs.iter().zip(&want).enumerate() {
        assert!((got - w).abs() < 1e-3, "ping-pong step {i}: {got} != {w}");
    }

    // Random: deterministic (fixed seed) but not the forward order.
    let mut rnd = step_seq_patch(240.0, 4.0, 3.0);
    let a = rnd.render_offline((2.1 * SR) as usize).unwrap();
    let a_cvs = cv_at_edges(&a[0], &rising_edges(&a[1]));
    let mut rnd2 = step_seq_patch(240.0, 4.0, 3.0);
    let b = rnd2.render_offline((2.1 * SR) as usize).unwrap();
    let b_cvs = cv_at_edges(&b[0], &rising_edges(&b[1]));
    assert_eq!(a_cvs, b_cvs, "random mode is not deterministic");
    assert!(
        a_cvs.iter().skip(1).any(|v| *v != 2.0),
        "random mode walked forward: {a_cvs:?}"
    );
    assert!(
        a_cvs.iter().all(|v| (1.0..=4.0).contains(v)),
        "random mode left the active length: {a_cvs:?}"
    );
}

#[test]
fn step_seq_gate_off_and_ratchets_shape_the_gate_stream() {
    let mut e = step_seq_patch(240.0, 4.0, 0.0);
    e.set_knob_position("seq", "gate2", 0.0).unwrap(); // step 2 silent
    set_stepped(&mut e, "seq", "ratchet3", 4.0); // step 3 ratcheted x4
    let out = e.render_offline((1.05 * SR) as usize).unwrap();
    let edges = rising_edges(&out[1]);
    // step1, (step2 muted), step3 x4, step4, step1
    assert_edges_near(
        &edges,
        &[
            0.0, 0.5, 0.5625, 0.625, 0.6875, // 4 ratchets inside step 3
            0.75, 1.0,
        ],
        2,
        "ratcheted gates",
    );
}

#[test]
fn step_seq_end_of_sequence_fires_once_per_lap() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("seq", "com.dj.step_seq").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap();
    e.connect("clk", "clock", "seq", "clock").unwrap();
    set_stepped(&mut e, "seq", "length", 4.0);
    probe(&mut e, 0, "seq", "eos");
    probe(&mut e, 1, "seq", "gate");
    let out = e.render_offline((2.3 * SR) as usize).unwrap();
    // Steps at 0, 0.25, ...; the lap restarts on the 5th and 9th clock.
    assert_edges_near(&rising_edges(&out[0]), &[1.0, 2.0], 2, "eos");
}

#[test]
fn step_seq_state_survives_a_hot_reload() {
    let mut e = step_seq_patch(240.0, 4.0, 0.0);
    // Stop 2 ms into the 4th clock pulse, i.e. mid gate and mid clock high.
    let a = e.render_offline((0.752 * SR) as usize).unwrap();
    assert_eq!(e.reload_extension("com.dj.step_seq").unwrap(), 1);
    let b = e.render_offline((0.6 * SR) as usize).unwrap();

    let mut cv = a[0].clone();
    cv.extend_from_slice(&b[0]);
    let mut gate = a[1].clone();
    gate.extend_from_slice(&b[1]);
    let edges = rising_edges(&gate);
    // The reload neither restarts the sequence nor fabricates a clock edge.
    assert_edges_near(
        &edges,
        &[0.0, 0.25, 0.5, 0.75, 1.0, 1.25],
        2,
        "gates across a hot reload",
    );
    let cvs = cv_at_edges(&cv, &edges);
    for (i, (&got, &w)) in cvs
        .iter()
        .zip(&[1.0f32, 2.0, 3.0, 4.0, 1.0, 2.0])
        .enumerate()
    {
        assert!((got - w).abs() < 1e-3, "step {i}: cv {got} != {w}");
    }
}

/// Removing a module is an incremental edit (`Engine::remove_module`) —
/// every OTHER module keeps its live DSP state: the sequencer doesn't
/// reset, free-running LFO phase and turing registers march on.
#[test]
fn removing_an_unrelated_module_does_not_reset_the_sequencer() {
    // step_seq patch plus free-running bystanders (LFO phase, turing
    // register) whose state must also survive the edit.
    let build = || {
        let mut e = step_seq_patch(240.0, 4.0, 0.0);
        e.add_module("lfo1", "com.dj.lfo").unwrap();
        e.add_module("turing1", "com.dj.turing").unwrap();
        e.connect("clk", "clock", "turing1", "clock").unwrap();
        e
    };
    let pre = (0.752 * SR) as usize; // 2 ms into the 4th clock pulse
    let post = (0.6 * SR) as usize;

    let mut e = build();
    let a = e.render_offline(pre).unwrap();

    // Add then remove an UNRELATED module, live, in the same engine.
    e.add_module("junk1", "com.dj.vca").unwrap();
    e.remove_module("junk1").unwrap();
    let b = e.render_offline(post).unwrap();

    // The sequencer continues from step 4 instead of restarting at step 1.
    let mut cv = a[0].clone();
    cv.extend_from_slice(&b[0]);
    let mut gate = a[1].clone();
    gate.extend_from_slice(&b[1]);
    let edges = rising_edges(&gate);
    assert_edges_near(
        &edges,
        &[0.0, 0.25, 0.5, 0.75, 1.0, 1.25],
        2,
        "gates across a remove-module edit",
    );
    let cvs = cv_at_edges(&cv, &edges);
    for (i, (&got, &w)) in cvs
        .iter()
        .zip(&[1.0f32, 2.0, 3.0, 4.0, 1.0, 2.0])
        .enumerate()
    {
        assert!((got - w).abs() < 1e-3, "step {i}: cv {got} != {w}");
    }

    // Bonus: the LFO phase and turing register also survive — the edited
    // engine matches a control engine that rendered straight through.
    let mut control = build();
    control.render_offline(pre + post).unwrap();
    for (module, jack) in [("lfo1", "bi"), ("turing1", "reg")] {
        let got = e.tap_out(module, jack).unwrap().instantaneous;
        let want = control.tap_out(module, jack).unwrap().instantaneous;
        assert!(
            (got - want).abs() < 1e-4,
            "{module}:{jack} reset across the edit: {got} != {want}"
        );
    }
}

/// The playhead strip (StepSeqUI) reads the sequencer's `step` OUTPUT through
/// jack telemetry (`tap_all` -> `signalTap("out:step")`), not DSP state — so
/// telemetry, like DSP state, must survive a remove-module edit or the strip
/// visibly flashes back to step 1. With the incremental `remove_module`,
/// untouched nodes keep their analyzers; nothing resets.
#[test]
fn telemetry_survives_a_remove_module_edit_like_dsp_state_does() {
    let mut e = step_seq_patch(240.0, 4.0, 0.0);
    // Mid-step so the 100 ms telemetry window sits fully inside step 4.
    e.render_offline((0.87 * SR) as usize).unwrap();
    let before = e.tap_out("seq", "step").unwrap().display;
    assert!(
        (before - 3.0).abs() < 0.1,
        "sanity: playhead telemetry on step 4 (index 3): {before}"
    );

    // The app's remove_module flow, now incremental.
    e.add_module("junk1", "com.dj.vca").unwrap();
    e.remove_module("junk1").unwrap();

    // What the frontend's next tap_all poll observes — the playhead source.
    let after = e.tap_out("seq", "step").unwrap().display;
    assert!(
        (after - before).abs() < 0.1,
        "playhead telemetry reset by the edit: step display {before} -> {after} \
         (the UI strip flashes back to step 1)"
    );
}

#[test]
fn step_seq_glide_slews_the_cv_between_steps() {
    let mut e = step_seq_patch(120.0, 2.0, 0.0); // 0.5 s per step, cv 1 -> 2
    e.set_knob_value("seq", "glide", 0.25).unwrap();
    let out = e.render_offline((1.2 * SR) as usize).unwrap();
    let cv = &out[0];
    let at = |t: f32| cv[(t * SR) as usize];
    // Step 2 starts at 0.5 s and glides 1 V -> 2 V over 0.25 s.
    assert!((at(0.49) - 1.0).abs() < 1e-3, "pre-glide {}", at(0.49));
    assert!(
        (at(0.625) - 1.5).abs() < 0.05,
        "mid-glide {} != ~1.5",
        at(0.625)
    );
    assert!((at(0.9) - 2.0).abs() < 1e-3, "post-glide {}", at(0.9));
}

/// The `step` output reports the playing step index (-1 until the first
/// clock) — the panel's playhead source.
#[test]
fn step_seq_step_output_follows_the_playhead() {
    // 240 BPM: one step every 0.25 s, 4-step loop. Swap the gate probe on
    // master R for the step output (wires to one input sum).
    let mut e = step_seq_patch(240.0, 4.0, 0.0);
    e.disconnect("seq", "gate", "probe", "r").unwrap();
    e.connect("seq", "step", "probe", "r").unwrap();
    let out = e.render_offline((1.35 * SR) as usize).unwrap();
    // Steps advance 0,1,2,3 then wrap to 0.
    for (t, want) in [
        (0.1f32, 0.0f32),
        (0.35, 1.0),
        (0.6, 2.0),
        (0.85, 3.0),
        (1.1, 0.0),
    ] {
        let got = out[1][(t * SR) as usize];
        assert_eq!(got, want, "step at {t} s");
    }
}

// ---------------------------------------------------------------------------
// Trigger sequencer
// ---------------------------------------------------------------------------

#[test]
fn trig_seq_reads_the_pattern_bitmask_lsb_first() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("trg", "com.dj.trig_seq").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap(); // 0.25 s per step
    e.connect("clk", "clock", "trg", "clock").unwrap();
    set_stepped(&mut e, "trg", "len1", 4.0);
    e.set_knob_value("trg", "pat1", 9.0).unwrap(); // steps 1 and 4
    probe(&mut e, 0, "trg", "trig1");
    let out = e.render_offline((2.1 * SR) as usize).unwrap();
    assert_edges_near(
        &rising_edges(&out[0]),
        &[0.0, 0.75, 1.0, 1.75, 2.0],
        2,
        "trig1 pattern 0b1001",
    );
}

#[test]
fn trig_seq_tracks_run_at_independent_lengths() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("trg", "com.dj.trig_seq").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap();
    // x2 of 240 BPM = one step every 0.125 s.
    e.connect("clk", "mul2", "trg", "clock").unwrap();
    // Both tracks fire on their own step 1 only, but wrap at 4 and 3 steps.
    e.set_knob_value("trg", "pat1", 1.0).unwrap();
    set_stepped(&mut e, "trg", "len1", 4.0);
    e.set_knob_value("trg", "pat2", 1.0).unwrap();
    set_stepped(&mut e, "trg", "len2", 3.0);
    probe(&mut e, 0, "trg", "trig1");
    probe(&mut e, 1, "trg", "trig2");
    let out = e.render_offline((1.6 * SR) as usize).unwrap();
    assert_edges_near(&rising_edges(&out[0]), &[0.0, 0.5, 1.0, 1.5], 2, "len 4");
    assert_edges_near(
        &rising_edges(&out[1]),
        &[0.0, 0.375, 0.75, 1.125, 1.5],
        2,
        "len 3",
    );
}

/// The `pos` output reports clocks since reset (-1 before the first clock);
/// the panel derives each track's playhead as `pos mod len`.
#[test]
fn trig_seq_pos_output_counts_clocks() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("trg", "com.dj.trig_seq").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap(); // 0.25 s per step
    e.connect("clk", "clock", "trg", "clock").unwrap();
    probe(&mut e, 0, "trg", "pos");
    let out = e.render_offline((1.1 * SR) as usize).unwrap();
    // First clock is at t=0, so pos starts at 0 and increments every 0.25 s.
    for (t, want) in [(0.1f32, 0.0f32), (0.35, 1.0), (0.6, 2.0), (0.85, 3.0)] {
        let got = out[0][(t * SR) as usize];
        assert_eq!(got, want, "pos at {t} s");
    }
}

// ---------------------------------------------------------------------------
// Grid sequencer
// ---------------------------------------------------------------------------

fn grid_engine(bpm: f32) -> Engine {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("grid", "com.dj.grid_seq").unwrap();
    e.set_knob_value("clk", "bpm", bpm).unwrap();
    e.connect("clk", "clock", "grid", "clock").unwrap();
    e
}

#[test]
fn grid_seq_rows_gate_on_their_columns_at_10v() {
    let mut e = grid_engine(240.0); // 0.25 s per column
                                    // Row 1 on columns 1 and 3; row 2 on column 2 (bit 0 = column 1).
    e.set_knob_value("grid", "row1", 0b101 as f32).unwrap();
    e.set_knob_value("grid", "row2", 0b010 as f32).unwrap();
    probe(&mut e, 0, "grid", "out1");
    probe(&mut e, 1, "grid", "out2");
    let out = e.render_offline((1.1 * SR) as usize).unwrap();
    assert_edges_near(&rising_edges(&out[0]), &[0.0, 0.5], 2, "row 1 columns 1+3");
    assert_edges_near(&rising_edges(&out[1]), &[0.25], 2, "row 2 column 2");
    // Default level: on cells read 10 V while the gate window is open.
    assert_eq!(out[0][(0.005 * SR) as usize], 10.0, "gate level");
    assert_eq!(out[1][(0.005 * SR) as usize], 0.0, "off cell stays low");
}

#[test]
fn grid_seq_level_sets_the_gate_voltage() {
    let mut e = grid_engine(240.0);
    e.set_knob_value("grid", "row1", 1.0).unwrap();
    e.set_knob_value("grid", "level", 6.0).unwrap();
    probe(&mut e, 0, "grid", "out1");
    let out = e.render_offline((0.2 * SR) as usize).unwrap();
    assert!(
        (out[0][(0.005 * SR) as usize] - 6.0).abs() < 1e-4,
        "level knob sets the on-cell voltage"
    );
}

#[test]
fn grid_seq_scale_mode_emits_c_major_pitches() {
    let mut e = grid_engine(240.0);
    set_stepped(&mut e, "grid", "mode", 1.0); // scale
                                              // Rows 1 (root C), 3 (E) and 8 (octave C) on column 1.
    e.set_knob_value("grid", "row1", 1.0).unwrap();
    e.set_knob_value("grid", "row3", 1.0).unwrap();
    e.set_knob_value("grid", "row8", 1.0).unwrap();
    probe(&mut e, 0, "grid", "out3");
    probe(&mut e, 1, "grid", "out8");
    let out = e.render_offline((0.2 * SR) as usize).unwrap();
    let at = (0.005 * SR) as usize;
    assert!(
        (out[0][at] - 4.0 / 12.0).abs() < 1e-4,
        "row 3 = E, 4 semitones up"
    );
    assert!((out[1][at] - 1.0).abs() < 1e-4, "row 8 = C an octave up");
}

#[test]
fn grid_seq_wraps_at_16_and_reset_rephases() {
    // 240 BPM x4 = 0.0625 s per column: 1 s per 16-column lap.
    let mut e = grid_engine(240.0);
    e.disconnect("clk", "clock", "grid", "clock").unwrap();
    e.connect("clk", "mul4", "grid", "clock").unwrap();
    e.set_knob_value("grid", "row1", 1.0).unwrap(); // column 1 only
    probe(&mut e, 0, "grid", "pos");
    probe(&mut e, 1, "grid", "out1");
    let out = e.render_offline((2.1 * SR) as usize).unwrap();
    // pos counts clocks; out1 fires when pos % 16 == 0, i.e. once per lap
    // (the wraps at 1 s and 2 s prove the 16-column cycle).
    assert_edges_near(
        &rising_edges(&out[1]),
        &[0.0, 1.0, 2.0],
        3,
        "column 1 once per lap",
    );
    // Sample pos inside the rail (the probe wire clips at ±10 V).
    let pos_at = |t: f32| out[0][(t * SR) as usize];
    assert_eq!(pos_at(0.03), 0.0);
    assert_eq!(pos_at(0.53), 8.0, "pos counts clocks: column 9 mid-lap");
}

#[test]
fn grid_seq_ratchet_bitplanes_retrigger_within_the_column() {
    // 0.25 s per column. Cell (row 1, column 1) on with ratchet count
    // 1 + A + 2B = 4: four pulses spread over the column, each high for
    // half its sub-division. Row 2's plain cell keeps the single
    // half-interval gate.
    let mut e = grid_engine(240.0);
    e.set_knob_value("grid", "row1", 1.0).unwrap();
    e.set_knob_value("grid", "rata1", 1.0).unwrap();
    e.set_knob_value("grid", "ratb1", 1.0).unwrap();
    e.set_knob_value("grid", "row2", 1.0).unwrap();
    probe(&mut e, 0, "grid", "out1");
    probe(&mut e, 1, "grid", "out2");
    // Second lap: the first lap's column 1 fires before an interval has
    // been measured (20 ms default), the second uses the real 0.25 s.
    let out = e.render_offline((4.6 * SR) as usize).unwrap();
    let lap: Vec<usize> = rising_edges(&out[0])
        .into_iter()
        .filter(|&i| i >= (3.9 * SR) as usize && i < (4.3 * SR) as usize)
        .collect();
    assert_edges_near(
        &lap,
        &[4.0, 4.0625, 4.125, 4.1875],
        4,
        "4 ratchet pulses over the column",
    );
    // Each pulse is high for half its sub-division (0.25 s / 4 / 2).
    let runs = high_runs(&out[0][(3.9 * SR) as usize..(4.3 * SR) as usize]);
    assert_eq!(runs.len(), 4);
    for run in &runs {
        assert!(
            run.abs_diff((0.03125 * SR) as usize) <= 4,
            "ratchet pulse width {run}, expected ~{}",
            (0.03125 * SR) as usize
        );
    }
    // The plain cell still gates once, for half the interval.
    let plain = high_runs(&out[1][(3.9 * SR) as usize..(4.3 * SR) as usize]);
    assert_eq!(plain.len(), 1, "no ratchets on a plain cell");
    assert!(plain[0].abs_diff((0.125 * SR) as usize) <= 4);
}

// ---------------------------------------------------------------------------
// Step sequencer cvgate output
// ---------------------------------------------------------------------------

#[test]
fn step_seq_cvgate_is_cv_anded_with_the_gate() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("seq", "com.dj.step_seq").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap(); // 0.25 s per step
    e.connect("clk", "clock", "seq", "clock").unwrap();
    set_stepped(&mut e, "seq", "length", 4.0);
    // Steps: cv 2/3/4/5 with gates on/off/on/off.
    for (i, cv) in [2.0f32, 3.0, 4.0, 5.0].iter().enumerate() {
        e.set_knob_value("seq", &format!("cv{}", i + 1), *cv)
            .unwrap();
        e.set_knob_position(
            "seq",
            &format!("gate{}", i + 1),
            ((i % 2) == 0) as i32 as f32,
        )
        .unwrap();
    }
    probe(&mut e, 0, "seq", "cvgate");
    let out = e.render_offline((1.0 * SR) as usize).unwrap();
    // Gate is high for the first half of each step (the first step's
    // window is the 20 ms default interval, so sample it early).
    let at = |t: f32| out[0][(t * SR) as usize];
    assert!((at(0.005) - 2.0).abs() < 1e-4, "step 1 on: cv passes");
    assert_eq!(at(0.30), 0.0, "step 2 gated off: 0 V");
    assert!((at(0.55) - 4.0).abs() < 1e-4, "step 3 on: cv passes");
    assert_eq!(at(0.80), 0.0, "step 4 gated off: 0 V");
    assert_eq!(at(0.20), 0.0, "gate low half of an on step: 0 V");
}

// ---------------------------------------------------------------------------
// Euclidean generator
// ---------------------------------------------------------------------------

/// Each channel's `stepN` output tracks its own playhead, wrapping at the
/// channel's step count (-1 until the first clock).
#[test]
fn euclid_step_outputs_track_each_channel() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("euc", "com.dj.euclid").unwrap();
    e.set_knob_value("clk", "bpm", 240.0).unwrap(); // 0.25 s per step
    e.connect("clk", "clock", "euc", "clock").unwrap();
    set_stepped(&mut e, "euc", "steps1", 4.0);
    set_stepped(&mut e, "euc", "steps2", 3.0);
    probe(&mut e, 0, "euc", "step1");
    probe(&mut e, 1, "euc", "step2");
    let out = e.render_offline((1.1 * SR) as usize).unwrap();
    for (t, want1, want2) in [
        (0.1f32, 0.0f32, 0.0f32),
        (0.35, 1.0, 1.0),
        (0.6, 2.0, 2.0),
        (0.85, 3.0, 0.0), // ch2 wraps at 3 steps
    ] {
        assert_eq!(out[0][(t * SR) as usize], want1, "step1 at {t} s");
        assert_eq!(out[1][(t * SR) as usize], want2, "step2 at {t} s");
    }
}

#[test]
fn euclid_generates_bjorklund_patterns_with_rotation() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("euc", "com.dj.euclid").unwrap();
    e.set_knob_value("clk", "bpm", 150.0).unwrap();
    // x4 of 150 BPM = one step every 0.1 s.
    e.connect("clk", "mul4", "euc", "clock").unwrap();
    // E(3,8) = x..x..x. on channel 1; the same rotated left by 1 on ch 2.
    set_stepped(&mut e, "euc", "steps1", 8.0);
    set_stepped(&mut e, "euc", "fill1", 3.0);
    set_stepped(&mut e, "euc", "steps2", 8.0);
    set_stepped(&mut e, "euc", "fill2", 3.0);
    set_stepped(&mut e, "euc", "rot2", 1.0);
    probe(&mut e, 0, "euc", "ch1");
    probe(&mut e, 1, "euc", "ch2");
    let out = e.render_offline((1.65 * SR) as usize).unwrap();
    assert_edges_near(
        &rising_edges(&out[0]),
        &[0.0, 0.3, 0.6, 0.8, 1.1, 1.4, 1.6],
        2,
        "E(3,8)",
    );
    assert_edges_near(
        &rising_edges(&out[1]),
        &[0.2, 0.5, 0.7, 1.0, 1.3, 1.5],
        2,
        "E(3,8) rotated",
    );
}

#[test]
fn euclid_or_output_merges_the_channels() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("euc", "com.dj.euclid").unwrap();
    e.set_knob_value("clk", "bpm", 150.0).unwrap();
    e.connect("clk", "mul4", "euc", "clock").unwrap();
    for (ch, (steps, fill)) in [(4.0f32, 1.0f32), (4.0, 2.0)].iter().enumerate() {
        set_stepped(&mut e, "euc", &format!("steps{}", ch + 1), *steps);
        set_stepped(&mut e, "euc", &format!("fill{}", ch + 1), *fill);
    }
    // Channels 3 and 4 silent.
    set_stepped(&mut e, "euc", "fill3", 0.0);
    set_stepped(&mut e, "euc", "fill4", 0.0);
    probe(&mut e, 0, "euc", "or");
    probe(&mut e, 1, "euc", "ch2");
    let out = e.render_offline((0.85 * SR) as usize).unwrap();
    // E(1,4) = x... and E(2,4) = x.x. -> union fires on steps 1 and 3.
    assert_edges_near(&rising_edges(&out[0]), &[0.0, 0.2, 0.4, 0.6, 0.8], 2, "or");
    assert_edges_near(
        &rising_edges(&out[1]),
        &[0.0, 0.2, 0.4, 0.6, 0.8],
        2,
        "E(2,4)",
    );
}

// ---------------------------------------------------------------------------
// Random CV (Turing machine)
// ---------------------------------------------------------------------------

/// Sample the CV output once per clock step (steps last `step_secs`).
fn sample_per_step(cv: &[f32], step_secs: f32, count: usize) -> Vec<f32> {
    (0..count)
        .map(|i| cv[((i as f32 + 0.5) * step_secs * SR) as usize])
        .collect()
}

fn turing_engine(prob_pos: f32, length: f32) -> Engine {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("trn", "com.dj.turing").unwrap();
    e.set_knob_value("clk", "bpm", 150.0).unwrap();
    // x4 of 150 BPM = one clock every 0.1 s.
    e.connect("clk", "mul4", "trn", "clock").unwrap();
    e.set_knob_position("trn", "prob", prob_pos).unwrap();
    set_stepped(&mut e, "trn", "length", length);
    probe(&mut e, 0, "trn", "cv");
    probe(&mut e, 1, "trn", "quant");
    e
}

#[test]
fn turing_centre_probability_locks_the_loop() {
    let mut e = turing_engine(0.5, 8.0);
    let out = e.render_offline((2.5 * SR) as usize).unwrap();
    let vals = sample_per_step(&out[0], 0.1, 24);
    for i in 0..16 {
        assert_eq!(
            vals[i],
            vals[i + 8],
            "locked loop changed between step {i} and {}",
            i + 8
        );
    }
    assert!(
        vals[..8].iter().any(|v| *v != vals[0]),
        "locked loop is a constant: {:?}",
        &vals[..8]
    );
}

#[test]
fn turing_full_cw_inverts_the_loop_each_pass() {
    let mut e = turing_engine(1.0, 8.0);
    let out = e.render_offline((2.5 * SR) as usize).unwrap();
    let vals = sample_per_step(&out[0], 0.1, 24);
    // Always flipping gives a 2N-long loop: pass 3 repeats pass 1.
    for i in 0..8 {
        assert_eq!(vals[i], vals[i + 16], "period is not 2 * length at {i}");
        assert_ne!(vals[i], vals[i + 8], "pass 2 was not inverted at {i}");
    }
}

#[test]
fn turing_full_ccw_keeps_randomizing_and_stays_deterministic() {
    let mut e = turing_engine(0.0, 8.0);
    let out = e.render_offline((2.5 * SR) as usize).unwrap();
    let vals = sample_per_step(&out[0], 0.1, 24);
    assert!(
        (0..16).any(|i| vals[i] != vals[i + 8]),
        "fully random knob produced a locked loop"
    );
    let mut again = turing_engine(0.0, 8.0);
    let out2 = again.render_offline((2.5 * SR) as usize).unwrap();
    assert_eq!(
        vals,
        sample_per_step(&out2[0], 0.1, 24),
        "PRNG is not deterministic"
    );
}

/// The `reg` output mirrors the shift register (the panel's bit-lamp
/// source): integer 0..65535, low byte consistent with `cv`. The raw
/// register exceeds the ±10 V input rail, so the probe input is
/// attenuated (inputs hard-clip at the rail; the panel reads `reg`
/// through the pre-clip output telemetry instead).
#[test]
fn turing_reg_output_mirrors_the_register() {
    const REG_SCALE: f32 = 1.0 / 8192.0; // 65535 * scale < 10 V rail
    let mut e = turing_engine(0.0, 8.0);
    e.disconnect("trn", "quant", "probe", "r").unwrap();
    e.connect("trn", "reg", "probe", "r").unwrap();
    e.set_knob_atten_offset("probe", "r", REG_SCALE, 0.0)
        .unwrap();
    e.set_knob_value("trn", "range", 10.0).unwrap();
    let out = e.render_offline((2.5 * SR) as usize).unwrap();
    let cv = sample_per_step(&out[0], 0.1, 24);
    let reg: Vec<f32> = sample_per_step(&out[1], 0.1, 24)
        .iter()
        .map(|v| (v / REG_SCALE).round())
        .collect();
    let mut distinct = std::collections::BTreeSet::new();
    for (i, (&r, &c)) in reg.iter().zip(&cv).enumerate() {
        assert_eq!(r, r.round(), "step {i}: reg {r} is not an integer");
        assert!((0.0..=65535.0).contains(&r), "step {i}: reg {r} off-range");
        let low = (r as u32) & 0xFF;
        let want_cv = low as f32 / 255.0 * 10.0;
        assert!(
            (c - want_cv).abs() < 1e-4,
            "step {i}: cv {c} disagrees with reg low byte {low}"
        );
        distinct.insert(r as u32);
    }
    assert!(distinct.len() > 1, "register never shifted");
}

#[test]
fn turing_quantizer_snaps_to_the_selected_scale() {
    let mut e = turing_engine(0.0, 16.0);
    e.set_knob_value("trn", "range", 4.0).unwrap();
    set_stepped(&mut e, "trn", "scale", 1.0); // major
    set_stepped(&mut e, "trn", "root", 2.0); // D
    let out = e.render_offline((2.5 * SR) as usize).unwrap();
    let raw = sample_per_step(&out[0], 0.1, 24);
    let quant = sample_per_step(&out[1], 0.1, 24);
    const MAJOR: [i32; 7] = [0, 2, 4, 5, 7, 9, 11];
    for (r, q) in raw.iter().zip(&quant) {
        let semis = (q * 12.0).round() as i32;
        assert!(
            ((semis as f32 / 12.0) - q).abs() < 1e-4,
            "quantized value {q} is not a semitone"
        );
        let pc = (semis - 2).rem_euclid(12);
        assert!(
            MAJOR.contains(&pc),
            "quantized {q} (pc {pc}) is outside D major"
        );
        // Major scale: at most a whole-tone gap, so the snap never moves
        // more than one semitone plus the initial rounding.
        assert!(
            (q - r).abs() <= 1.5 / 12.0 + 1e-4,
            "quantized {q} moved too far from raw {r}"
        );
    }
    assert!(
        quant.iter().any(|q| *q != quant[0]),
        "quantized output never moved"
    );
}

#[test]
fn turing_bit_outputs_follow_the_register() {
    let mut e = probe_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("trn", "com.dj.turing").unwrap();
    e.set_knob_value("clk", "bpm", 150.0).unwrap();
    e.connect("clk", "mul4", "trn", "clock").unwrap();
    e.set_knob_position("trn", "prob", 0.5).unwrap();
    set_stepped(&mut e, "trn", "length", 4.0);
    probe(&mut e, 0, "trn", "bit1");
    probe(&mut e, 1, "trn", "bit2");
    let out = e.render_offline((2.5 * SR) as usize).unwrap();
    let bit1 = sample_per_step(&out[0], 0.1, 24);
    let bit2 = sample_per_step(&out[1], 0.1, 24);
    assert!(
        bit1.iter().all(|v| *v == 0.0 || *v == 10.0),
        "bit gate is not a 0/10 gate"
    );
    // Bit 2 is bit 1 delayed by one clock (the register shifts left).
    for i in 0..20 {
        assert_eq!(bit2[i + 1], bit1[i], "bit2 is not bit1 delayed at {i}");
    }
    // A locked 4-bit loop repeats every 4 clocks.
    for i in 0..16 {
        assert_eq!(bit1[i], bit1[i + 4], "4-step loop broke at {i}");
    }
}
