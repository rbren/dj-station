//! M0 acceptance: patch `MIDI -> ADSR(gate) -> VCA(cv)`,
//! `Osc -> VCA -> Audio Out`, driven by virtual MIDI and rendered offline,
//! produces audio whose amplitude envelope matches the configured ADSR.

const SR: f32 = 48_000.0;

/// Expected normalized envelope (0..1) at time t (seconds since note-on),
/// for linear A/D/S segments and a linear release starting at t_off.
fn expected_env(t: f32, a: f32, d: f32, s: f32, t_off: f32, r: f32) -> f32 {
    if t < 0.0 {
        return 0.0;
    }
    let held = |t: f32| -> f32 {
        if t < a {
            t / a
        } else if t < a + d {
            1.0 - (1.0 - s) * (t - a) / d
        } else {
            s
        }
    };
    if t < t_off {
        held(t)
    } else {
        let level_at_off = held(t_off);
        (level_at_off * (1.0 - (t - t_off) / r)).max(0.0)
    }
}

#[test]
fn midi_adsr_vca_envelope_matches() {
    let (a, d, s, r) = (0.05f32, 0.15f32, 0.5f32, 0.2f32);
    let note_on_t = 0.1f32;
    let note_off_t = 0.6f32;
    let render_t = 1.2f32;

    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);
    engine.set_knob_value("adsr1", "attack", a).unwrap();
    engine.set_knob_value("adsr1", "decay", d).unwrap();
    engine.set_knob_value("adsr1", "sustain", s).unwrap();
    engine.set_knob_value("adsr1", "release", r).unwrap();

    // Virtual MIDI: note 60 on/off at sample-accurate frames.
    engine
        .inject_midi("midi1", (note_on_t * SR) as u64, [0x90, 60, 100])
        .unwrap();
    engine
        .inject_midi("midi1", (note_off_t * SR) as u64, [0x80, 60, 0])
        .unwrap();

    let out = engine.render_offline((render_t * SR) as usize).unwrap();
    let audio = &out[0];

    // Amplitude envelope via 10 ms window peaks. Oscillator amplitude is 5,
    // VCA gain = env/10, so peak = 5 * env_normalized.
    let window = (0.010 * SR) as usize;
    let peaks = crate::common::window_peaks(audio, window);

    let segment_edges = [
        note_on_t,
        note_on_t + a,
        note_on_t + a + d,
        note_off_t,
        note_off_t + (s * r), // release actually completes at t_off + r (level->0)
        note_off_t + r,
    ];
    let mut checked = 0;
    for (i, &peak) in peaks.iter().enumerate() {
        let t_start = i as f32 * 0.010;
        let t_end = t_start + 0.010;
        let t_mid = t_start + 0.005;
        // Skip windows near segment boundaries where windowing blurs edges.
        if segment_edges.iter().any(|&e| (t_mid - e).abs() < 0.02) {
            continue;
        }
        // A window's peak tracks the envelope's max within the window
        // (env is monotone within a segment).
        let env_a = expected_env(t_start - note_on_t, a, d, s, note_off_t - note_on_t, r);
        let env_b = expected_env(t_end - note_on_t, a, d, s, note_off_t - note_on_t, r);
        let expected_peak = 5.0 * env_a.max(env_b);
        assert!(
            (peak - expected_peak).abs() < 0.35,
            "at t={t_mid:.3}s: peak {peak:.3} != expected {expected_peak:.3}"
        );
        checked += 1;
    }
    assert!(checked > 60, "too few windows checked: {checked}");

    // Silence before the note and after release completes.
    assert!(peaks[0] < 1e-6, "expected silence before note-on");
    assert!(
        *peaks.last().unwrap() < 1e-3,
        "expected silence after release"
    );

    // Faster than realtime: sanity-check the offline path is offline.
    // (Render of 1.2 s already completed; assert engine processed all frames.)
    assert_eq!(engine.current_frame(), (render_t * SR) as u64);
}
