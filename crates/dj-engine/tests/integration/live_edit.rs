//! Live structural edits: module add/remove and wire connect/disconnect
//! while the RT backend is RUNNING. Edits ship over the command ring as
//! pre-allocated `GraphEdit`s and land at a block boundary — the backend is
//! never stopped, so there is no audio gap (this used to be a
//! stop -> edit -> restart cycle, audible as a blip on every rack edit).

use std::time::Duration;

/// Sleep long enough for the null backend to process several blocks (and
/// fill the 100 ms telemetry RMS window).
fn settle() {
    std::thread::sleep(Duration::from_millis(200));
}

#[test]
fn add_wire_and_remove_while_running() {
    let mut e = crate::common::default_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "out1", "l").unwrap();

    e.start_null_realtime().unwrap();
    settle();
    let blocks_before = e.blocks_processed();

    // Structural edits with the backend running: previously these errored
    // ("engine is running; stop it first") and the GUI had to stop/restart
    // the stream around them.
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.set_knob_position("vca1", "cv", 1.0).unwrap();
    e.disconnect("osc1", "audio", "out1", "l").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    assert!(e.is_running(), "engine must stay running across live edits");

    settle();
    assert!(
        e.blocks_processed() > blocks_before,
        "blocks kept flowing across the edits"
    );
    let rms = e.tap_master(0).unwrap().rms_100ms;
    assert!(rms > 0.5, "audio flows through the live-edited path: {rms}");

    // Remove while running: the vca goes away, the master falls silent,
    // and the graph keeps processing.
    e.remove_module("vca1").unwrap();
    assert!(e.is_running());
    settle();
    let rms = e.tap_master(0).unwrap().rms_100ms;
    assert!(rms < 1e-3, "removing the vca silences the master: {rms}");

    e.stop().unwrap();
}

#[test]
fn building_a_patch_from_scratch_while_running() {
    // Every add grows the graph's slot storage live (the growth vectors
    // ship inside the edit — the RT thread never reallocates).
    let mut e = crate::common::default_engine();
    e.start_null_realtime().unwrap();
    settle();

    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "out1", "l").unwrap();
    settle();

    let rms = e.tap_master(0).unwrap().rms_100ms;
    assert!(rms > 0.5, "patch built live produces audio: {rms}");
    e.stop().unwrap();
}

#[test]
fn live_remove_recycles_the_slot_for_the_next_add() {
    let mut e = crate::common::default_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.start_null_realtime().unwrap();

    e.add_module("vca1", "com.dj.vca").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    // The only wire in the patch is osc1 -> vca; its to_node is the slot.
    let vca1_slot = e.wire_specs()[0].to_node;

    e.remove_module("vca1").unwrap();
    assert!(e.wire_specs().is_empty());

    // The next add (still running) reuses the tombstoned slot, and wires
    // resolve to it with fresh telemetry/state.
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.connect("osc1", "audio", "vca2", "in").unwrap();
    assert_eq!(
        e.wire_specs()[0].to_node,
        vca1_slot,
        "slot must be recycled"
    );

    settle();
    let tap = e.tap("vca2", "in").unwrap();
    assert!(
        tap.rms_100ms > 0.5,
        "recycled slot carries the new wire's audio: {tap:?}"
    );
    e.stop().unwrap();
}

#[test]
fn rapid_live_edits_never_starve_the_rt_thread() {
    // Hammer structural edits against a running backend: the RT thread
    // must keep making its processing deadline (edits are applied at block
    // boundaries from pre-allocated payloads; the CPU-time based
    // proc-deadline counter is robust to host preemption).
    let mut e = crate::common::default_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "out1", "l").unwrap();
    e.start_null_realtime().unwrap();

    for i in 0..30 {
        let id = format!("vca{i}");
        e.add_module(&id, "com.dj.vca").unwrap();
        e.connect("osc1", "audio", &id, "in").unwrap();
        if i % 2 == 0 {
            e.disconnect("osc1", "audio", &id, "in").unwrap();
            e.remove_module(&id).unwrap();
        }
    }
    settle();
    e.stop().unwrap();

    assert_eq!(
        e.proc_deadline_miss_count(),
        0,
        "live edits must not blow the RT processing budget"
    );
    assert!(e.blocks_processed() > 0);
}
