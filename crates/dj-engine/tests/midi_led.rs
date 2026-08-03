//! MIDI LED feedback (PRD §7.1, M4): module signals drive note/CC out
//! messages toward the controller. No hardware here, so the tests use the
//! engine's message generation + the mock/virtual MIDI output sink.

mod common;

use dj_engine::{MidiOutEvent, MockMidiSink};

const SR: f32 = 48_000.0;

/// Patch under test: a CC-mapped output jack on the MIDI node wired back
/// into one of its LED input jacks — virtual injection drives the control,
/// the LED mapping turns the signal back into out-messages.
fn led_engine(led_kind: &str, led_num: u8) -> dj_engine::Engine {
    let mut e = common::default_engine();
    e.add_module("midi1", "builtin.midi").unwrap();
    e.add_midi_mapping("midi1", "cc", 1, "fader").unwrap();
    e.add_midi_led_mapping("midi1", led_kind, led_num, "led_a")
        .unwrap();
    e.connect("midi1", "fader", "midi1", "led_a").unwrap();
    e
}

#[test]
fn cc_led_emits_on_change_only() {
    let mut e = led_engine("cc", 7);

    // Initial state sync: exactly one CC 7 = 0 message (value starts at 0,
    // which maps CC 0..127 -> -10 -> clamped to 0... the *wire* carries the
    // mapped output, whose initial value is 0.0 -> LED byte 0).
    e.process_blocks(20).unwrap();
    let events = e.drain_midi_out("midi1").unwrap();
    assert_eq!(
        events.iter().map(|e| e.data).collect::<Vec<_>>(),
        vec![[0xB0, 7, 0]],
        "initial sync should emit exactly one message: {events:?}"
    );

    // CC 1 = 127 -> mapped jack +10.0 -> LED CC value 127.
    let frame = e.current_frame();
    e.inject_midi("midi1", frame, [0xB0, 1, 127]).unwrap();
    e.process_blocks(20).unwrap();
    let events = e.drain_midi_out("midi1").unwrap();
    assert_eq!(
        events.iter().map(|e| e.data).collect::<Vec<_>>(),
        vec![[0xB0, 7, 127]],
        "one change -> one message: {events:?}"
    );

    // No further changes -> no further messages, however long we run.
    e.process_blocks(200).unwrap();
    assert!(e.drain_midi_out("midi1").unwrap().is_empty());

    // Mid-scale: CC 1 = 96 maps to +5.12 signal -> LED byte 65.
    let frame = e.current_frame();
    e.inject_midi("midi1", frame, [0xB0, 1, 96]).unwrap();
    e.process_blocks(20).unwrap();
    let events = e.drain_midi_out("midi1").unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data[0], 0xB0);
    assert_eq!(events[0].data[1], 7);
    let v = events[0].data[2];
    assert!((64..=66).contains(&v), "expected ~65, got {v}");
}

#[test]
fn note_led_emits_gate_on_and_off() {
    let mut e = led_engine("note", 36);

    // Initial state: gate low -> one note-off.
    e.process_blocks(10).unwrap();
    let events = e.drain_midi_out("midi1").unwrap();
    assert_eq!(
        events.iter().map(|e| e.data).collect::<Vec<_>>(),
        vec![[0x80, 36, 0]]
    );

    // Drive high (CC 1 = 127 -> +10 signal >= gate 1.0) -> note on, vel 127.
    let frame = e.current_frame();
    e.inject_midi("midi1", frame, [0xB0, 1, 127]).unwrap();
    e.process_blocks(10).unwrap();
    let events = e.drain_midi_out("midi1").unwrap();
    assert_eq!(
        events.iter().map(|e| e.data).collect::<Vec<_>>(),
        vec![[0x90, 36, 127]]
    );

    // Back low -> note off, exactly once.
    let frame = e.current_frame();
    e.inject_midi("midi1", frame, [0xB0, 1, 0]).unwrap();
    e.process_blocks(50).unwrap();
    let events = e.drain_midi_out("midi1").unwrap();
    assert_eq!(
        events.iter().map(|e| e.data).collect::<Vec<_>>(),
        vec![[0x80, 36, 0]]
    );
}

#[test]
fn led_messages_flow_into_a_mock_sink() {
    let mut e = led_engine("cc", 20);
    let mut sink = MockMidiSink::default();
    e.process_blocks(10).unwrap();
    let frame = e.current_frame();
    e.inject_midi("midi1", frame, [0xB0, 1, 127]).unwrap();
    e.process_blocks(10).unwrap();
    let n = e.pump_midi_out("midi1", &mut sink).unwrap();
    assert_eq!(n, 2);
    assert_eq!(
        sink.events
            .iter()
            .map(|e: &MidiOutEvent| e.data)
            .collect::<Vec<_>>(),
        vec![[0xB0, 20, 0], [0xB0, 20, 127]]
    );
    // Frames are on the engine sample clock and non-decreasing.
    assert!(sink.events[0].frame <= sink.events[1].frame);
}

#[test]
fn led_mappings_and_wiring_roundtrip_through_patch_save_load() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut e = led_engine("cc", 7);
        e.save_patch(dir.path(), "led-patch").unwrap();
    }
    let mut e = dj_engine::Engine::load_patch(dir.path(), common::registry()).unwrap();

    // Mapping restored with its name and wiring intact: driving the fader
    // still emits LED messages.
    let info = e
        .nodes
        .iter()
        .find(|n| n.instance_id == "midi1")
        .unwrap()
        .midi_led_mappings
        .clone();
    assert_eq!(info.len(), 1);
    assert_eq!(info[0].name, "led_a");
    assert_eq!(info[0].kind, "cc");
    assert_eq!(info[0].num, 7);

    e.process_blocks(10).unwrap();
    e.drain_midi_out("midi1").unwrap();
    let frame = e.current_frame();
    e.inject_midi("midi1", frame, [0xB0, 1, 127]).unwrap();
    e.process_blocks(10).unwrap();
    let events = e.drain_midi_out("midi1").unwrap();
    assert_eq!(
        events.iter().map(|e| e.data).collect::<Vec<_>>(),
        vec![[0xB0, 7, 127]]
    );

    // And the save is stable: re-saving the loaded engine changes nothing.
    let resaved = tempfile::tempdir().unwrap();
    e.save_patch(resaved.path(), "led-patch").unwrap();
    let a = std::fs::read_to_string(dir.path().join("modules/midi1.json")).unwrap();
    let b = std::fs::read_to_string(resaved.path().join("modules/midi1.json")).unwrap();
    assert_eq!(a, b);
}

#[test]
fn removing_a_led_mapping_stops_emission_and_drops_wires() {
    let mut e = led_engine("cc", 7);
    e.process_blocks(10).unwrap();
    e.drain_midi_out("midi1").unwrap();

    e.remove_midi_led_mapping("midi1", "led_a").unwrap();
    assert!(e.wire_specs().is_empty(), "LED wire should be dropped");
    let frame = e.current_frame();
    e.inject_midi("midi1", frame, [0xB0, 1, 127]).unwrap();
    e.process_blocks(50).unwrap();
    assert!(e.drain_midi_out("midi1").unwrap().is_empty());

    // The slot is reusable and re-syncs from scratch.
    e.add_midi_led_mapping("midi1", "cc", 8, "led_b").unwrap();
    e.connect("midi1", "fader", "midi1", "led_b").unwrap();
    e.process_blocks(10).unwrap();
    let events = e.drain_midi_out("midi1").unwrap();
    assert_eq!(
        events.iter().map(|e| e.data).collect::<Vec<_>>(),
        vec![[0xB0, 8, 127]],
        "reused slot must re-emit current state: {events:?}"
    );
}

#[test]
fn led_emission_works_while_running_realtime() {
    let mut e = led_engine("cc", 7);
    e.start_null_realtime().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(100));
    let frame = (0.05 * SR) as u64;
    e.inject_midi("midi1", frame, [0xB0, 1, 127]).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let events = e.drain_midi_out("midi1").unwrap();
    e.stop().unwrap();
    assert_eq!(
        events.iter().map(|e| e.data).collect::<Vec<_>>(),
        vec![[0xB0, 7, 0], [0xB0, 7, 127]]
    );
}
