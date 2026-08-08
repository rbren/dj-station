//! Polyphonic MIDI-to-CV on the built-in MIDI module (PRD §7.1): voice
//! allocation with stealing, velocity, pitch bend / mod wheel / sustain,
//! and the transport + clock outputs.

mod common;

use dj_engine::{Engine, EngineConfig};

const SR: f32 = 48_000.0;

/// Patch every poly/global jack of a MIDI module into its own audio-out
/// channel so `render_offline` exposes the raw control values per sample.
fn poly_engine(jacks: &[&str]) -> Engine {
    let config = EngineConfig {
        master_channels: jacks.len(),
        ..EngineConfig::default()
    };
    let mut engine = Engine::new(config, common::registry()).unwrap();
    engine.add_module("midi1", "builtin.midi").unwrap();
    for (i, jack) in jacks.iter().enumerate() {
        let out = format!("out{i}");
        engine.add_module(&out, "builtin.audio_out").unwrap();
        engine
            .set_knob_value(&out, "channel_offset", i as f32)
            .unwrap();
        engine.connect("midi1", jack, &out, "l").unwrap();
    }
    engine
}

fn at(buf: &[f32], t: f32) -> f32 {
    buf[(t * SR) as usize]
}

#[test]
fn voices_allocate_round_robin_with_pitch_gate_velocity() {
    let mut engine = poly_engine(&[
        "v1_pitch", "v1_gate", "v1_vel", "v2_pitch", "v2_gate", "v2_vel", "v3_pitch", "v3_gate",
    ]);
    // Three notes stacked, then the middle one released.
    engine.inject_midi("midi1", 0, [0x90, 60, 127]).unwrap(); // C4 -> voice 1
    engine.inject_midi("midi1", 4800, [0x90, 72, 64]).unwrap(); // C5 -> voice 2
    engine.inject_midi("midi1", 9600, [0x90, 48, 64]).unwrap(); // C3 -> voice 3
    engine.inject_midi("midi1", 14400, [0x80, 72, 0]).unwrap(); // release C5

    let out = engine.render_offline((0.5 * SR) as usize).unwrap();
    let (v1p, v1g, v1v) = (&out[0], &out[1], &out[2]);
    let (v2p, v2g, v2v) = (&out[3], &out[4], &out[5]);
    let (v3p, v3g) = (&out[6], &out[7]);

    // C4 is 0 V, C5 is +1 V, C3 is -1 V (1 V/oct, C4 = 0).
    assert_eq!(at(v1p, 0.05), 0.0);
    assert_eq!(at(v1g, 0.05), 10.0);
    assert_eq!(at(v1v, 0.05), 10.0); // velocity 127 -> 10 V
    assert!((at(v2p, 0.15) - 1.0).abs() < 1e-6);
    assert_eq!(at(v2g, 0.15), 10.0);
    assert!((at(v2v, 0.15) - 64.0 / 127.0 * 10.0).abs() < 1e-4);
    assert!((at(v3p, 0.25) + 1.0).abs() < 1e-6);
    assert_eq!(at(v3g, 0.25), 10.0);

    // Voice 2's gate falls on note-off; the others keep holding.
    assert_eq!(at(v2g, 0.4), 0.0);
    assert_eq!(at(v1g, 0.4), 10.0);
    assert_eq!(at(v3g, 0.4), 10.0);
}

#[test]
fn fifth_note_steals_the_oldest_voice() {
    let mut engine = poly_engine(&["v1_pitch", "v1_gate", "v2_pitch", "v3_pitch", "v4_pitch"]);
    for (i, note) in [60u8, 62, 64, 65].into_iter().enumerate() {
        engine
            .inject_midi("midi1", i as u64 * 2400, [0x90, note, 100])
            .unwrap();
    }
    // A fifth note with all four voices held steals voice 1 (the oldest).
    engine.inject_midi("midi1", 12000, [0x90, 67, 100]).unwrap();

    let out = engine.render_offline((0.4 * SR) as usize).unwrap();
    assert_eq!(at(&out[0], 0.1), 0.0); // voice 1 held C4
    let g = 7.0 / 12.0; // G4
    assert!(
        (at(&out[0], 0.35) - g).abs() < 1e-6,
        "voice 1 should be stolen"
    );
    assert_eq!(at(&out[1], 0.35), 10.0, "stolen voice re-gates");
    // The other voices keep their notes.
    assert!((at(&out[2], 0.35) - 2.0 / 12.0).abs() < 1e-6);
    assert!((at(&out[3], 0.35) - 4.0 / 12.0).abs() < 1e-6);
    assert!((at(&out[4], 0.35) - 5.0 / 12.0).abs() < 1e-6);
}

#[test]
fn mod_bend_pressure_and_sustain_drive_global_jacks() {
    let mut engine = poly_engine(&["mod", "bend", "pressure", "sustain", "v1_gate"]);
    engine.inject_midi("midi1", 0, [0x90, 60, 100]).unwrap();
    engine.inject_midi("midi1", 2400, [0xB0, 1, 127]).unwrap(); // mod wheel max
    engine.inject_midi("midi1", 2400, [0xD0, 64, 0]).unwrap(); // aftertouch
    engine
        .inject_midi("midi1", 4800, [0xE0, 0x00, 0x7F])
        .unwrap(); // bend max
    engine.inject_midi("midi1", 7200, [0xB0, 64, 127]).unwrap(); // sustain on
    engine.inject_midi("midi1", 9600, [0x80, 60, 0]).unwrap(); // note off (held)
    engine.inject_midi("midi1", 14400, [0xB0, 64, 0]).unwrap(); // sustain off

    let out = engine.render_offline((0.4 * SR) as usize).unwrap();
    assert_eq!(at(&out[0], 0.1), 10.0, "mod wheel");
    assert!(at(&out[1], 0.15) > 4.9, "bend near +5 V");
    assert!(
        (at(&out[2], 0.1) - 64.0 / 127.0 * 10.0).abs() < 1e-4,
        "pressure"
    );
    assert_eq!(at(&out[3], 0.18), 10.0, "sustain pedal high");

    // The gate is held past note-off by sustain, and drops when it lifts.
    assert_eq!(at(&out[4], 0.25), 10.0, "sustained note keeps gating");
    assert_eq!(at(&out[4], 0.35), 0.0, "gate falls when sustain lifts");
}

#[test]
fn transport_and_clock_emit_triggers() {
    let mut engine = poly_engine(&["clock", "beat", "transport"]);
    engine.inject_midi("midi1", 0, [0xFA, 0, 0]).unwrap(); // start
                                                           // 24 ticks = one beat; tick 0 and tick 24 both fire `beat`.
    for i in 0..25u64 {
        engine.inject_midi("midi1", i * 2000, [0xF8, 0, 0]).unwrap();
    }
    engine.inject_midi("midi1", 52000, [0xFC, 0, 0]).unwrap(); // stop

    let out = engine.render_offline((1.2 * SR) as usize).unwrap();
    // A pulse starting at sample 0 has no rising edge inside the buffer.
    let count_pulses = |buf: &[f32]| {
        usize::from(buf[0] >= 5.0) + buf.windows(2).filter(|w| w[0] < 5.0 && w[1] >= 5.0).count()
    };
    assert_eq!(count_pulses(&out[0]), 25, "one clock trigger per tick");
    assert_eq!(count_pulses(&out[1]), 2, "beat fires on ticks 0 and 24");
    assert_eq!(at(&out[2], 0.5), 10.0, "transport runs after start");
    assert_eq!(at(&out[2], 1.15), 0.0, "transport stops after stop");
}

#[test]
fn all_notes_off_clears_every_voice() {
    let mut engine = poly_engine(&["v1_gate", "v2_gate", "v3_gate"]);
    for (i, note) in [60u8, 64, 67].into_iter().enumerate() {
        engine
            .inject_midi("midi1", i as u64 * 1000, [0x90, note, 100])
            .unwrap();
    }
    engine.inject_midi("midi1", 9600, [0xB0, 123, 0]).unwrap();

    let out = engine.render_offline((0.4 * SR) as usize).unwrap();
    for (i, buf) in out.iter().enumerate() {
        assert_eq!(at(buf, 0.15), 10.0, "voice {} should be gated", i + 1);
        assert_eq!(at(buf, 0.3), 0.0, "voice {} should be cleared", i + 1);
    }
}
