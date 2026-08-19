//! Built-in DAW timeline: an always-present, native multitrack
//! recorder/player that lives in the app's bottom bar (not a rack module —
//! it is created with the engine, cannot be removed, and never appears in
//! the module picker; instance id [`DAW_INSTANCE`] is reserved).
//!
//! - Tracks are audio (mono or stereo, clip = sampled audio) or continuous
//!   (one CV lane, clip = sampled voltage). Each track owns contiguous
//!   input AND output jack slots from a fixed budget (`i<slot>`/`t<slot>`,
//!   [`MAX_DAW_JACKS`] each) — slots stay with the track across
//!   rename/reorder so persisted wires never break (the choreo pattern).
//! - Inputs are plain wire jacks (additive law): an audio track records
//!   whatever audio is summed into its input(s); a continuous track records
//!   the voltage on its input (a knob, an LFO, the hands module, …).
//! - Clips are stored in FILE units [-1, 1] at the ENGINE sample rate
//!   (resampled at import/record time) and scaled by `SIGNAL_MAX` at the
//!   output, so one code path serves audio (±10 V rails) and CV
//!   (volts = file × 10) symmetrically.
//! - Transport is frame-based (`play`/`stop`/`seek`), driven control-side
//!   over the SPSC command ring; the RT module renders clips at the
//!   transport position and captures armed inputs into a preallocated
//!   capture ring. Zero allocations/locks on the RT thread; replaced
//!   programs return on a garbage ring for off-RT drop.
//! - Recording: the control side drains the capture ring into a pending
//!   buffer ([`Engine::daw_poll`]) and finalizes it into a WAV clip on
//!   stop. Mic capture never touches the RT thread: a cpal input stream
//!   (or [`Engine::daw_feed_capture`] in tests) feeds the same pending
//!   buffer control-side.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::graph::SIGNAL_MAX;
use crate::manifest::{categories, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;
use serde::{Deserialize, Serialize};

pub const DAW_ID: &str = "builtin.daw";
/// Reserved instance id of the singleton DAW node.
pub const DAW_INSTANCE: &str = "daw";

/// Fixed TRACK jack budget (graph buffers are preallocated), inputs and
/// outputs. Extra non-track outputs (the clock) live above this range.
pub const MAX_DAW_JACKS: usize = 64;

/// Output jack index of the transport clock (one pulse per beat while
/// playing) — the slot just past the track budget, so track allocation
/// never collides with it.
pub const CLOCK_JACK: usize = MAX_DAW_JACKS;

/// Clock pulse shape: 5 ms at 10 V, the clock extension's convention.
pub const CLOCK_PULSE_SECS: f32 = 0.005;
pub const CLOCK_GATE_V: f32 = 10.0;

/// Capture ring capacity in samples (~21 s of stereo at 48 kHz); the
/// control side drains it every poll, so this is headroom, not a limit.
const CAPTURE_RING_CAP: usize = 1 << 21;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DawTrackKind {
    Audio,
    Continuous,
    /// Beat-grid note track: no clip file — notes live in the patch
    /// ([`DawNote`]) and render on two jacks (pitch 1 V/oct + gate, the
    /// choreo note-track convention).
    Midi,
}

/// One note on a MIDI track's beat grid. Times are in BEATS (1 beat =
/// one quarter note at the timeline BPM), converted to frames when the
/// program is compiled.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DawNote {
    /// Start position in beats from timeline zero.
    pub beat: f32,
    /// Length in beats.
    pub len: f32,
    /// MIDI note number (60 = C4 = 0 V on the pitch jack).
    pub pitch: u8,
    /// 0..1; scales the gate jack's 0..10 V output.
    pub velocity: f32,
}

/// 1 V/oct voltage of a MIDI note number (0 V = MIDI 60 = C4).
pub fn midi_note_to_volts(pitch: u8) -> f32 {
    (pitch as f32 - 60.0) / 12.0
}

/// One DAW track as persisted in the patch and shown in the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DawTrack {
    pub name: String,
    /// First jack slot; the track owns `channels()` contiguous slots on
    /// BOTH sides (`i<slot>` input, `t<slot>` output). Stable across
    /// rename/reorder — persisted wires reference these names.
    pub jack: usize,
    pub kind: DawTrackKind,
    /// Audio tracks only: two channels (L/R) instead of one.
    #[serde(default)]
    pub stereo: bool,
    /// Absolute path of the clip file (library-managed / recordings dir),
    /// like a deck's `track` — the sample data itself is not in the patch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<String>,
    /// MIDI tracks only: the note grid (beats; sorted by `beat`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<DawNote>,
}

impl DawTrack {
    pub fn channels(&self) -> usize {
        match self.kind {
            DawTrackKind::Audio if self.stereo => 2,
            // Pitch + gate, contiguous (the choreo note-track pattern).
            DawTrackKind::Midi => 2,
            _ => 1,
        }
    }
}

pub const DEFAULT_BPM: f32 = 120.0;

fn default_bpm() -> f32 {
    DEFAULT_BPM
}

/// DAW state, canonical on the control side and persisted in the patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DawState {
    pub tracks: Vec<DawTrack>,
    /// Timeline tempo; the beat grid and MIDI-note scheduling derive from
    /// it (audio/CV clips are frame-based and unaffected).
    #[serde(default = "default_bpm")]
    pub bpm: f32,
}

impl Default for DawState {
    fn default() -> Self {
        DawState {
            tracks: Vec::new(),
            bpm: DEFAULT_BPM,
        }
    }
}

/// Find a free contiguous run of `n` jack slots (shared by tracks' input
/// and output sides — one allocation covers both).
pub fn alloc_jacks(state: &DawState, budget: usize, n: usize) -> anyhow::Result<usize> {
    let mut used = vec![false; budget];
    for t in &state.tracks {
        let start = t.jack.min(budget);
        used[start..(t.jack + t.channels()).min(budget)].fill(true);
    }
    let mut run = 0;
    for (i, u) in used.iter().enumerate() {
        run = if *u { 0 } else { run + 1 };
        if run == n {
            return Ok(i + 1 - n);
        }
    }
    anyhow::bail!("no free DAW jack slots (budget {budget})")
}

pub fn daw_manifest() -> Manifest {
    Manifest {
        id: DAW_ID.into(),
        name: "DAW".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        // Plain wire jacks (no knob): audio and CV keep the additive law.
        inputs: (0..MAX_DAW_JACKS)
            .map(|i| JackDecl {
                id: format!("i{i}"),
                name: format!("In {i}"),
                default: 0.0,
                audio: false,
                knob: None,
                display: None,
            })
            .collect(),
        outputs: (0..MAX_DAW_JACKS)
            .map(|i| OutputDecl {
                id: format!("t{i}"),
                name: format!("Track {i}"),
                display: None,
            })
            .chain(std::iter::once(OutputDecl {
                id: "clock".into(),
                name: "Clock".into(),
                display: None,
            }))
            .collect(),
        params: vec![],
        ui: None,
        latency_samples: 0,
    }
}

/// Decoded clip sample data: per-channel, FILE units [-1, 1], engine rate.
pub struct ClipData {
    pub channels: Vec<Vec<f32>>,
}

impl ClipData {
    pub fn frames(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }
}

/// One MIDI note precompiled to engine frames for the RT module.
#[derive(Debug, Clone, Copy)]
pub struct RtNote {
    pub start: u64,
    pub end: u64,
    /// 1 V/oct pitch voltage.
    pub volts: f32,
    /// Gate level while active (velocity × 10 V).
    pub gate: f32,
}

/// One track of the compiled program the RT module plays.
pub struct DawProgramTrack {
    pub jack: u16,
    pub channels: u8,
    pub clip: Option<Arc<ClipData>>,
    /// MIDI tracks: notes precompiled to frames, sorted by `start`.
    /// Rendered on `jack` (pitch, holds the last started note) and
    /// `jack + 1` (gate; overlapping notes: last started wins).
    pub notes: Vec<RtNote>,
}

/// The immutable program shipped to the RT module on every edit.
pub struct DawProgram {
    pub tracks: Vec<DawProgramTrack>,
    /// Beat interval at the timeline BPM, for the clock output.
    pub frames_per_beat: f64,
    /// Clock pulse width ([`CLOCK_PULSE_SECS`] at the engine rate),
    /// precomputed control-side so the RT thread does no rate math.
    pub pulse_frames: u64,
}

/// Commands toward the RT module (SPSC ring, applied at block boundaries).
pub enum DawCmd {
    Program(Arc<DawProgram>),
    Play,
    Stop,
    /// Absolute transport position in engine frames.
    Seek(u64),
    /// Start copying input jacks `jack..jack+channels` (frame-interleaved)
    /// into the capture ring.
    CaptureStart {
        jack: u16,
        channels: u8,
    },
    CaptureStop,
}

/// RT -> UI transport state.
#[derive(Default)]
pub struct DawShared {
    playhead: AtomicU64,
    playing: AtomicBool,
    /// Samples the RT side failed to push (capture ring full — the control
    /// side stopped draining).
    pub capture_overruns: AtomicU64,
}

impl DawShared {
    pub fn playhead(&self) -> u64 {
        self.playhead.load(Ordering::Relaxed)
    }
    pub fn playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }
}

/// Where a recording's samples come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DawRecordSource {
    /// The track's input jack(s), captured sample-accurately on the RT
    /// thread (engine units, ±10 V).
    Input,
    /// A microphone / external feed, pushed control-side in FILE units
    /// [-1, 1] via [`Engine::daw_feed_capture`] (cpal or tests).
    Mic,
}

/// An in-progress recording, accumulated control-side.
pub struct PendingRecord {
    /// Track INDEX (not jack slot) being recorded.
    pub track: usize,
    pub source: DawRecordSource,
    pub channels: usize,
    /// Frame-interleaved samples at `sample_rate`.
    pub data: Vec<f32>,
    pub sample_rate: f32,
}

/// Control-side plumbing for the DAW node.
pub struct DawControl {
    tx: rtrb::Producer<DawCmd>,
    garbage_rx: rtrb::Consumer<Arc<DawProgram>>,
    pub capture_rx: rtrb::Consumer<f32>,
    pub shared: Arc<DawShared>,
    /// Loaded clips by track jack slot: (source path, engine-rate data).
    pub clips: std::collections::HashMap<usize, (String, Arc<ClipData>)>,
    pub pending: Option<PendingRecord>,
}

impl DawControl {
    pub fn new(
        tx: rtrb::Producer<DawCmd>,
        garbage_rx: rtrb::Consumer<Arc<DawProgram>>,
        capture_rx: rtrb::Consumer<f32>,
        shared: Arc<DawShared>,
    ) -> Self {
        DawControl {
            tx,
            garbage_rx,
            capture_rx,
            shared,
            clips: std::collections::HashMap::new(),
            pending: None,
        }
    }

    pub fn send(&mut self, cmd: DawCmd) -> anyhow::Result<()> {
        while self.garbage_rx.pop().is_ok() {}
        self.tx
            .push(cmd)
            .map_err(|_| anyhow::anyhow!("too many pending DAW commands"))
    }
}

/// The RT-side DAW module: renders program clips at the transport position
/// and captures armed inputs. Zero allocations/locks on the RT thread.
pub struct DawRtModule {
    rx: rtrb::Consumer<DawCmd>,
    garbage_tx: rtrb::Producer<Arc<DawProgram>>,
    capture_tx: rtrb::Producer<f32>,
    program: Option<Arc<DawProgram>>,
    shared: Arc<DawShared>,
    playing: bool,
    pos: u64,
    /// Armed capture: (first input jack, channel count).
    capture: Option<(u16, u8)>,
}

impl DawRtModule {
    pub fn new(
        rx: rtrb::Consumer<DawCmd>,
        garbage_tx: rtrb::Producer<Arc<DawProgram>>,
        capture_tx: rtrb::Producer<f32>,
        shared: Arc<DawShared>,
    ) -> Self {
        DawRtModule {
            rx,
            garbage_tx,
            capture_tx,
            program: None,
            shared,
            playing: false,
            pos: 0,
            capture: None,
        }
    }
}

/// Ring capacity for the DAW command/garbage rings (edits are UI-rate).
pub const DAW_QUEUE_CAP: usize = 64;

/// Create the full ring plumbing for one DAW node:
/// `(control, rt_module)`.
pub fn daw_plumbing() -> (DawControl, DawRtModule) {
    let (tx, rx) = rtrb::RingBuffer::new(DAW_QUEUE_CAP);
    let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(DAW_QUEUE_CAP);
    let (capture_tx, capture_rx) = rtrb::RingBuffer::new(CAPTURE_RING_CAP);
    let shared = Arc::new(DawShared::default());
    (
        DawControl::new(tx, garbage_rx, capture_rx, shared.clone()),
        DawRtModule::new(rx, garbage_tx, capture_tx, shared),
    )
}

impl HostModule for DawRtModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        while let Ok(cmd) = self.rx.pop() {
            match cmd {
                DawCmd::Program(p) => {
                    if let Some(old) = self.program.replace(p) {
                        // Off-RT drop; if the garbage ring is full, drop
                        // here (bounded, edit-only path).
                        let _ = self.garbage_tx.push(old);
                    }
                }
                DawCmd::Play => self.playing = true,
                DawCmd::Stop => self.playing = false,
                DawCmd::Seek(f) => self.pos = f,
                DawCmd::CaptureStart { jack, channels } => self.capture = Some((jack, channels)),
                DawCmd::CaptureStop => self.capture = None,
            }
        }

        // Capture armed inputs, frame-interleaved, before rendering (the
        // input buffers already carry the summed wire values).
        if let Some((jack, channels)) = self.capture {
            let j0 = jack as usize;
            for s in 0..frames {
                for ch in 0..channels as usize {
                    let v = inputs.get(j0 + ch).map(|b| b[s]).unwrap_or(0.0);
                    if self.capture_tx.push(v).is_err() {
                        self.shared.capture_overruns.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }

        for out in outputs.iter_mut() {
            out[..frames].fill(0.0);
        }
        if self.playing {
            if let Some(program) = self.program.as_ref() {
                for t in &program.tracks {
                    if !t.notes.is_empty() {
                        // MIDI track: pitch on `jack` (holds the last
                        // started note), gate on `jack + 1`.
                        let j0 = t.jack as usize;
                        // Last note started at or before the block start
                        // sets the initial held pitch.
                        let mut next = t.notes.partition_point(|n| n.start <= self.pos);
                        let mut held = next.checked_sub(1).map(|i| t.notes[i].volts);
                        let (pitch_out, rest) = outputs[j0..].split_first_mut().unwrap();
                        let gate_out = &mut rest[0];
                        for s in 0..frames {
                            let p = self.pos + s as u64;
                            while next < t.notes.len() && t.notes[next].start <= p {
                                held = Some(t.notes[next].volts);
                                next += 1;
                            }
                            // Gate: the LAST-started note still active at
                            // p wins (reverse scan of started notes; note
                            // counts are UI-scale, so this stays cheap).
                            let mut gate = 0.0;
                            for n in t.notes[..next].iter().rev() {
                                if n.end > p {
                                    gate = n.gate;
                                    break;
                                }
                            }
                            pitch_out[s] = held.unwrap_or(0.0);
                            gate_out[s] = gate;
                        }
                        continue;
                    }
                    let Some(clip) = &t.clip else { continue };
                    let j0 = t.jack as usize;
                    for ch in 0..t.channels as usize {
                        // Mono clip on a stereo track feeds both sides.
                        let chan = &clip.channels[ch.min(clip.channels.len() - 1)];
                        let out = &mut outputs[j0 + ch];
                        for (s, o) in out[..frames].iter_mut().enumerate() {
                            let p = self.pos as usize + s;
                            if p < chan.len() {
                                *o = chan[p] * SIGNAL_MAX;
                            }
                        }
                    }
                }
            }
            // Clock: one pulse per beat while playing. A sample is high
            // when it lands within `pulse_frames` of the last beat edge
            // (beat edges are `round(k * frames_per_beat)`, matching the
            // control side's note scheduling).
            if let Some(program) = self.program.as_ref() {
                if program.frames_per_beat > 0.0 {
                    let clock = &mut outputs[CLOCK_JACK];
                    for (s, o) in clock[..frames].iter_mut().enumerate() {
                        let p = self.pos + s as u64;
                        let k = (p as f64 / program.frames_per_beat).floor();
                        let edge = (k * program.frames_per_beat).round() as u64;
                        if p >= edge && p < edge + program.pulse_frames {
                            *o = CLOCK_GATE_V;
                        }
                    }
                }
            }
            // The transport keeps rolling past clip ends (recording and
            // DAW convention both need it).
            self.pos += frames as u64;
        }
        self.shared.playhead.store(self.pos, Ordering::Relaxed);
        self.shared.playing.store(self.playing, Ordering::Relaxed);
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(9);
        bytes.extend_from_slice(&self.pos.to_le_bytes());
        bytes.push(self.playing as u8);
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 9 {
            self.pos = u64::from_le_bytes(bytes[..8].try_into().unwrap());
            self.playing = bytes[8] != 0;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Linear resample one channel from `from` Hz to `to` Hz (deterministic;
/// used at import/record-finalize time, never on the RT thread).
pub fn resample_linear(chan: &[f32], from: f32, to: f32) -> Vec<f32> {
    if chan.is_empty() || from == to {
        return chan.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((chan.len() as f64) / ratio).round() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let i0 = pos as usize;
            let frac = (pos - i0 as f64) as f32;
            let a = chan[i0.min(chan.len() - 1)];
            let b = chan[(i0 + 1).min(chan.len() - 1)];
            a * (1.0 - frac) + b * frac
        })
        .collect()
}

/// Adapt decoded channels to a track's channel count: average down to
/// mono, duplicate mono up to stereo, drop extras.
pub fn adapt_channels(mut channels: Vec<Vec<f32>>, want: usize) -> Vec<Vec<f32>> {
    if channels.is_empty() {
        return vec![Vec::new(); want];
    }
    if want == 1 && channels.len() > 1 {
        let n = channels.len() as f32;
        let frames = channels[0].len();
        let mut mono = vec![0.0f32; frames];
        for ch in &channels {
            for (m, v) in mono.iter_mut().zip(ch) {
                *m += *v / n;
            }
        }
        return vec![mono];
    }
    while channels.len() < want {
        channels.push(channels[0].clone());
    }
    channels.truncate(want);
    channels
}
