//! Built-in native modules: Audio Output (PRD §7.2) and MIDI (PRD §7.1).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;

pub const AUDIO_OUT_ID: &str = "builtin.audio_out";
pub const MIDI_ID: &str = "builtin.midi";

/// The built-in (non-extension) module types, resolved once from an
/// `ext_id` instead of scattering `ext_id == SOME_ID` string chains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinKind {
    AudioOut,
    Midi,
    Qwerty,
    Choreo,
    Gesture,
    Hands,
    Playback,
    Audio,
    Deck,
    Crossfader,
}

impl BuiltinKind {
    pub fn from_ext_id(ext_id: &str) -> Option<Self> {
        match ext_id {
            AUDIO_OUT_ID => Some(BuiltinKind::AudioOut),
            MIDI_ID => Some(BuiltinKind::Midi),
            crate::qwerty::QWERTY_ID => Some(BuiltinKind::Qwerty),
            crate::choreo::CHOREO_ID => Some(BuiltinKind::Choreo),
            crate::gesture::GESTURE_ID => Some(BuiltinKind::Gesture),
            crate::hands::HANDS_ID => Some(BuiltinKind::Hands),
            crate::playback::PLAYBACK_ID => Some(BuiltinKind::Playback),
            crate::audio::AUDIO_ID => Some(BuiltinKind::Audio),
            crate::deck::DECK_ID => Some(BuiltinKind::Deck),
            crate::mixer::CROSSFADER_ID => Some(BuiltinKind::Crossfader),
            _ => None,
        }
    }

    pub fn ext_id(self) -> &'static str {
        match self {
            BuiltinKind::AudioOut => AUDIO_OUT_ID,
            BuiltinKind::Midi => MIDI_ID,
            BuiltinKind::Qwerty => crate::qwerty::QWERTY_ID,
            BuiltinKind::Choreo => crate::choreo::CHOREO_ID,
            BuiltinKind::Gesture => crate::gesture::GESTURE_ID,
            BuiltinKind::Hands => crate::hands::HANDS_ID,
            BuiltinKind::Playback => crate::playback::PLAYBACK_ID,
            BuiltinKind::Audio => crate::audio::AUDIO_ID,
            BuiltinKind::Deck => crate::deck::DECK_ID,
            BuiltinKind::Crossfader => crate::mixer::CROSSFADER_ID,
        }
    }

    pub fn manifest(self) -> Manifest {
        match self {
            BuiltinKind::AudioOut => audio_out_manifest(),
            BuiltinKind::Midi => midi_manifest(),
            BuiltinKind::Qwerty => crate::qwerty::qwerty_manifest(),
            BuiltinKind::Choreo => crate::choreo::choreo_manifest(),
            BuiltinKind::Gesture => crate::gesture::gesture_manifest(),
            BuiltinKind::Hands => crate::hands::hands_manifest(),
            BuiltinKind::Playback => crate::playback::playback_manifest(),
            BuiltinKind::Audio => crate::audio::audio_manifest(),
            BuiltinKind::Deck => crate::deck::deck_manifest(),
            BuiltinKind::Crossfader => crate::mixer::crossfader_manifest(),
        }
    }
}

pub const AUDIO_OUT_CHANNELS: usize = 2;
const AUDIO_OUT_JACKS: [(&str, &str); AUDIO_OUT_CHANNELS] = [("l", "L"), ("r", "R")];
pub const MAX_MIDI_JACKS: usize = 64;
/// Input jacks on the MIDI module for LED/controller feedback (PRD §7.1).
pub const MAX_MIDI_LED_JACKS: usize = 16;

/// Voices of the built-in polyphonic note allocator. Each voice owns a
/// pitch/gate/velocity jack trio placed after the mapping jacks, so mapping
/// slot indices (stored in patches) keep their meaning.
pub const MIDI_POLY_VOICES: usize = 4;

/// Fixed output jacks that follow the per-voice trios: channel-wide
/// controls and transport, in this order.
const MIDI_GLOBAL_OUTS: [(&str, &str); 7] = [
    ("mod", "Mod Wheel"),
    ("bend", "Pitch Bend"),
    ("pressure", "Aftertouch"),
    ("sustain", "Sustain Pedal"),
    ("clock", "Clock (24 ppqn)"),
    ("beat", "Beat"),
    ("transport", "Transport Run"),
];

/// Width of the clock/beat trigger pulses, in samples (~1 ms at 48 kHz).
const CLOCK_PULSE_SAMPLES: u32 = 48;

/// First output index of the polyphonic voice jacks.
pub const POLY_OUT_BASE: usize = MAX_MIDI_JACKS;
/// First output index of the channel-wide jacks.
pub const GLOBAL_OUT_BASE: usize = POLY_OUT_BASE + MIDI_POLY_VOICES * 3;
pub const TOTAL_MIDI_OUTS: usize = GLOBAL_OUT_BASE + MIDI_GLOBAL_OUTS.len();

pub fn audio_out_manifest() -> Manifest {
    Manifest {
        id: AUDIO_OUT_ID.into(),
        name: "Audio Output".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::ANALYSIS.into(),
        inputs: AUDIO_OUT_JACKS
            .iter()
            .map(|(id, name)| JackDecl {
                id: (*id).into(),
                name: (*name).into(),
                default: 0.0,
                audio: false,
                knob: None,
                display: None,
            })
            .chain([
                JackDecl {
                    id: "channel_offset".into(),
                    name: "Device Channel Offset".into(),
                    default: 0.0,
                    audio: false,
                    knob: Some(KnobConfig {
                        style: KnobStyle::Stepped,
                        min: 0.0,
                        max: 8.0,
                        curve: Curve::Linear,
                        steps: Some(9),
                    }),
                    display: None,
                },
                JackDecl {
                    id: "mute".into(),
                    name: "Mute".into(),
                    default: 0.0,
                    audio: false,
                    knob: Some(KnobConfig {
                        style: KnobStyle::Switch,
                        min: 0.0,
                        max: 10.0,
                        curve: Curve::Linear,
                        steps: None,
                    }),
                    display: None,
                },
            ])
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
        category: categories::ANALYSIS.into(),
        // Input jacks drive controller LEDs/feedback (one per LED mapping;
        // named like output mappings). Fixed count so graph buffers are
        // preallocated.
        inputs: (0..MAX_MIDI_LED_JACKS)
            .map(|i| JackDecl {
                id: format!("led{i}"),
                name: format!("LED {i}"),
                default: 0.0,
                audio: false,
                knob: None,
                display: None,
            })
            .collect(),
        // Outputs are, in order: MAX_MIDI_JACKS dynamic mapping slots (one
        // per learned control), then MIDI_POLY_VOICES pitch/gate/velocity
        // trios from the note allocator, then the channel-wide and
        // transport jacks. Fixed layout so patched slot indices are stable.
        outputs: (0..MAX_MIDI_JACKS)
            .map(|i| OutputDecl {
                id: format!("map{i}"),
                name: format!("Mapping {i}"),
                display: None,
            })
            .chain((0..MIDI_POLY_VOICES).flat_map(|v| {
                [("pitch", "Pitch"), ("gate", "Gate"), ("vel", "Velocity")]
                    .into_iter()
                    .map(move |(id, name)| OutputDecl {
                        id: format!("v{}_{id}", v + 1),
                        name: format!("Voice {} {name}", v + 1),
                        display: None,
                    })
            }))
            .chain(MIDI_GLOBAL_OUTS.iter().map(|(id, name)| OutputDecl {
                id: (*id).into(),
                name: (*name).into(),
                display: None,
            }))
            .collect(),
        params: vec![],
        ui: None,
        latency_samples: 0,
    }
}

/// Input jack index of the mute switch (after the audio jacks and
/// `channel_offset`).
pub const AUDIO_OUT_MUTE_JACK: usize = AUDIO_OUT_CHANNELS + 1;

/// Audio Output: the graph executor mixes this node's effective inputs into
/// the master bus; the module itself is a no-op.
pub struct AudioOutModule {
    pub channel_offset: usize,
    /// Mute switch state (>= 1 V = muted); the graph skips the master mix.
    pub muted: bool,
}

impl HostModule for AudioOutModule {
    fn process(&mut self, i: &[Vec<f32>], _o: &mut [Vec<f32>], _m: u64, f: usize) {
        // channel_offset / mute are ordinary input jacks (knob or wire);
        // the graph mixes the audio jacks using the values captured here.
        if f == 0 {
            return;
        }
        if let Some(buf) = i.get(AUDIO_OUT_CHANNELS) {
            self.channel_offset = (buf[0].round().max(0.0)) as usize;
        }
        if let Some(buf) = i.get(AUDIO_OUT_MUTE_JACK) {
            self.muted = buf[0] >= 1.0;
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

/// Kind of MIDI control a mapping listens for. Serializes as `"cc"` /
/// `"note"` — the exact strings patches have always stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MidiMapKind {
    Cc,
    Note,
}

impl MidiMapKind {
    /// RT-side atomic encoding (`MappingCell.kind`).
    pub fn as_u8(self) -> u8 {
        match self {
            MidiMapKind::Cc => MAP_KIND_CC,
            MidiMapKind::Note => MAP_KIND_NOTE,
        }
    }

    pub fn from_u8(raw: u8) -> Option<Self> {
        match raw {
            MAP_KIND_CC => Some(MidiMapKind::Cc),
            MAP_KIND_NOTE => Some(MidiMapKind::Note),
            _ => None,
        }
    }
}

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

/// One voice of the polyphonic note allocator.
#[derive(Clone, Copy, Default)]
struct Voice {
    /// MIDI note currently held, if any.
    note: Option<u8>,
    pitch: f32,
    velocity: f32,
    gate: f32,
    /// Allocation counter at note-on; the oldest voice is stolen first.
    age: u64,
    /// Held by the sustain pedal after its note-off.
    sustained: bool,
}

/// The RT-side MIDI module: consumes injected/hardware events from an SPSC
/// ring and renders mapped controls as output signals scaled to [-10, +10].
/// Notes emit gate-style 10.0 (on) / 0.0 (off); CC maps 0..127 -> -10..+10.
///
/// Alongside the learned mappings it runs a fixed polyphonic note allocator
/// (PRD §7.1 "MIDI to CV"): note-ons claim a free voice (stealing the oldest
/// when all are busy) and drive that voice's pitch (1 V/oct, 0 = C4 = note
/// 60), gate and velocity jacks, while mod wheel, pitch bend, aftertouch,
/// sustain and the transport/clock messages drive the channel-wide jacks.
pub struct MidiModule {
    consumer: rtrb::Consumer<MidiEvent>,
    shared: Arc<MidiShared>,
    values: [f32; MAX_MIDI_JACKS],
    voices: [Voice; MIDI_POLY_VOICES],
    /// Monotonic note-on counter driving voice stealing.
    voice_clock: u64,
    mod_wheel: f32,
    bend: f32,
    pressure: f32,
    sustain: bool,
    /// Remaining samples of the current clock/beat trigger pulse.
    clock_pulse: u32,
    beat_pulse: u32,
    /// 24-ppqn tick counter, reset by START/CONTINUE and SONG POSITION.
    clock_ticks: u32,
    transport: f32,
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
            voices: [Voice::default(); MIDI_POLY_VOICES],
            voice_clock: 0,
            mod_wheel: 0.0,
            bend: 0.0,
            pressure: 0.0,
            sustain: false,
            clock_pulse: 0,
            beat_pulse: 0,
            clock_ticks: 0,
            transport: 0.0,
            frame: 0,
            out_producer,
            led_last: [-1; MAX_MIDI_LED_JACKS],
        }
    }

    /// Claim a voice for `note`: reuse the one already holding it, else a
    /// free voice, else steal the oldest.
    fn note_on(&mut self, note: u8, velocity: u8) {
        self.voice_clock += 1;
        let slot = self
            .voices
            .iter()
            .position(|v| v.note == Some(note))
            .or_else(|| self.voices.iter().position(|v| v.note.is_none()))
            .unwrap_or_else(|| {
                let mut oldest = 0;
                for i in 1..MIDI_POLY_VOICES {
                    if self.voices[i].age < self.voices[oldest].age {
                        oldest = i;
                    }
                }
                oldest
            });
        self.voices[slot] = Voice {
            note: Some(note),
            // 1 V/oct with note 60 (C4) at 0.0, matching `pitch_to_hz`.
            pitch: (note as f32 - 60.0) / 12.0,
            velocity: velocity as f32 / 127.0 * 10.0,
            gate: 10.0,
            age: self.voice_clock,
            sustained: false,
        };
    }

    fn note_off(&mut self, note: u8) {
        let sustain = self.sustain;
        for v in self.voices.iter_mut() {
            if v.note == Some(note) {
                if sustain {
                    v.sustained = true;
                } else {
                    v.note = None;
                    v.gate = 0.0;
                }
            }
        }
    }

    /// Poly/channel handling that runs regardless of learned mappings.
    fn apply_voice_event(&mut self, data: [u8; 3]) {
        match data[0] & 0xF0 {
            0x90 if data[2] > 0 => self.note_on(data[1], data[2]),
            0x90 | 0x80 => self.note_off(data[1]),
            0xA0 => {
                let level = data[2] as f32 / 127.0 * 10.0;
                for v in self.voices.iter_mut() {
                    if v.note == Some(data[1]) {
                        v.velocity = level;
                    }
                }
            }
            0xD0 => self.pressure = data[1] as f32 / 127.0 * 10.0,
            0xE0 => {
                // 14-bit, centred: -5..+5 (a ±2 semitone bend at 0.5 V/oct
                // scaling is left to the patch's attenuverter).
                let raw = ((data[2] as i32) << 7 | data[1] as i32) - 8192;
                self.bend = raw as f32 / 8192.0 * 5.0;
            }
            0xB0 => match data[1] {
                1 => self.mod_wheel = data[2] as f32 / 127.0 * 10.0,
                64 => {
                    self.sustain = data[2] >= 64;
                    if !self.sustain {
                        for v in self.voices.iter_mut() {
                            if v.sustained {
                                v.sustained = false;
                                v.note = None;
                                v.gate = 0.0;
                            }
                        }
                    }
                }
                // All notes off / all sound off.
                120 | 123 => {
                    self.voices = [Voice::default(); MIDI_POLY_VOICES];
                }
                _ => {}
            },
            _ => match data[0] {
                0xF8 => {
                    self.clock_pulse = CLOCK_PULSE_SAMPLES;
                    if self.clock_ticks.is_multiple_of(24) {
                        self.beat_pulse = CLOCK_PULSE_SAMPLES;
                    }
                    self.clock_ticks = self.clock_ticks.wrapping_add(1);
                }
                0xFA => {
                    self.clock_ticks = 0;
                    self.transport = 10.0;
                }
                0xFB => self.transport = 10.0,
                0xFC => self.transport = 0.0,
                _ => {}
            },
        }
    }

    fn apply_event(&mut self, data: [u8; 3]) {
        self.apply_voice_event(data);
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
            for (v, voice) in self.voices.iter().enumerate() {
                let base = POLY_OUT_BASE + v * 3;
                if let Some(out) = outputs.get_mut(base) {
                    out[s] = voice.pitch;
                }
                if let Some(out) = outputs.get_mut(base + 1) {
                    out[s] = voice.gate;
                }
                if let Some(out) = outputs.get_mut(base + 2) {
                    out[s] = voice.velocity;
                }
            }
            let clock = if self.clock_pulse > 0 {
                self.clock_pulse -= 1;
                10.0
            } else {
                0.0
            };
            let beat = if self.beat_pulse > 0 {
                self.beat_pulse -= 1;
                10.0
            } else {
                0.0
            };
            let globals = [
                self.mod_wheel,
                self.bend,
                self.pressure,
                if self.sustain { 10.0 } else { 0.0 },
                clock,
                beat,
                self.transport,
            ];
            for (g, value) in globals.iter().enumerate() {
                if let Some(out) = outputs.get_mut(GLOBAL_OUT_BASE + g) {
                    out[s] = *value;
                }
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
        // Mapping values, then per-voice pitch/gate/velocity, then the
        // channel-wide values — so held notes survive a hot reload.
        let mut bytes = Vec::with_capacity((MAX_MIDI_JACKS + MIDI_POLY_VOICES * 3 + 3) * 4);
        for v in &self.values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        for v in &self.voices {
            bytes.extend_from_slice(&v.pitch.to_le_bytes());
            bytes.extend_from_slice(&v.gate.to_le_bytes());
            bytes.extend_from_slice(&v.velocity.to_le_bytes());
        }
        for v in [self.mod_wheel, self.bend, self.pressure] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        let mut words = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c));
        for (i, w) in words.by_ref().take(MAX_MIDI_JACKS).enumerate() {
            self.values[i] = w;
        }
        for v in self.voices.iter_mut() {
            let (Some(pitch), Some(gate), Some(vel)) = (words.next(), words.next(), words.next())
            else {
                return;
            };
            v.pitch = pitch;
            v.gate = gate;
            v.velocity = vel;
        }
        self.mod_wheel = words.next().unwrap_or(self.mod_wheel);
        self.bend = words.next().unwrap_or(self.bend);
        self.pressure = words.next().unwrap_or(self.pressure);
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
