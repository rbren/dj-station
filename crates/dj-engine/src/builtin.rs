//! Built-in native modules: Audio Output (PRD §7.2) and MIDI (PRD §7.1).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Arc;

use crate::manifest::{JackDecl, Manifest, OutputDecl, ParamDecl};
use crate::module_host::HostModule;

pub const AUDIO_OUT_ID: &str = "builtin.audio_out";
pub const MIDI_ID: &str = "builtin.midi";
pub const AUDIO_OUT_CHANNELS: usize = 8;
pub const MAX_MIDI_JACKS: usize = 64;

pub fn audio_out_manifest() -> Manifest {
    Manifest {
        id: AUDIO_OUT_ID.into(),
        name: "Audio Output".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        inputs: (1..=AUDIO_OUT_CHANNELS)
            .map(|i| JackDecl {
                id: format!("ch{i}"),
                name: format!("Ch {i}"),
                default: 0.0,
                knob: None,
            })
            .collect(),
        outputs: vec![],
        params: vec![ParamDecl {
            id: "channel_offset".into(),
            name: "Device Channel Offset".into(),
            param_type: "int".into(),
            default: serde_json::json!(0),
            min: Some(0.0),
            max: Some(64.0),
        }],
        ui: None,
        latency_samples: 0,
    }
}

pub fn midi_manifest() -> Manifest {
    Manifest {
        id: MIDI_ID.into(),
        name: "MIDI".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        inputs: vec![],
        // Output jacks are dynamic (one per mapped control); the graph
        // preallocates MAX_MIDI_JACKS output buffers.
        outputs: (0..MAX_MIDI_JACKS)
            .map(|i| OutputDecl {
                id: format!("map{i}"),
                name: format!("Mapping {i}"),
            })
            .collect(),
        params: vec![],
        ui: None,
        latency_samples: 0,
    }
}

/// Audio Output: the graph executor mixes this node's effective inputs into
/// the master bus; the module itself is a no-op.
pub struct AudioOutModule {
    pub channel_offset: usize,
}

impl HostModule for AudioOutModule {
    fn process(&mut self, _i: &[Vec<f32>], _o: &mut [Vec<f32>], _m: u64, _f: usize) {}

    fn on_param(&mut self, index: u32, value: f32) {
        if index == 0 {
            self.channel_offset = value.max(0.0) as usize;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// ---------------------------------------------------------------------------
// MIDI module
// ---------------------------------------------------------------------------

pub const MAP_KIND_CC: u8 = 0;
pub const MAP_KIND_NOTE: u8 = 1;

/// A raw MIDI event with a sample timestamp (engine frame clock).
#[derive(Debug, Clone, Copy)]
pub struct MidiEvent {
    pub frame: u64,
    pub data: [u8; 3],
}

/// One mapping slot, written by the control thread, read by the RT thread.
#[derive(Debug, Default)]
pub struct MappingCell {
    pub active: AtomicBool,
    pub kind: AtomicU8,
    pub num: AtomicU8,
}

/// Lock-free state shared between the control thread and the RT module.
pub struct MidiShared {
    pub learn_armed: AtomicBool,
    /// 0 = nothing learned; else `1<<31 | kind<<8 | num`.
    pub learned: AtomicU32,
    pub mappings: [MappingCell; MAX_MIDI_JACKS],
}

impl Default for MidiShared {
    fn default() -> Self {
        MidiShared {
            learn_armed: AtomicBool::new(false),
            learned: AtomicU32::new(0),
            mappings: std::array::from_fn(|_| MappingCell::default()),
        }
    }
}

impl MidiShared {
    pub fn add_mapping(&self, kind: u8, num: u8) -> Option<usize> {
        for (i, cell) in self.mappings.iter().enumerate() {
            if !cell.active.load(Ordering::Acquire) {
                cell.kind.store(kind, Ordering::Relaxed);
                cell.num.store(num, Ordering::Relaxed);
                cell.active.store(true, Ordering::Release);
                return Some(i);
            }
        }
        None
    }
}

/// The RT-side MIDI module: consumes injected/hardware events from an SPSC
/// ring and renders mapped controls as output signals scaled to [-10, +10].
/// Notes emit gate-style 10.0 (on) / 0.0 (off); CC maps 0..127 -> -10..+10.
pub struct MidiModule {
    consumer: rtrb::Consumer<MidiEvent>,
    shared: Arc<MidiShared>,
    values: [f32; MAX_MIDI_JACKS],
    frame: u64,
}

impl MidiModule {
    pub fn new(consumer: rtrb::Consumer<MidiEvent>, shared: Arc<MidiShared>) -> Self {
        MidiModule {
            consumer,
            shared,
            values: [0.0; MAX_MIDI_JACKS],
            frame: 0,
        }
    }

    fn apply_event(&mut self, data: [u8; 3]) {
        let status = data[0] & 0xF0;
        let (kind, num, value) = match status {
            0x90 if data[2] > 0 => (MAP_KIND_NOTE, data[1], 10.0),
            0x90 | 0x80 => (MAP_KIND_NOTE, data[1], 0.0),
            0xB0 => (MAP_KIND_CC, data[1], data[2] as f32 / 127.0 * 20.0 - 10.0),
            _ => return,
        };
        if self.shared.learn_armed.swap(false, Ordering::AcqRel) {
            self.shared.learned.store(
                (1u32 << 31) | ((kind as u32) << 8) | num as u32,
                Ordering::Release,
            );
        }
        for (i, cell) in self.shared.mappings.iter().enumerate() {
            if cell.active.load(Ordering::Acquire)
                && cell.kind.load(Ordering::Relaxed) == kind
                && cell.num.load(Ordering::Relaxed) == num
            {
                self.values[i] = value;
            }
        }
    }
}

impl HostModule for MidiModule {
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
            // Apply all events due at or before this sample (sample-accurate
            // within the block; late/past events apply immediately).
            loop {
                match self.consumer.peek() {
                    Ok(ev) if ev.frame <= now => {
                        let ev = *ev;
                        let _ = self.consumer.pop();
                        self.apply_event(ev.data);
                    }
                    _ => break,
                }
            }
            for (o, out) in outputs.iter_mut().enumerate().take(MAX_MIDI_JACKS) {
                out[s] = self.values[o];
            }
        }
        self.frame = block_start + frames as u64;
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(MAX_MIDI_JACKS * 4);
        for v in &self.values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        for (i, chunk) in bytes.chunks_exact(4).enumerate().take(MAX_MIDI_JACKS) {
            self.values[i] = f32::from_le_bytes(chunk.try_into().unwrap());
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
