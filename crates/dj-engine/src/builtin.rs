//! Built-in native modules: Audio Output (PRD §7.2) and MIDI (PRD §7.1).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;

pub const AUDIO_OUT_ID: &str = "builtin.audio_out";
pub const MIDI_ID: &str = "builtin.midi";
pub const AUDIO_OUT_CHANNELS: usize = 2;
const AUDIO_OUT_JACKS: [(&str, &str); AUDIO_OUT_CHANNELS] = [("l", "L"), ("r", "R")];
pub const MAX_MIDI_JACKS: usize = 64;
/// Input jacks on the MIDI module for LED/controller feedback (PRD §7.1).
pub const MAX_MIDI_LED_JACKS: usize = 16;

pub fn audio_out_manifest() -> Manifest {
    Manifest {
        id: AUDIO_OUT_ID.into(),
        name: "Audio Output".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        inputs: AUDIO_OUT_JACKS
            .iter()
            .map(|(id, name)| JackDecl {
                id: (*id).into(),
                name: (*name).into(),
                default: 0.0,
                knob: None,
            })
            .chain(std::iter::once(JackDecl {
                id: "channel_offset".into(),
                name: "Device Channel Offset".into(),
                default: 0.0,
                knob: Some(KnobConfig {
                    style: KnobStyle::Stepped,
                    min: 0.0,
                    max: 8.0,
                    curve: Curve::Linear,
                    steps: Some(9),
                }),
            }))
            .collect(),
        outputs: vec![],
        params: vec![],
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
        // Input jacks drive controller LEDs/feedback (one per LED mapping;
        // named like output mappings). Fixed count so graph buffers are
        // preallocated.
        inputs: (0..MAX_MIDI_LED_JACKS)
            .map(|i| JackDecl {
                id: format!("led{i}"),
                name: format!("LED {i}"),
                default: 0.0,
                knob: None,
            })
            .collect(),
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
    fn process(&mut self, i: &[Vec<f32>], _o: &mut [Vec<f32>], _m: u64, f: usize) {
        // channel_offset is an ordinary input jack (knob or wire); the
        // graph mixes the audio jacks using the value captured here.
        if let Some(buf) = i.get(AUDIO_OUT_CHANNELS) {
            if f > 0 {
                self.channel_offset = (buf[0].round().max(0.0)) as usize;
            }
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
    /// Bitmask of jacks whose RT-side value must be zeroed (set when a slot
    /// is removed or reused so stale values don't leak into new mappings).
    pub reset_mask: AtomicU64,
    /// LED feedback mappings (input jacks -> note/CC out messages).
    pub led_mappings: [MappingCell; MAX_MIDI_LED_JACKS],
    /// LED slots whose RT-side emit state must be reset (removed/reused).
    pub led_reset_mask: AtomicU64,
}

impl Default for MidiShared {
    fn default() -> Self {
        MidiShared {
            learn_armed: AtomicBool::new(false),
            learned: AtomicU32::new(0),
            mappings: std::array::from_fn(|_| MappingCell::default()),
            reset_mask: AtomicU64::new(0),
            led_mappings: std::array::from_fn(|_| MappingCell::default()),
            led_reset_mask: AtomicU64::new(0),
        }
    }
}

fn claim_slot(cells: &[MappingCell], reset_mask: &AtomicU64, kind: u8, num: u8) -> Option<usize> {
    for (i, cell) in cells.iter().enumerate() {
        if !cell.active.load(Ordering::Acquire) {
            cell.kind.store(kind, Ordering::Relaxed);
            cell.num.store(num, Ordering::Relaxed);
            // Reused slots may hold stale state from a prior mapping.
            reset_mask.fetch_or(1 << i, Ordering::Release);
            cell.active.store(true, Ordering::Release);
            return Some(i);
        }
    }
    None
}

impl MidiShared {
    pub fn add_mapping(&self, kind: u8, num: u8) -> Option<usize> {
        claim_slot(&self.mappings, &self.reset_mask, kind, num)
    }

    pub fn remove_mapping(&self, jack: usize) {
        if jack < MAX_MIDI_JACKS {
            self.mappings[jack].active.store(false, Ordering::Release);
            self.reset_mask.fetch_or(1 << jack, Ordering::Release);
        }
    }

    pub fn add_led_mapping(&self, kind: u8, num: u8) -> Option<usize> {
        claim_slot(&self.led_mappings, &self.led_reset_mask, kind, num)
    }

    pub fn remove_led_mapping(&self, jack: usize) {
        if jack < MAX_MIDI_LED_JACKS {
            self.led_mappings[jack]
                .active
                .store(false, Ordering::Release);
            self.led_reset_mask.fetch_or(1 << jack, Ordering::Release);
        }
    }
}

/// A MIDI message emitted by the engine toward a controller (LED feedback,
/// PRD §7.1). Produced on the RT thread, drained on the control thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MidiOutEvent {
    pub frame: u64,
    pub data: [u8; 3],
}

/// Where engine-generated MIDI output goes. Implementations: the mock sink
/// below (tests/headless), or a hardware output port (feature `midi-hw`).
pub trait MidiOutSink {
    fn send(&mut self, event: MidiOutEvent);
}

/// Records every emitted message; the virtual controller for tests.
#[derive(Debug, Default)]
pub struct MockMidiSink {
    pub events: Vec<MidiOutEvent>,
}

impl MidiOutSink for MockMidiSink {
    fn send(&mut self, event: MidiOutEvent) {
        self.events.push(event);
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
    /// LED feedback output ring (RT -> control). Full ring drops events —
    /// LED state tolerates loss (the next change re-syncs).
    out_producer: rtrb::Producer<MidiOutEvent>,
    /// Last emitted 7-bit value per LED slot; -1 = nothing emitted yet, so
    /// the first processed block emits the initial state (controller sync).
    led_last: [i16; MAX_MIDI_LED_JACKS],
}

impl MidiModule {
    pub fn new(
        consumer: rtrb::Consumer<MidiEvent>,
        shared: Arc<MidiShared>,
        out_producer: rtrb::Producer<MidiOutEvent>,
    ) -> Self {
        MidiModule {
            consumer,
            shared,
            values: [0.0; MAX_MIDI_JACKS],
            frame: 0,
            out_producer,
            led_last: [-1; MAX_MIDI_LED_JACKS],
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
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        // Zero values for slots the control thread removed/reused.
        let reset = self.shared.reset_mask.swap(0, Ordering::AcqRel);
        if reset != 0 {
            for (i, v) in self.values.iter_mut().enumerate() {
                if reset & (1 << i) != 0 {
                    *v = 0.0;
                }
            }
        }
        let led_reset = self.shared.led_reset_mask.swap(0, Ordering::AcqRel);
        if led_reset != 0 {
            for (i, l) in self.led_last.iter_mut().enumerate() {
                if led_reset & (1 << i) != 0 {
                    *l = -1;
                }
            }
        }
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

        // LED feedback (PRD §7.1): evaluate each active LED mapping at
        // block rate (last sample of the block) and emit a note/CC out
        // message when the quantized 7-bit value changes. Signals use the
        // 0..10 range: 0 -> 0, 10 -> 127 (notes gate at >= 1.0).
        if frames > 0 {
            let eval_frame = block_start + frames as u64 - 1;
            for i in 0..MAX_MIDI_LED_JACKS {
                let cell = &self.shared.led_mappings[i];
                if !cell.active.load(Ordering::Acquire) {
                    continue;
                }
                let Some(buf) = inputs.get(i) else { continue };
                let v = buf[frames - 1];
                let kind = cell.kind.load(Ordering::Relaxed);
                let num = cell.num.load(Ordering::Relaxed);
                let (q, data) = if kind == MAP_KIND_NOTE {
                    if v >= 1.0 {
                        let vel = (v * 12.7).clamp(1.0, 127.0).round() as u8;
                        (vel as i16, [0x90, num, vel])
                    } else {
                        (0, [0x80, num, 0])
                    }
                } else {
                    let q = (v * 12.7).clamp(0.0, 127.0).round() as u8;
                    (q as i16, [0xB0, num, q])
                };
                if q != self.led_last[i] {
                    self.led_last[i] = q;
                    let _ = self.out_producer.push(MidiOutEvent {
                        frame: eval_frame,
                        data,
                    });
                }
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
