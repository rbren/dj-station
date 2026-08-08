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

// ---------------------------------------------------------------------------
// Euclidean generator
// ---------------------------------------------------------------------------

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
