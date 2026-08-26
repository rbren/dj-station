//! Built-in QWERTY module (`builtin.qwerty`): the computer keyboard as a
//! gate source. One output jack per alphanumeric key on a standard QWERTY
//! keyboard plus the space bar, each emitting 10 V while its key is held
//! and 0 V when released — play patches with no hardware at all. A
//! separate `note` output carries a pitch CV (1 V/oct, engine pitch
//! convention) for the most recently pressed key: notes ascend in
//! semitones left to right, bottom row to top row (space is the lowest
//! note, `0` on the number row the highest), and the value holds until
//! the next key press (last-note priority, no release action). The
//! `gate` output next to it is 10 V while ANY key is held — the
//! keyboard-wide envelope gate that pairs with `note` for a mono synth
//! voice.
//!
//! Architecturally the Hands module's sibling with an even simpler event
//! model: key down/up events originate in the webview (the panel's window
//! listeners), cross into Rust over one Tauri IPC command, and ship to
//! the RT graph as timestamped events over a lock-free SPSC ring
//! ([`QwertyRtModule`] — zero allocations or locks on the RT side).
//! Sample-accurate within a block; late/past events apply immediately
//! (same policy as MIDI/hands).

use crate::manifest::{categories, DisplayMap, DisplaySpec, Manifest, OutputDecl};
use crate::module_host::HostModule;

pub const QWERTY_ID: &str = "builtin.qwerty";

/// Gate level while a key is held, in Volts.
pub const KEY_GATE_VOLTS: f32 = 10.0;

/// Every key jack in manifest order: the physical QWERTY rows top to
/// bottom (number row, top row, home row, bottom row, space bar). Jack id
/// = the key itself (`"space"` for the space bar).
pub const KEYS: [&str; N_QWERTY_JACKS] = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", // number row
    "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", // top row
    "a", "s", "d", "f", "g", "h", "j", "k", "l", // home row
    "z", "x", "c", "v", "b", "n", "m", // bottom row
    "space",
];

pub const N_QWERTY_JACKS: usize = 37;

/// Total output jacks: one gate per key plus the shared `note` pitch CV
/// and the any-key `gate`.
pub const N_QWERTY_OUTS: usize = N_QWERTY_JACKS + 2;

/// Output jack index of the `note` pitch CV.
pub const NOTE_JACK: usize = N_QWERTY_JACKS;

/// Output jack index of the any-key-held `gate`.
pub const GATE_JACK: usize = N_QWERTY_JACKS + 1;

/// Output jack index for a key, as sent by the webview (`event.key`,
/// lowercased). Accepts `" "` or `"space"` for the space bar.
pub fn key_index(key: &str) -> Option<usize> {
    let key = if key == " " { "space" } else { key };
    KEYS.iter().position(|k| *k == key)
}

/// Pitch CV (1 V/oct, 0 V = C4) the `note` output takes when `jack`'s key
/// is pressed. Notes ascend in semitones left to right, bottom to top:
/// space is C4 (0 V), then z..m, a..l, q..p and finally the number row —
/// `0` tops out three octaves up.
pub fn note_volts(jack: usize) -> f32 {
    // KEYS is ordered top row first; rank rows bottom-up for the pitch.
    let semitone = match jack {
        36 => 0,              // space
        29..=35 => jack - 28, // z..m -> 1..7
        20..=28 => jack - 12, // a..l -> 8..16
        10..=19 => jack + 7,  // q..p -> 17..26
        _ => jack + 27,       // 1..0 -> 27..36
    };
    semitone as f32 / 12.0
}

pub fn qwerty_manifest() -> Manifest {
    Manifest {
        id: QWERTY_ID.into(),
        name: "QWERTY".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::ANALYSIS.into(),
        inputs: vec![],
        outputs: KEYS
            .iter()
            .map(|k| OutputDecl {
                id: (*k).into(),
                name: if *k == "space" {
                    "Space".into()
                } else {
                    k.to_uppercase()
                },
                display: None,
            })
            .chain([
                OutputDecl {
                    id: "note".into(),
                    name: "Note".into(),
                    display: Some(DisplaySpec {
                        unit: Some("Hz".into()),
                        map: Some(DisplayMap::VoltPerOctave {
                            base: crate::manifest::default_pitch_base(),
                        }),
                        steps: None,
                    }),
                },
                OutputDecl {
                    id: "gate".into(),
                    name: "Gate".into(),
                    display: None,
                },
            ])
            .collect(),
        params: vec![],
        ui: None,
        latency_samples: 0,
    }
}

/// A key transition produced on the control thread, applied on the RT
/// thread at (or after) `frame` on the engine sample clock.
#[derive(Debug, Clone, Copy)]
pub struct QwertyEvent {
    pub frame: u64,
    pub jack: u16,
    pub down: bool,
}

/// RT-side module: pops key events from the SPSC ring and renders each
/// key's gate output (10 V held, 0 V released; the value persists until
/// the next transition) plus the `note` pitch CV (last key pressed, held
/// until the next press) and the any-key `gate` (10 V while at least one
/// key is down — derived from `values` on each transition, so it can
/// never drift out of sync with the per-key gates).
pub struct QwertyRtModule {
    consumer: rtrb::Consumer<QwertyEvent>,
    values: [f32; N_QWERTY_JACKS],
    note: f32,
    gate: f32,
    frame: u64,
}

impl QwertyRtModule {
    /// `start_frame` seeds the module's local sample clock from the
    /// ENGINE clock — events are stamped `Engine::current_frame()`, so a
    /// module added mid-session that started local at 0 would see every
    /// event as far-future and freeze (same rationale as HandsRtModule).
    pub fn new(consumer: rtrb::Consumer<QwertyEvent>, start_frame: u64) -> Self {
        QwertyRtModule {
            consumer,
            values: [0.0; N_QWERTY_JACKS],
            note: 0.0,
            gate: 0.0,
            frame: start_frame,
        }
    }

    fn any_key_gate(&self) -> f32 {
        if self.values.iter().any(|v| *v > 0.0) {
            KEY_GATE_VOLTS
        } else {
            0.0
        }
    }
}

impl HostModule for QwertyRtModule {
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
                        if (ev.jack as usize) < N_QWERTY_JACKS {
                            self.values[ev.jack as usize] =
                                if ev.down { KEY_GATE_VOLTS } else { 0.0 };
                            if ev.down {
                                self.note = note_volts(ev.jack as usize);
                            }
                            self.gate = self.any_key_gate();
                        }
                    }
                    _ => break,
                }
            }
            for (o, out) in outputs.iter_mut().enumerate().take(N_QWERTY_JACKS) {
                out[s] = self.values[o];
            }
            if let Some(out) = outputs.get_mut(NOTE_JACK) {
                out[s] = self.note;
            }
            if let Some(out) = outputs.get_mut(GATE_JACK) {
                out[s] = self.gate;
            }
        }
        self.frame = block_start + frames as u64;
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity((N_QWERTY_JACKS + 1) * 4);
        for v in &self.values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes.extend_from_slice(&self.note.to_le_bytes());
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        let (words, _) = bytes.as_chunks::<4>();
        for (i, chunk) in words.iter().enumerate().take(N_QWERTY_JACKS) {
            self.values[i] = f32::from_le_bytes(*chunk);
        }
        // `note` was appended to the state blob; older snapshots omit it.
        if let Some(chunk) = words.get(N_QWERTY_JACKS) {
            self.note = f32::from_le_bytes(*chunk);
        }
        // `gate` is derived state — recompute rather than persist.
        self.gate = self.any_key_gate();
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_matches_key_table() {
        let m = qwerty_manifest();
        assert_eq!(m.outputs.len(), N_QWERTY_OUTS);
        assert_eq!(m.outputs[0].id, "1");
        assert_eq!(m.outputs[10].id, "q");
        assert_eq!(m.outputs[10].name, "Q");
        assert_eq!(m.outputs[N_QWERTY_JACKS - 1].id, "space");
        assert_eq!(m.outputs[N_QWERTY_JACKS - 1].name, "Space");
        assert_eq!(m.outputs[NOTE_JACK].id, "note");
        assert_eq!(m.outputs[GATE_JACK].id, "gate");
        assert!(m.inputs.is_empty());
        // 10 digits + 26 letters + space, each exactly once.
        let mut ids: Vec<&str> = KEYS.to_vec();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), N_QWERTY_JACKS);
    }

    #[test]
    fn note_volts_ascend_left_to_right_bottom_to_top() {
        // Space is the floor; each row ascends left to right; every row
        // sits above the row below it. 37 keys = 37 distinct semitones.
        let semis: Vec<i32> = (0..N_QWERTY_JACKS)
            .map(|j| (note_volts(j) * 12.0).round() as i32)
            .collect();
        assert_eq!(semis[key_index("space").unwrap()], 0);
        let mut sorted = semis.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), N_QWERTY_JACKS, "notes must be distinct");
        assert_eq!(sorted, (0..N_QWERTY_JACKS as i32).collect::<Vec<_>>());
        // Row order: z < m < a < l < q < p < 1 < 0.
        let s = |k: &str| semis[key_index(k).unwrap()];
        assert!(s("z") < s("m"));
        assert!(s("m") < s("a"));
        assert!(s("a") < s("l"));
        assert!(s("l") < s("q"));
        assert!(s("q") < s("p"));
        assert!(s("p") < s("1"));
        assert!(s("1") < s("0"));
    }

    #[test]
    fn key_index_accepts_space_forms() {
        assert_eq!(key_index("space"), key_index(" "));
        assert_eq!(key_index("q"), Some(10));
        assert_eq!(key_index("escape"), None);
        // Uppercase is the caller's job (event.key is lowercased in the
        // panel); the engine table is lowercase-only.
        assert_eq!(key_index("Q"), None);
    }
}
