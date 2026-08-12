//! Built-in QWERTY module (`builtin.qwerty`): the computer keyboard as a
//! gate source. One output jack per alphanumeric key on a standard QWERTY
//! keyboard plus the space bar, each emitting 10 V while its key is held
//! and 0 V when released — play patches with no hardware at all.
//!
//! Architecturally the Hands module's sibling with an even simpler event
//! model: key down/up events originate in the webview (the panel's window
//! listeners), cross into Rust over one Tauri IPC command, and ship to
//! the RT graph as timestamped events over a lock-free SPSC ring
//! ([`QwertyRtModule`] — zero allocations or locks on the RT side).
//! Sample-accurate within a block; late/past events apply immediately
//! (same policy as MIDI/gesture/hands).

use crate::manifest::{categories, Manifest, OutputDecl};
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

/// Output jack index for a key, as sent by the webview (`event.key`,
/// lowercased). Accepts `" "` or `"space"` for the space bar.
pub fn key_index(key: &str) -> Option<usize> {
    let key = if key == " " { "space" } else { key };
    KEYS.iter().position(|k| *k == key)
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
/// the next transition).
pub struct QwertyRtModule {
    consumer: rtrb::Consumer<QwertyEvent>,
    values: [f32; N_QWERTY_JACKS],
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
            frame: start_frame,
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
                        }
                    }
                    _ => break,
                }
            }
            for (o, out) in outputs.iter_mut().enumerate().take(N_QWERTY_JACKS) {
                out[s] = self.values[o];
            }
        }
        self.frame = block_start + frames as u64;
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(N_QWERTY_JACKS * 4);
        for v in &self.values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        for (i, chunk) in bytes.chunks_exact(4).enumerate().take(N_QWERTY_JACKS) {
            self.values[i] = f32::from_le_bytes(chunk.try_into().unwrap());
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
    fn manifest_matches_key_table() {
        let m = qwerty_manifest();
        assert_eq!(m.outputs.len(), N_QWERTY_JACKS);
        assert_eq!(m.outputs[0].id, "1");
        assert_eq!(m.outputs[10].id, "q");
        assert_eq!(m.outputs[10].name, "Q");
        assert_eq!(m.outputs[N_QWERTY_JACKS - 1].id, "space");
        assert_eq!(m.outputs[N_QWERTY_JACKS - 1].name, "Space");
        assert!(m.inputs.is_empty());
        // 10 digits + 26 letters + space, each exactly once.
        let mut ids: Vec<&str> = KEYS.to_vec();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), N_QWERTY_JACKS);
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
