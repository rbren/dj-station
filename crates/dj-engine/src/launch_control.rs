//! Built-in Novation Launch Control XL module (`builtin.launchcontrol`):
//! the physical control surface as 8 columns of CV outputs — three knob
//! rows, a mixer-style fader and two buttons per column (PRD §7.1's
//! "MIDI to CV", specialised for one known controller instead of learned
//! mappings).
//!
//! Architecturally the Hands module's sibling: raw MIDI bytes arrive on
//! the CONTROL thread (hardware port in the app, `launchcontrol_inject`
//! in tests and offline renders), [`decode`] turns them into
//! (jack, Volts) pairs, [`LaunchControlControl`] dedups them, and the
//! changed values ship to the RT graph as timestamped events over a
//! lock-free SPSC ring ([`LaunchControlRtModule`] — zero allocations or
//! locks on the RT side, last value held between events).
//!
//! ## Device map
//!
//! The CC/note numbers below are the Launch Control XL's factory
//! templates. The MIDI CHANNEL is deliberately ignored: the device sends
//! a different channel per template (and per user template), and every
//! template that matters uses the same control numbers, so a template
//! switch keeps working instead of going silent.
//!
//! Knobs and faders map 0..127 to 0..10 V (unipolar — a fader down reads
//! 0 V, like the mixer module's level); the buttons are momentary gates
//! (10 V while held, 0 V on release), matching MIDI/QWERTY note gates.
//!
//! ## Ownership ("active")
//!
//! One physical surface, possibly several modules on the rack: exactly
//! one module owns the controller at a time. Ownership is the `active`
//! param (a mode-style toggle, per the params-vs-inputs rule — never a
//! wireable input), driven by the panel's Active button and enforced
//! exclusively by `Engine::launchcontrol_set_active`. The device feed
//! (`Engine::launchcontrol_feed`) only reaches active modules;
//! `launchcontrol_inject` addresses one module directly, which is what
//! the deterministic test/golden path uses.

use crate::manifest::{categories, Manifest, OutputDecl, ParamDecl};
use crate::module_host::HostModule;

pub const LAUNCH_CONTROL_ID: &str = "builtin.launchcontrol";

/// Substring identifying the device's MIDI port (hardware discovery).
pub const PORT_NAME: &str = "Launch Control XL";

/// Param holding controller ownership for one module instance.
pub const ACTIVE_PARAM: &str = "active";

/// Columns on the surface (one strip of controls each).
pub const COLUMNS: usize = 8;

/// Controls per column, top to bottom.
pub const ROWS: usize = 6;

/// Row indices within a column (manifest order).
pub mod row {
    pub const SEND_A: usize = 0;
    pub const SEND_B: usize = 1;
    pub const PAN: usize = 2;
    pub const FADER: usize = 3;
    pub const FOCUS: usize = 4;
    pub const CONTROL: usize = 5;
}

pub const N_LC_JACKS: usize = COLUMNS * ROWS;

/// Jack id/name suffixes per row, in manifest order.
const ROW_IDS: [(&str, &str); ROWS] = [
    ("a", "Send A"),
    ("b", "Send B"),
    ("pan", "Pan"),
    ("fader", "Fader"),
    ("focus", "Focus"),
    ("ctrl", "Control"),
];

/// CC numbers of the three knob rows (factory templates).
const KNOB_CC: [[u8; COLUMNS]; 3] = [
    [13, 14, 15, 16, 17, 18, 19, 20],
    [29, 30, 31, 32, 33, 34, 35, 36],
    [49, 50, 51, 52, 53, 54, 55, 56],
];

/// CC numbers of the eight faders.
const FADER_CC: [u8; COLUMNS] = [77, 78, 79, 80, 81, 82, 83, 84];

/// Note numbers of the Track Focus (upper) button row.
const FOCUS_NOTE: [u8; COLUMNS] = [41, 42, 43, 44, 57, 58, 59, 60];

/// Note numbers of the Track Control (lower) button row.
const CONTROL_NOTE: [u8; COLUMNS] = [73, 74, 75, 76, 89, 90, 91, 92];

/// Gate level of a held button, in Volts.
pub const BUTTON_GATE_VOLTS: f32 = 10.0;

/// Output jack index of a control, `col` and `row` both zero-based.
/// Column-major so a column's six jacks are contiguous.
pub fn jack_index(col: usize, row: usize) -> usize {
    col * ROWS + row
}

/// Jack id of a control (`c1_a` … `c8_ctrl`; columns are 1-based in the
/// id, matching the labels printed on the device).
pub fn jack_id(col: usize, row: usize) -> String {
    format!("c{}_{}", col + 1, ROW_IDS[row].0)
}

pub fn launch_control_manifest() -> Manifest {
    Manifest {
        id: LAUNCH_CONTROL_ID.into(),
        name: "Launch Control XL".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::ANALYSIS.into(),
        inputs: vec![],
        outputs: (0..COLUMNS)
            .flat_map(|col| {
                (0..ROWS).map(move |r| OutputDecl {
                    id: jack_id(col, r),
                    name: format!("{} {}", col + 1, ROW_IDS[r].1),
                    display: None,
                })
            })
            .collect(),
        params: vec![ParamDecl {
            id: ACTIVE_PARAM.into(),
            name: "Controller Active".into(),
            param_type: "toggle".into(),
            default: serde_json::json!(false),
            min: None,
            max: None,
        }],
        ui: None,
        latency_samples: 0,
    }
}

/// Decode one raw MIDI message from the surface into the jack it drives
/// and that jack's new value in Volts. `None` = a message this device map
/// doesn't cover (channel messages from other controls, clock, SysEx…).
///
/// Runs on the control thread; the channel nibble is ignored (see the
/// module docs' device map).
pub fn decode(data: [u8; 3]) -> Option<(usize, f32)> {
    let (num, on) = match data[0] & 0xF0 {
        0xB0 => {
            let volts = data[2] as f32 / 127.0 * 10.0;
            let cc = data[1];
            for (r, row_cc) in KNOB_CC.iter().enumerate() {
                if let Some(col) = row_cc.iter().position(|n| *n == cc) {
                    return Some((jack_index(col, r), volts));
                }
            }
            let col = FADER_CC.iter().position(|n| *n == cc)?;
            return Some((jack_index(col, row::FADER), volts));
        }
        // Note-on with velocity 0 is a note-off (running-status idiom).
        0x90 => (data[1], data[2] > 0),
        0x80 => (data[1], false),
        _ => return None,
    };
    let volts = if on { BUTTON_GATE_VOLTS } else { 0.0 };
    if let Some(col) = FOCUS_NOTE.iter().position(|n| *n == num) {
        return Some((jack_index(col, row::FOCUS), volts));
    }
    let col = CONTROL_NOTE.iter().position(|n| *n == num)?;
    Some((jack_index(col, row::CONTROL), volts))
}

/// Control-plane state per Launch Control node: dedups per-jack values so
/// a knob resting against its end stop (the device repeats identical CCs
/// while touched) doesn't flood the event ring.
#[derive(Debug)]
pub struct LaunchControlControl {
    last: [Option<f32>; N_LC_JACKS],
}

impl Default for LaunchControlControl {
    fn default() -> Self {
        LaunchControlControl {
            last: [None; N_LC_JACKS],
        }
    }
}

impl LaunchControlControl {
    /// Decode one message and call `emit(jack, volts)` when it actually
    /// changes that jack's value. Unknown messages emit nothing.
    pub fn feed(&mut self, data: [u8; 3], mut emit: impl FnMut(usize, f32)) {
        let Some((jack, value)) = decode(data) else {
            return;
        };
        if self.last[jack] == Some(value) {
            return;
        }
        self.last[jack] = Some(value);
        emit(jack, value);
    }
}

/// A control-thread-produced value for one jack, applied on the RT thread
/// at (or after) `frame` on the engine sample clock.
#[derive(Debug, Clone, Copy)]
pub struct LaunchControlEvent {
    pub frame: u64,
    pub jack: u16,
    pub value: f32,
}

/// RT-side module: pops jack-value events from the SPSC ring and renders
/// them as held output signals (last value persists until the next
/// event). Sample-accurate within a block; late/past events apply
/// immediately (same policy as MIDI/gesture/hands/qwerty).
pub struct LaunchControlRtModule {
    consumer: rtrb::Consumer<LaunchControlEvent>,
    values: [f32; N_LC_JACKS],
    frame: u64,
}

impl LaunchControlRtModule {
    /// `start_frame` seeds the module's local sample clock from the ENGINE
    /// clock — events are stamped `Engine::current_frame()`, so a module
    /// added mid-session that started local at 0 would see every event as
    /// far-future and freeze (same rationale as HandsRtModule).
    pub fn new(consumer: rtrb::Consumer<LaunchControlEvent>, start_frame: u64) -> Self {
        LaunchControlRtModule {
            consumer,
            values: [0.0; N_LC_JACKS],
            frame: start_frame,
        }
    }
}

impl HostModule for LaunchControlRtModule {
    fn process(
        &mut self,
        _inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        let block_start = self.frame;
        for s in 0..frames {
            let now = block_start + s as u64;
            loop {
                match self.consumer.peek() {
                    Ok(ev) if ev.frame <= now => {
                        let ev = *ev;
                        let _ = self.consumer.pop();
                        if (ev.jack as usize) < N_LC_JACKS {
                            self.values[ev.jack as usize] = ev.value;
                        }
                    }
                    _ => break,
                }
            }
            for (o, out) in outputs.iter_mut().enumerate().take(N_LC_JACKS) {
                out[s] = self.values[o];
            }
        }
        self.frame = block_start + frames as u64;
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(N_LC_JACKS * 4);
        for v in &self.values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        for (i, chunk) in bytes.as_chunks::<4>().0.iter().enumerate().take(N_LC_JACKS) {
            self.values[i] = f32::from_le_bytes(*chunk);
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_has_one_jack_per_control_in_column_order() {
        let m = launch_control_manifest();
        assert_eq!(m.outputs.len(), N_LC_JACKS);
        assert_eq!(m.outputs[0].id, "c1_a");
        assert_eq!(m.outputs[0].name, "1 Send A");
        assert_eq!(m.outputs[jack_index(0, row::FADER)].id, "c1_fader");
        assert_eq!(m.outputs[jack_index(7, row::CONTROL)].id, "c8_ctrl");
        assert_eq!(m.outputs[jack_index(7, row::CONTROL)].name, "8 Control");
        assert!(m.inputs.is_empty(), "the surface only produces signals");
        // Ownership is a param (mode-style toggle), never an input jack.
        assert_eq!(m.params.len(), 1);
        assert_eq!(m.params[0].id, ACTIVE_PARAM);
        assert_eq!(m.params[0].default_f32(), 0.0);
        let mut ids: Vec<&str> = m.outputs.iter().map(|o| o.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), N_LC_JACKS, "jack ids must be unique");
    }

    #[test]
    fn knobs_and_faders_decode_to_unipolar_volts() {
        // Column 1 Send A knob, full scale.
        assert_eq!(
            decode([0xB8, 13, 127]),
            Some((jack_index(0, row::SEND_A), 10.0))
        );
        // Column 8 pan knob, zero.
        assert_eq!(decode([0xB8, 56, 0]), Some((jack_index(7, row::PAN), 0.0)));
        // Column 3 fader, halfway.
        let (jack, v) = decode([0xB8, 79, 64]).unwrap();
        assert_eq!(jack, jack_index(2, row::FADER));
        assert!((v - 64.0 / 127.0 * 10.0).abs() < 1e-6);
        // Middle knob row, column 5.
        assert_eq!(
            decode([0xB8, 33, 127]),
            Some((jack_index(4, row::SEND_B), 10.0))
        );
        // A CC the surface doesn't own.
        assert_eq!(decode([0xB0, 1, 100]), None);
    }

    #[test]
    fn buttons_decode_to_momentary_gates() {
        let focus1 = jack_index(0, row::FOCUS);
        let ctrl8 = jack_index(7, row::CONTROL);
        assert_eq!(decode([0x98, 41, 127]), Some((focus1, BUTTON_GATE_VOLTS)));
        assert_eq!(decode([0x88, 41, 0]), Some((focus1, 0.0)));
        // Note-on with velocity 0 is a release.
        assert_eq!(decode([0x98, 41, 0]), Some((focus1, 0.0)));
        assert_eq!(decode([0x98, 92, 127]), Some((ctrl8, BUTTON_GATE_VOLTS)));
        // The button rows wrap over the device's number split (41-44 then
        // 57-60), so column 5's focus button is note 57.
        assert_eq!(
            decode([0x98, 57, 127]),
            Some((jack_index(4, row::FOCUS), BUTTON_GATE_VOLTS))
        );
        assert_eq!(decode([0x98, 12, 127]), None);
    }

    #[test]
    fn channel_nibble_is_ignored_so_template_switches_keep_working() {
        for channel in 0..16u8 {
            assert_eq!(
                decode([0xB0 | channel, 13, 127]),
                Some((jack_index(0, row::SEND_A), 10.0)),
                "channel {channel} must decode like every other"
            );
        }
    }

    #[test]
    fn rt_state_round_trips_so_a_hot_reload_keeps_the_surface_where_it_was() {
        let (mut tx, rx) = rtrb::RingBuffer::new(8);
        let mut m = LaunchControlRtModule::new(rx, 0);
        tx.push(LaunchControlEvent {
            frame: 0,
            jack: jack_index(2, row::FADER) as u16,
            value: 7.5,
        })
        .unwrap();
        let mut outputs: Vec<Vec<f32>> = vec![vec![0.0; 4]; N_LC_JACKS];
        m.process(&[], &mut outputs, 0, 4);
        assert_eq!(outputs[jack_index(2, row::FADER)][3], 7.5);

        let bytes = m.save_state();
        let (_tx2, rx2) = rtrb::RingBuffer::new(8);
        let mut reloaded = LaunchControlRtModule::new(rx2, 0);
        reloaded.load_state(&bytes);
        let mut outputs: Vec<Vec<f32>> = vec![vec![0.0; 4]; N_LC_JACKS];
        reloaded.process(&[], &mut outputs, 0, 4);
        assert_eq!(outputs[jack_index(2, row::FADER)][0], 7.5);
        assert_eq!(outputs[0][0], 0.0);
    }

    #[test]
    fn control_dedups_repeated_values() {
        let mut ctl = LaunchControlControl::default();
        let mut events: Vec<(usize, f32)> = Vec::new();
        ctl.feed([0xB8, 13, 100], |j, v| events.push((j, v)));
        assert_eq!(events.len(), 1);
        // Same value again: nothing crosses the ring.
        ctl.feed([0xB8, 13, 100], |j, v| events.push((j, v)));
        assert_eq!(events.len(), 1);
        // A different value does.
        ctl.feed([0xB8, 13, 101], |j, v| events.push((j, v)));
        assert_eq!(events.len(), 2);
        // Unknown messages never emit.
        ctl.feed([0xF8, 0, 0], |j, v| events.push((j, v)));
        ctl.feed([0xB8, 1, 64], |j, v| events.push((j, v)));
        assert_eq!(events.len(), 2);
    }
}
