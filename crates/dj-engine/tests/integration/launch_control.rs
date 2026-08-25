//! The Launch Control XL module in the engine graph: surface messages in,
//! held CV out. Knobs/faders land as unipolar volts and buttons as gates
//! at wired inputs, values hold between messages, the surface has exactly
//! ONE owner at a time (the `active` param, which the device feed
//! respects), and the node — ownership included — round-trips through the
//! patch directory format.
//!
//! Everything here runs on the synthetic feed: no hardware is ever
//! touched, so CI is identical with and without a controller plugged in.

use dj_engine::launch_control::{
    jack_id, jack_index, row, BUTTON_GATE_VOLTS, COLUMNS, LAUNCH_CONTROL_ID, N_LC_JACKS,
};
use dj_engine::Engine;

/// Column 1's Send A knob CC and the two button notes, for readability.
const C1_SEND_A_CC: u8 = 13;
const C1_FADER_CC: u8 = 77;
const C1_FOCUS_NOTE: u8 = 41;
const C1_CTRL_NOTE: u8 = 73;

/// A Launch Control node with a scope on each named jack so values are
/// observable via telemetry (plain `in`, additive wire law).
fn rigged_engine(instance: &str, jacks: &[&str]) -> Engine {
    let mut engine = crate::common::default_engine();
    engine.add_module(instance, LAUNCH_CONTROL_ID).unwrap();
    for jack in jacks {
        let scope = format!("scope_{jack}");
        engine.add_module(&scope, "com.dj.scope").unwrap();
        engine.connect(instance, jack, &scope, "in").unwrap();
    }
    engine
}

fn read(engine: &Engine, jack: &str) -> f32 {
    engine
        .tap(&format!("scope_{jack}"), "in")
        .unwrap()
        .instantaneous
}

/// Send one surface message straight to a module and let it land.
fn inject(engine: &mut Engine, instance: &str, data: [u8; 3]) {
    let frame = engine.current_frame();
    engine.launchcontrol_inject(instance, frame, data).unwrap();
    engine.process_blocks(2).unwrap();
}

#[test]
fn knobs_faders_and_buttons_land_at_wired_inputs() {
    let mut engine = rigged_engine("lcxl1", &["c1_a", "c1_fader", "c1_focus", "c1_ctrl"]);

    inject(&mut engine, "lcxl1", [0xB8, C1_SEND_A_CC, 127]);
    inject(&mut engine, "lcxl1", [0xB8, C1_FADER_CC, 64]);
    assert_eq!(read(&engine, "c1_a"), 10.0, "knob full scale is 10 V");
    let fader = read(&engine, "c1_fader");
    assert!(
        (fader - 64.0 / 127.0 * 10.0).abs() < 1e-5,
        "fader midway must be unipolar volts, got {fader}"
    );
    assert_eq!(read(&engine, "c1_focus"), 0.0, "untouched button is low");

    // Buttons are momentary gates.
    inject(&mut engine, "lcxl1", [0x98, C1_FOCUS_NOTE, 127]);
    inject(&mut engine, "lcxl1", [0x98, C1_CTRL_NOTE, 127]);
    assert_eq!(read(&engine, "c1_focus"), BUTTON_GATE_VOLTS);
    assert_eq!(read(&engine, "c1_ctrl"), BUTTON_GATE_VOLTS);
    inject(&mut engine, "lcxl1", [0x88, C1_FOCUS_NOTE, 0]);
    assert_eq!(read(&engine, "c1_focus"), 0.0);
    assert_eq!(read(&engine, "c1_ctrl"), BUTTON_GATE_VOLTS, "still held");

    // Values hold between messages (nothing decays or resets).
    engine.process_blocks(50).unwrap();
    assert_eq!(read(&engine, "c1_a"), 10.0);
    assert_eq!(read(&engine, "c1_ctrl"), BUTTON_GATE_VOLTS);
}

#[test]
fn every_column_has_its_own_six_jacks() {
    let manifest = dj_engine::launch_control::launch_control_manifest();
    assert_eq!(manifest.outputs.len(), N_LC_JACKS);
    let mut engine = crate::common::default_engine();
    engine.add_module("lcxl1", LAUNCH_CONTROL_ID).unwrap();
    // Every jack the manifest declares is connectable under its id.
    for col in 0..COLUMNS {
        for r in [
            row::SEND_A,
            row::SEND_B,
            row::PAN,
            row::FADER,
            row::FOCUS,
            row::CONTROL,
        ] {
            let id = jack_id(col, r);
            let scope = format!("s{}_{}", col, r);
            engine.add_module(&scope, "com.dj.scope").unwrap();
            engine.connect("lcxl1", &id, &scope, "in").unwrap();
        }
    }
    // Column 8's fader is a different CC from column 1's, so a sweep of
    // one leaves the other alone.
    let frame = engine.current_frame();
    engine
        .launchcontrol_inject("lcxl1", frame, [0xB8, 84, 127])
        .unwrap();
    engine.process_blocks(2).unwrap();
    let last = format!("s{}_{}", COLUMNS - 1, row::FADER);
    assert_eq!(engine.tap(&last, "in").unwrap().instantaneous, 10.0);
    assert_eq!(
        engine
            .tap(&format!("s0_{}", row::FADER), "in")
            .unwrap()
            .instantaneous,
        0.0
    );
    assert_eq!(jack_index(7, row::FADER), 7 * 6 + row::FADER);
}

#[test]
fn the_first_module_claims_the_surface_and_a_second_does_not_steal_it() {
    let mut engine = crate::common::default_engine();
    engine.add_module("lcxl1", LAUNCH_CONTROL_ID).unwrap();
    assert!(engine.launchcontrol_is_active("lcxl1").unwrap());
    assert_eq!(
        engine.launchcontrol_active_instance().as_deref(),
        Some("lcxl1")
    );

    engine.add_module("lcxl2", LAUNCH_CONTROL_ID).unwrap();
    assert!(engine.launchcontrol_is_active("lcxl1").unwrap());
    assert!(!engine.launchcontrol_is_active("lcxl2").unwrap());
}

#[test]
fn the_device_feed_only_reaches_the_active_module() {
    let mut engine = rigged_engine("lcxl1", &["c1_a"]);
    engine.add_module("lcxl2", LAUNCH_CONTROL_ID).unwrap();
    engine.add_module("scope_b", "com.dj.scope").unwrap();
    engine.connect("lcxl2", "c1_a", "scope_b", "in").unwrap();

    // lcxl1 owns the surface (it was added first).
    let frame = engine.current_frame();
    assert_eq!(
        engine
            .launchcontrol_feed(frame, [0xB8, C1_SEND_A_CC, 127])
            .unwrap(),
        1
    );
    engine.process_blocks(2).unwrap();
    assert_eq!(read(&engine, "c1_a"), 10.0);
    assert_eq!(engine.tap("scope_b", "in").unwrap().instantaneous, 0.0);

    // Handing the surface to lcxl2 takes it away from lcxl1: the second
    // module tracks the knob while the first HOLDS its last value.
    engine.launchcontrol_set_active("lcxl2", true).unwrap();
    assert!(!engine.launchcontrol_is_active("lcxl1").unwrap());
    let frame = engine.current_frame();
    engine
        .launchcontrol_feed(frame, [0xB8, C1_SEND_A_CC, 0])
        .unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(read(&engine, "c1_a"), 10.0, "inactive module holds");
    assert_eq!(engine.tap("scope_b", "in").unwrap().instantaneous, 0.0);
    let frame = engine.current_frame();
    engine
        .launchcontrol_feed(frame, [0xB8, C1_SEND_A_CC, 127])
        .unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(engine.tap("scope_b", "in").unwrap().instantaneous, 10.0);

    // With nobody active the surface drives nothing at all.
    engine.launchcontrol_set_active("lcxl2", false).unwrap();
    assert_eq!(engine.launchcontrol_active_instance(), None);
    let frame = engine.current_frame();
    assert_eq!(
        engine
            .launchcontrol_feed(frame, [0xB8, C1_SEND_A_CC, 0])
            .unwrap(),
        0
    );
    engine.process_blocks(2).unwrap();
    assert_eq!(engine.tap("scope_b", "in").unwrap().instantaneous, 10.0);
}

#[test]
fn connection_status_is_control_side_and_defaults_off() {
    let mut engine = crate::common::default_engine();
    // No hardware in tests (or CI): the indicator starts dark.
    assert!(!engine.launchcontrol_connected());
    engine.launchcontrol_set_connected(true);
    assert!(engine.launchcontrol_connected());
    engine.launchcontrol_set_connected(false);
    assert!(!engine.launchcontrol_connected());
}

#[test]
fn unknown_messages_and_wrong_module_types_are_handled() {
    let mut engine = rigged_engine("lcxl1", &["c1_a"]);
    // A message no control on the surface owns changes nothing.
    inject(&mut engine, "lcxl1", [0xB8, 1, 127]);
    assert_eq!(read(&engine, "c1_a"), 0.0);
    // Clock/SysEx bytes are ignored rather than mis-decoded.
    inject(&mut engine, "lcxl1", [0xF8, 0, 0]);
    assert_eq!(read(&engine, "c1_a"), 0.0);

    engine.add_module("midi1", "builtin.midi").unwrap();
    assert!(engine
        .launchcontrol_inject("midi1", 0, [0xB8, C1_SEND_A_CC, 127])
        .is_err());
    assert!(engine.launchcontrol_is_active("midi1").is_err());
    assert!(engine.launchcontrol_set_active("nope", true).is_err());
}

#[test]
fn launch_control_node_round_trips_through_patch() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    engine.add_module("lcxl1", LAUNCH_CONTROL_ID).unwrap();
    engine.add_module("lcxl2", LAUNCH_CONTROL_ID).unwrap();
    engine.add_module("scope1", "com.dj.scope").unwrap();
    engine.connect("lcxl2", "c3_fader", "scope1", "in").unwrap();
    // Ownership is user state: it must survive save/load.
    engine.launchcontrol_set_active("lcxl2", true).unwrap();
    engine.save_patch(dir.path(), "lcxl-rt").unwrap();

    let mut loaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert!(!loaded.launchcontrol_is_active("lcxl1").unwrap());
    assert!(loaded.launchcontrol_is_active("lcxl2").unwrap());
    // The wire survived and the feed path is live on the loaded node.
    let frame = loaded.current_frame();
    loaded.launchcontrol_feed(frame, [0xB8, 79, 127]).unwrap();
    loaded.process_blocks(2).unwrap();
    assert_eq!(loaded.tap("scope1", "in").unwrap().instantaneous, 10.0);
}

/// Regression (the Hands/QWERTY lesson): a module added mid-session must
/// apply feeds immediately. Events carry the GLOBAL engine frame clock,
/// so an RT module whose local clock started at 0 would see every event
/// as far-future and freeze.
#[test]
fn module_added_mid_session_applies_feeds_immediately() {
    let mut engine = crate::common::default_engine();
    engine.process_blocks(500).unwrap();

    engine.add_module("lcxl1", LAUNCH_CONTROL_ID).unwrap();
    engine.add_module("scope_c1_a", "com.dj.scope").unwrap();
    engine.connect("lcxl1", "c1_a", "scope_c1_a", "in").unwrap();
    inject(&mut engine, "lcxl1", [0xB8, C1_SEND_A_CC, 127]);
    assert_eq!(read(&engine, "c1_a"), 10.0);
}

/// Removing a module frees its ownership and its side tables; the next
/// module added claims the free surface.
#[test]
fn removing_the_owner_frees_the_surface() {
    let mut engine = crate::common::default_engine();
    engine.add_module("lcxl1", LAUNCH_CONTROL_ID).unwrap();
    engine.remove_module("lcxl1").unwrap();
    assert_eq!(engine.launchcontrol_active_instance(), None);
    assert!(engine
        .launchcontrol_inject("lcxl1", 0, [0xB8, 13, 1])
        .is_err());

    engine.add_module("lcxl2", LAUNCH_CONTROL_ID).unwrap();
    assert!(engine.launchcontrol_is_active("lcxl2").unwrap());
}
