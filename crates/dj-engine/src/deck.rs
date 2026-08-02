//! Built-in DJ Deck module (PRD §7, milestone M2).
//!
//! The flagship built-in module: plays a library track with DJ transport
//! semantics on top of the M1 playback foundations.
//!
//! - Inputs: `play_gate`, `speed` (pitch fader CV), `phase_nudge` (jog),
//!   `loop_toggle`, `cue_trig1..8`.
//! - Outputs: `audio_l`, `audio_r`, `beat_clock` (trigger per beat),
//!   `bar_clock` (trigger per 4-beat bar), `phase` (0..10 ramp per bar),
//!   `bpm` (pitch-style: 0.0 = 120 BPM, 1 unit per doubling).
//! - Params: `pitch_range` (fraction; 0.08 = ±8 %), `keylock`, `reverse`,
//!   `slip`.
//!
//! DJ state (beatgrid, 8 hot cues, active loop) lives RT-side as plain
//! fields, updated via a lock-free SPSC command ring. Decoding and all
//! heavy setup happen on the control thread (playback.rs pattern); the RT
//! path performs no allocation, locking, or IO. Replaced tracks travel back
//! on a garbage ring for off-RT drop.
//!
//! **Keylock** is a two-voice granular (windowed overlap-add) time-stretch:
//! grains read the track at its native rate (pitch-neutral) while grain
//! spawn positions advance at the tempo-scaled rate. The Hann window table
//! is precomputed at construction (off-RT); 50 % hop gives exact
//! constant-overlap-add.
//!
//! **Sync** (PRD §7 "beat-sync and phase-sync to another deck"): every deck
//! publishes its transport (position, rate, grid, engine-frame stamp) into
//! an atomic [`DeckShared`]. A synced follower reads its master's shared
//! state each block, extrapolates to its own clock, snaps phase once on
//! sync, then tempo-matches with a small proportional phase correction.
//! All modules process on the same RT thread, so these atomics are
//! contention-free; control-side reads (UI status) may lag a block.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::graph::SIGNAL_MAX;
use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{JackDecl, Manifest, OutputDecl, ParamDecl};
use crate::module_host::HostModule;
use crate::playback::TrackData;

pub const DECK_ID: &str = "builtin.deck";

pub const N_CUES: usize = 8;
/// Beats per bar for `bar_clock`/`phase` (fixed 4/4 in M2).
pub const BEATS_PER_BAR: f64 = 4.0;
/// beat/bar clock pulse length in seconds (gate high = 10.0 per PRD §4).
pub const CLOCK_PULSE_SECS: f64 = 0.010;
/// `bpm` output reference: 0.0 = 120 BPM, 1 unit per doubling.
pub const BPM_REF: f64 = 120.0;
/// Full-scale `phase_nudge` (±10) bends the rate by this fraction (±50 %).
pub const NUDGE_DEPTH: f64 = 0.5;
/// Keylock grain length in seconds (two-voice Hann OLA, 50 % hop).
pub const KEYLOCK_GRAIN_SECS: f64 = 0.040;
/// WSOLA alignment: candidate grain starts are searched within ± this
/// window around the ideal (virtual-timeline) position...
pub const KEYLOCK_SEARCH_SECS: f64 = 0.004;
/// ...maximizing cross-correlation with the natural continuation of the
/// previous grain over this many seconds. Keeps grain joins phase-coherent
/// so pitch holds under time-stretch (no OLA comb drift).
pub const KEYLOCK_CORR_SECS: f64 = 0.005;
/// Sync phase-correction gain (per block) and correction clamp.
const SYNC_PHASE_GAIN: f64 = 4.0;
const SYNC_CORR_CLAMP: f64 = 0.05;

// Input jack indices.
const IN_PLAY_GATE: usize = 0;
const IN_SPEED: usize = 1;
const IN_PHASE_NUDGE: usize = 2;
const IN_LOOP_TOGGLE: usize = 3;
const IN_CUE_BASE: usize = 4; // cue_trig1..8 = 4..=11

// Output jack indices.
const OUT_AUDIO_L: usize = 0;
const OUT_AUDIO_R: usize = 1;
const OUT_BEAT_CLOCK: usize = 2;
const OUT_BAR_CLOCK: usize = 3;
const OUT_PHASE: usize = 4;
const OUT_BPM: usize = 5;

pub fn deck_manifest() -> Manifest {
    let mut inputs = vec![
        JackDecl {
            id: "play_gate".into(),
            name: "Play Gate".into(),
            default: 0.0,
            knob: Some(KnobConfig {
                style: KnobStyle::Button,
                min: 0.0,
                max: 10.0,
                curve: Curve::Linear,
                steps: None,
            }),
        },
        JackDecl {
            id: "speed".into(),
            name: "Pitch Fader".into(),
            default: 0.0,
            knob: Some(KnobConfig {
                style: KnobStyle::Continuous,
                min: -10.0,
                max: 10.0,
                curve: Curve::Linear,
                steps: None,
            }),
        },
        JackDecl {
            id: "phase_nudge".into(),
            name: "Phase Nudge".into(),
            default: 0.0,
            knob: Some(KnobConfig {
                style: KnobStyle::Continuous,
                min: -10.0,
                max: 10.0,
                curve: Curve::Linear,
                steps: None,
            }),
        },
        JackDecl {
            id: "loop_toggle".into(),
            name: "Loop Toggle".into(),
            default: 0.0,
            knob: Some(KnobConfig {
                style: KnobStyle::Button,
                min: 0.0,
                max: 10.0,
                curve: Curve::Linear,
                steps: None,
            }),
        },
    ];
    for i in 1..=N_CUES {
        inputs.push(JackDecl {
            id: format!("cue_trig{i}"),
            name: format!("Cue {i}"),
            default: 0.0,
            knob: Some(KnobConfig {
                style: KnobStyle::Button,
                min: 0.0,
                max: 10.0,
                curve: Curve::Linear,
                steps: None,
            }),
        });
    }
    Manifest {
        id: DECK_ID.into(),
        name: "DJ Deck".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        inputs,
        outputs: vec![
            OutputDecl {
                id: "audio_l".into(),
                name: "Audio L".into(),
            },
            OutputDecl {
                id: "audio_r".into(),
                name: "Audio R".into(),
            },
            OutputDecl {
                id: "beat_clock".into(),
                name: "Beat Clock".into(),
            },
            OutputDecl {
                id: "bar_clock".into(),
                name: "Bar Clock".into(),
            },
            OutputDecl {
                id: "phase".into(),
                name: "Bar Phase".into(),
            },
            OutputDecl {
                id: "bpm".into(),
                name: "BPM".into(),
            },
        ],
        params: vec![
            ParamDecl {
                id: "pitch_range".into(),
                name: "Pitch Range".into(),
                param_type: "float".into(),
                default: serde_json::json!(0.08),
                min: Some(0.0),
                max: Some(0.5),
            },
            ParamDecl {
                id: "keylock".into(),
                name: "Keylock".into(),
                param_type: "toggle".into(),
                default: serde_json::json!(false),
                min: None,
                max: None,
            },
            ParamDecl {
                id: "reverse".into(),
                name: "Reverse".into(),
                param_type: "toggle".into(),
                default: serde_json::json!(false),
                min: None,
                max: None,
            },
            ParamDecl {
                id: "slip".into(),
                name: "Slip".into(),
                param_type: "toggle".into(),
                default: serde_json::json!(false),
                min: None,
                max: None,
            },
        ],
        ui: None,
        latency_samples: 0,
    }
}

/// Transport state a deck publishes each block (and on load), readable by
/// sync followers (same RT thread — contention-free) and the control thread
/// (UI status; may lag one block). f64s are stored as bit patterns.
#[derive(Debug)]
pub struct DeckShared {
    /// Audible position, in track seconds.
    pos_secs: AtomicU64,
    /// Effective rate multiplier (track-seconds advanced per output second).
    rate: AtomicU64,
    playing: AtomicBool,
    /// Beatgrid BPM (0.0 = no grid).
    grid_bpm: AtomicU64,
    /// Beatgrid anchor, in track seconds.
    grid_anchor: AtomicU64,
    /// Engine frame at which this state was published.
    stamp: AtomicU64,
    /// Track duration in seconds (0.0 = no track).
    duration: AtomicU64,
}

impl Default for DeckShared {
    fn default() -> Self {
        DeckShared {
            pos_secs: AtomicU64::new(0.0f64.to_bits()),
            rate: AtomicU64::new(1.0f64.to_bits()),
            playing: AtomicBool::new(false),
            grid_bpm: AtomicU64::new(0.0f64.to_bits()),
            grid_anchor: AtomicU64::new(0.0f64.to_bits()),
            stamp: AtomicU64::new(0),
            duration: AtomicU64::new(0.0f64.to_bits()),
        }
    }
}

impl DeckShared {
    #[inline]
    fn get(a: &AtomicU64) -> f64 {
        f64::from_bits(a.load(Ordering::Relaxed))
    }
    #[inline]
    fn set(a: &AtomicU64, v: f64) {
        a.store(v.to_bits(), Ordering::Relaxed);
    }

    pub fn position_secs(&self) -> f64 {
        Self::get(&self.pos_secs)
    }
    pub fn rate(&self) -> f64 {
        Self::get(&self.rate)
    }
    pub fn playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }
    pub fn grid_bpm(&self) -> f64 {
        Self::get(&self.grid_bpm)
    }
    pub fn grid_anchor(&self) -> f64 {
        Self::get(&self.grid_anchor)
    }
    pub fn duration_secs(&self) -> f64 {
        Self::get(&self.duration)
    }
}

/// Commands from the control thread, applied at block boundaries.
/// Fixed-size; `Arc` payloads only ever decrement refcounts on the RT side
/// (the control thread keeps its own clones alive).
pub enum DeckCmd {
    Load(Arc<TrackData>),
    /// bpm <= 0 clears the grid.
    Grid {
        bpm: f64,
        anchor_secs: f64,
    },
    /// `pos` = NaN clears the cue slot.
    Cue {
        slot: usize,
        pos_secs: f64,
    },
    Seek(f64),
    Loop {
        start_secs: f64,
        end_secs: f64,
    },
    LoopEnabled(bool),
    SyncTo(Option<Arc<DeckShared>>),
}

/// Control-side state the engine keeps for each deck node: command ring
/// producer, garbage return, decoded track (for waveforms), and the
/// authoritative copies of grid/cues/loop for status & persistence. The
/// library DB remains the canonical cross-patch store; the app layer keeps
/// the two in sync.
pub struct DeckControl {
    pub cmd_tx: rtrb::Producer<DeckCmd>,
    pub garbage_rx: rtrb::Consumer<Arc<TrackData>>,
    pub shared: Arc<DeckShared>,
    pub track: Option<Arc<TrackData>>,
    pub grid: Option<(f64, f64)>, // (bpm, anchor_secs)
    pub cues: [Option<f64>; N_CUES],
    pub loop_region: Option<(f64, f64)>,
    pub loop_enabled: bool,
    pub sync_to: Option<String>,
    /// Tap-tempo history: track positions (seconds) of recent taps.
    pub taps: Vec<f64>,
}

impl DeckControl {
    pub fn new(
        cmd_tx: rtrb::Producer<DeckCmd>,
        garbage_rx: rtrb::Consumer<Arc<TrackData>>,
        shared: Arc<DeckShared>,
    ) -> Self {
        DeckControl {
            cmd_tx,
            garbage_rx,
            shared,
            track: None,
            grid: None,
            cues: [None; N_CUES],
            loop_region: None,
            loop_enabled: false,
            sync_to: None,
            taps: Vec::new(),
        }
    }
}

/// Snapshot of a deck for UIs (serialized over IPC).
#[derive(Debug, Clone, Serialize)]
pub struct DeckStatus {
    pub track: Option<String>,
    pub duration_secs: f64,
    pub position_secs: f64,
    pub rate: f64,
    pub playing: bool,
    pub grid_bpm: Option<f64>,
    pub grid_anchor_secs: Option<f64>,
    /// Grid BPM scaled by the current rate, when a grid exists.
    pub effective_bpm: Option<f64>,
    pub cues: Vec<Option<f64>>,
    pub loop_start_secs: Option<f64>,
    pub loop_end_secs: Option<f64>,
    pub loop_enabled: bool,
    pub sync_to: Option<String>,
}

/// The RT-side deck module.
pub struct DeckModule {
    cmd_rx: rtrb::Consumer<DeckCmd>,
    garbage_tx: rtrb::Producer<Arc<TrackData>>,
    shared: Arc<DeckShared>,
    sync: Option<Arc<DeckShared>>,
    /// A beat-phase snap is owed as soon as the sync master goes live.
    snap_pending: bool,

    track: Option<Arc<TrackData>>,
    engine_rate: f64,

    /// Audible position in track frames (fractional).
    pos: f64,
    /// Slip ghost position (track frames): where the deck would be had no
    /// loop/cue interrupted playback.
    ghost: f64,
    ended: bool,

    grid_bpm: f64,       // 0 = no grid
    grid_anchor: f64,    // seconds
    cues: [f64; N_CUES], // seconds; NaN = unset
    loop_start: f64,     // seconds
    loop_end: f64,
    loop_on: bool,

    pitch_range: f64,
    keylock: bool,
    reverse: bool,
    slip: bool,

    prev_gate: bool,
    prev_loop_toggle: bool,
    prev_cue: [bool; N_CUES],
    beat_pulse_left: u32,
    bar_pulse_left: u32,

    // Keylock granular state (two voices, Hann OLA at 50 % hop).
    window: Vec<f32>,
    grain_len: usize,
    hop: usize,
    voice_start: [f64; 2], // track frame at grain start
    voice_off: [usize; 2], // output samples into the grain (== grain_len: idle)
    hop_phase: usize,
    next_voice: usize,
    /// WSOLA scratch: the previous grain's natural continuation (channel 0),
    /// preallocated at construction.
    corr_ref: Vec<f32>,
    search_radius: usize,

    engine_frame: u64,
}

impl DeckModule {
    pub fn new(
        cmd_rx: rtrb::Consumer<DeckCmd>,
        garbage_tx: rtrb::Producer<Arc<TrackData>>,
        shared: Arc<DeckShared>,
        engine_rate: f32,
    ) -> Self {
        let grain_len = ((engine_rate as f64 * KEYLOCK_GRAIN_SECS) as usize).max(64) & !1;
        let window: Vec<f32> = (0..grain_len)
            .map(|n| {
                let x = n as f64 / grain_len as f64;
                (0.5 - 0.5 * (2.0 * std::f64::consts::PI * x).cos()) as f32
            })
            .collect();
        DeckModule {
            cmd_rx,
            garbage_tx,
            shared,
            sync: None,
            snap_pending: false,
            track: None,
            engine_rate: engine_rate as f64,
            pos: 0.0,
            ghost: 0.0,
            ended: false,
            grid_bpm: 0.0,
            grid_anchor: 0.0,
            cues: [f64::NAN; N_CUES],
            loop_start: 0.0,
            loop_end: 0.0,
            loop_on: false,
            pitch_range: 0.08,
            keylock: false,
            reverse: false,
            slip: false,
            prev_gate: false,
            prev_loop_toggle: false,
            prev_cue: [false; N_CUES],
            beat_pulse_left: 0,
            bar_pulse_left: 0,
            window,
            grain_len,
            hop: grain_len / 2,
            voice_start: [0.0; 2],
            voice_off: [grain_len; 2],
            hop_phase: 0,
            next_voice: 0,
            corr_ref: vec![0.0; (engine_rate as f64 * KEYLOCK_CORR_SECS) as usize],
            search_radius: (engine_rate as f64 * KEYLOCK_SEARCH_SECS) as usize,
            engine_frame: 0,
        }
    }

    /// WSOLA grain alignment: pick the start position within
    /// ±`search_radius` of `target` whose channel-0 content best matches
    /// the natural continuation of the currently playing grain. Bounded
    /// work, no allocation (scratch preallocated).
    fn align_grain_start(&mut self, target: f64, natural: f64, step: f64) -> f64 {
        let Some(track) = self.track.as_ref() else {
            return target;
        };
        let ch0 = &track.channels[0];
        for (k, r) in self.corr_ref.iter_mut().enumerate() {
            *r = Self::sample_at(ch0, natural + k as f64 * step);
        }
        let mut best_d = 0i64;
        let mut best_score = f32::NEG_INFINITY;
        let radius = self.search_radius as i64;
        for d in -radius..=radius {
            let cand = target + d as f64;
            let mut score = 0.0f32;
            for (k, &r) in self.corr_ref.iter().enumerate() {
                score += r * Self::sample_at(ch0, cand + k as f64 * step);
            }
            if score > best_score {
                best_score = score;
                best_d = d;
            }
        }
        target + best_d as f64
    }

    fn apply_cmd(&mut self, cmd: DeckCmd) {
        match cmd {
            DeckCmd::Load(t) => {
                if let Some(old) = self.track.replace(t) {
                    let _ = self.garbage_tx.push(old);
                }
                self.pos = 0.0;
                self.ghost = 0.0;
                self.ended = false;
                self.loop_on = false;
                self.loop_start = 0.0;
                self.loop_end = 0.0;
                self.grid_bpm = 0.0;
                self.grid_anchor = 0.0;
                self.cues = [f64::NAN; N_CUES];
                self.reset_grains();
            }
            DeckCmd::Grid { bpm, anchor_secs } => {
                self.grid_bpm = if bpm > 0.0 { bpm } else { 0.0 };
                self.grid_anchor = anchor_secs;
            }
            DeckCmd::Cue { slot, pos_secs } => {
                if slot < N_CUES {
                    self.cues[slot] = pos_secs;
                }
            }
            DeckCmd::Seek(secs) => {
                if let Some(sr) = self.track_rate() {
                    self.pos = (secs * sr).max(0.0);
                    self.ghost = self.pos;
                    self.ended = false;
                    self.reset_grains();
                }
            }
            DeckCmd::Loop {
                start_secs,
                end_secs,
            } => {
                self.loop_start = start_secs;
                self.loop_end = end_secs;
            }
            DeckCmd::LoopEnabled(on) => {
                let was = self.loop_on;
                self.loop_on = on;
                // Turning the loop off in slip mode returns to the ghost.
                if was && !on && self.slip {
                    self.pos = self.ghost;
                    self.reset_grains();
                }
            }
            DeckCmd::SyncTo(master) => {
                self.sync = master;
                // The snap is deferred until the master is actually
                // publishing (it may process after us in graph order, or
                // start playing later).
                self.snap_pending = self.sync.is_some();
            }
        }
    }

    fn track_rate(&self) -> Option<f64> {
        self.track.as_ref().map(|t| t.sample_rate as f64)
    }

    fn reset_grains(&mut self) {
        self.voice_off = [self.grain_len; 2];
        self.hop_phase = 0;
        self.next_voice = 0;
    }

    /// Master's position extrapolated to this deck's current engine frame.
    fn master_pos_now(&self, m: &DeckShared) -> f64 {
        let stamp = m.stamp.load(Ordering::Relaxed);
        let dt = (self.engine_frame as i64 - stamp as i64) as f64 / self.engine_rate;
        let rate = if m.playing() { m.rate() } else { 0.0 };
        m.position_secs() + dt * rate
    }

    /// One-shot beat-phase snap when sync engages (like pressing SYNC).
    /// Returns false while preconditions (master playing, both grids) are
    /// not met yet; the caller retries each block.
    fn snap_phase_to_master(&mut self) -> bool {
        let (Some(m), Some(sr)) = (self.sync.as_ref(), self.track_rate()) else {
            return false;
        };
        if !m.playing() {
            return false;
        }
        let m_bpm = m.grid_bpm();
        if m_bpm <= 0.0 || self.grid_bpm <= 0.0 {
            return false;
        }
        let m_beat = (self.master_pos_now(m) - m.grid_anchor()) * m_bpm / 60.0;
        let own_pos = self.pos / sr;
        let own_beat = (own_pos - self.grid_anchor) * self.grid_bpm / 60.0;
        let err = wrap_half(m_beat.fract() - own_beat.fract());
        self.pos += err * (60.0 / self.grid_bpm) * sr;
        self.ghost = self.pos;
        true
    }

    /// Per-block sync rate: tempo match to the master plus a small
    /// proportional phase correction. None = not synced / master silent.
    fn sync_rate(&self) -> Option<f64> {
        let m = self.sync.as_ref()?;
        let sr = self.track_rate()?;
        if !m.playing() || self.grid_bpm <= 0.0 {
            return None;
        }
        let m_bpm = m.grid_bpm();
        if m_bpm <= 0.0 {
            return None;
        }
        let base = (m_bpm * m.rate()) / self.grid_bpm;
        let m_beat = (self.master_pos_now(m) - m.grid_anchor()) * m_bpm / 60.0;
        let own_beat = (self.pos / sr - self.grid_anchor) * self.grid_bpm / 60.0;
        let err = wrap_half(m_beat - own_beat);
        Some(base * (1.0 + (err * SYNC_PHASE_GAIN).clamp(-SYNC_CORR_CLAMP, SYNC_CORR_CLAMP)))
    }

    #[inline]
    fn sample_at(chan: &[f32], pos: f64) -> f32 {
        if pos < 0.0 {
            return 0.0;
        }
        let i0 = pos as usize;
        if i0 >= chan.len() {
            return 0.0;
        }
        let frac = (pos - i0 as f64) as f32;
        if frac == 0.0 || i0 + 1 >= chan.len() {
            chan[i0]
        } else {
            chan[i0] * (1.0 - frac) + chan[i0 + 1] * frac
        }
    }

    /// Read the track at `pos` (frames) into (l, r).
    #[inline]
    fn read_track(track: &TrackData, pos: f64) -> (f32, f32) {
        let l = Self::sample_at(&track.channels[0], pos);
        let r = if track.channels.len() > 1 {
            Self::sample_at(&track.channels[1], pos)
        } else {
            l
        };
        (l, r)
    }
}

#[inline]
fn wrap_half(x: f64) -> f64 {
    let mut e = x % 1.0;
    if e > 0.5 {
        e -= 1.0;
    } else if e < -0.5 {
        e += 1.0;
    }
    e
}

impl HostModule for DeckModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        while let Ok(cmd) = self.cmd_rx.pop() {
            self.apply_cmd(cmd);
        }

        // Owed phase snap: engages on the first block where the master is
        // live (it may be processed after this deck, or start later).
        if self.snap_pending && self.snap_phase_to_master() {
            self.snap_pending = false;
        }

        // Sync rate is computed once per block (master state is stable
        // within a block: all decks run on the same RT thread).
        let sync_rate = self.sync_rate();

        let gate = &inputs[IN_PLAY_GATE];
        let speed = &inputs[IN_SPEED];
        let nudge = &inputs[IN_PHASE_NUDGE];
        let loop_toggle = &inputs[IN_LOOP_TOGGLE];

        let track_sr = self.track_rate().unwrap_or(self.engine_rate);
        let n_frames = self.track.as_ref().map(|t| t.frames()).unwrap_or(0);
        let sr_ratio = track_sr / self.engine_rate;
        let pulse_len = (CLOCK_PULSE_SECS * self.engine_rate) as u32;
        let loop_start_f = self.loop_start * track_sr;
        let loop_end_f = self.loop_end * track_sr;
        let has_loop = self.loop_end > self.loop_start;

        let mut last_rate = 0.0f64;

        for s in 0..frames {
            let gate_high = gate[s] >= 1.0;
            if gate_high && !self.prev_gate && self.ended {
                self.pos = 0.0;
                self.ghost = 0.0;
                self.ended = false;
                self.reset_grains();
            }
            self.prev_gate = gate_high;

            // Loop toggle rising edge.
            let lt_high = loop_toggle[s] >= 1.0;
            if lt_high && !self.prev_loop_toggle && has_loop {
                self.loop_on = !self.loop_on;
                if !self.loop_on && self.slip {
                    self.pos = self.ghost;
                    self.reset_grains();
                }
            }
            self.prev_loop_toggle = lt_high;

            // Hot cue triggers: rising edge jumps to the cue; falling edge
            // in slip mode returns to the ghost position.
            for c in 0..N_CUES {
                let high = inputs[IN_CUE_BASE + c][s] >= 1.0;
                if high && !self.prev_cue[c] && self.cues[c].is_finite() {
                    self.pos = (self.cues[c] * track_sr).max(0.0);
                    self.ended = false;
                    self.reset_grains();
                } else if !high && self.prev_cue[c] && self.slip && self.cues[c].is_finite() {
                    self.pos = self.ghost;
                    self.reset_grains();
                }
                self.prev_cue[c] = high;
            }

            let playing = gate_high && !self.ended && n_frames > 0;

            // Effective rate: sync overrides the pitch fader; nudge and
            // reverse apply on top.
            let mut rate = match sync_rate {
                Some(r) => r,
                None => 1.0 + (speed[s] as f64 / 10.0) * self.pitch_range,
            };
            rate *= 1.0 + (nudge[s] as f64 / 10.0) * NUDGE_DEPTH;
            if self.reverse {
                rate = -rate;
            }
            last_rate = rate;

            let (mut l, mut r) = (0.0f32, 0.0f32);
            let beat_pos_before = if self.grid_bpm > 0.0 {
                (self.pos / track_sr - self.grid_anchor) * self.grid_bpm / 60.0
            } else {
                f64::NAN
            };

            if playing {
                if self.keylock {
                    // Spawn a grain every hop output samples near the
                    // current virtual position, WSOLA-aligned to the
                    // running grain so joins stay phase-coherent.
                    if self.hop_phase == 0 {
                        let v = self.next_voice;
                        let other = 1 - v;
                        let dir = if rate < 0.0 { -1.0 } else { 1.0 };
                        let step = sr_ratio * dir;
                        let start = if self.voice_off[other] < self.grain_len {
                            let natural =
                                self.voice_start[other] + self.voice_off[other] as f64 * step;
                            self.align_grain_start(self.pos, natural, step)
                        } else {
                            self.pos
                        };
                        self.voice_start[v] = start;
                        self.voice_off[v] = 0;
                        self.next_voice = other;
                    }
                    self.hop_phase += 1;
                    if self.hop_phase >= self.hop {
                        self.hop_phase = 0;
                    }
                    let track = self.track.as_ref().unwrap();
                    let dir = if rate < 0.0 { -1.0 } else { 1.0 };
                    for v in 0..2 {
                        let off = self.voice_off[v];
                        if off < self.grain_len {
                            let read = self.voice_start[v] + off as f64 * sr_ratio * dir;
                            let w = self.window[off];
                            let (gl, gr) = Self::read_track(track, read);
                            l += gl * w;
                            r += gr * w;
                            self.voice_off[v] = off + 1;
                        }
                    }
                } else {
                    let track = self.track.as_ref().unwrap();
                    let (dl, dr) = Self::read_track(track, self.pos);
                    l = dl;
                    r = dr;
                }

                // Advance audible position (virtual position under keylock).
                self.pos += rate * sr_ratio;
                // Ghost advances identically but ignores loop wraps (and is
                // unaffected by cue jumps, handled above).
                if self.slip {
                    self.ghost += rate * sr_ratio;
                } else {
                    self.ghost = self.pos;
                }

                // Active loop wrap.
                if self.loop_on && has_loop {
                    if rate >= 0.0 && self.pos >= loop_end_f {
                        self.pos = loop_start_f + (self.pos - loop_end_f);
                        self.reset_grains();
                    } else if rate < 0.0 && self.pos < loop_start_f {
                        self.pos = loop_end_f - (loop_start_f - self.pos);
                        self.reset_grains();
                    }
                }

                if self.pos >= n_frames as f64 && rate >= 0.0 {
                    self.ended = true;
                } else if self.pos < 0.0 {
                    self.pos = 0.0;
                }
            }

            // Beat / bar clocks and phase from the beatgrid.
            let mut phase_out = 0.0f32;
            if self.grid_bpm > 0.0 {
                let beat_pos = (self.pos / track_sr - self.grid_anchor) * self.grid_bpm / 60.0;
                if playing && beat_pos_before.is_finite() {
                    // Fire on forward beat crossings only (loop wraps move
                    // backward; the beat re-fires when crossed again).
                    let b0 = beat_pos_before.floor();
                    let b1 = beat_pos.floor();
                    if b1 > b0 {
                        self.beat_pulse_left = pulse_len;
                    }
                    let bar0 = (beat_pos_before / BEATS_PER_BAR).floor();
                    let bar1 = (beat_pos / BEATS_PER_BAR).floor();
                    if bar1 > bar0 {
                        self.bar_pulse_left = pulse_len;
                    }
                }
                let bar_frac = (beat_pos / BEATS_PER_BAR).rem_euclid(1.0);
                phase_out = (bar_frac * SIGNAL_MAX as f64) as f32;
            }

            outputs[OUT_AUDIO_L][s] = l * SIGNAL_MAX;
            outputs[OUT_AUDIO_R][s] = r * SIGNAL_MAX;
            outputs[OUT_BEAT_CLOCK][s] = if self.beat_pulse_left > 0 {
                self.beat_pulse_left -= 1;
                SIGNAL_MAX
            } else {
                0.0
            };
            outputs[OUT_BAR_CLOCK][s] = if self.bar_pulse_left > 0 {
                self.bar_pulse_left -= 1;
                SIGNAL_MAX
            } else {
                0.0
            };
            outputs[OUT_PHASE][s] = phase_out;
            outputs[OUT_BPM][s] = if self.grid_bpm > 0.0 {
                ((self.grid_bpm * last_rate.abs()).max(1e-9) / BPM_REF).log2() as f32
            } else {
                0.0
            };
        }

        self.engine_frame += frames as u64;

        // Publish transport state for sync followers and the control thread.
        let sr = self.track_rate().unwrap_or(self.engine_rate);
        DeckShared::set(&self.shared.pos_secs, self.pos / sr);
        DeckShared::set(&self.shared.rate, last_rate);
        self.shared.playing.store(
            self.prev_gate && !self.ended && self.track.is_some(),
            Ordering::Relaxed,
        );
        DeckShared::set(&self.shared.grid_bpm, self.grid_bpm);
        DeckShared::set(&self.shared.grid_anchor, self.grid_anchor);
        DeckShared::set(
            &self.shared.duration,
            self.track
                .as_ref()
                .map(|t| t.duration_secs())
                .unwrap_or(0.0),
        );
        self.shared
            .stamp
            .store(self.engine_frame, Ordering::Relaxed);
    }

    fn on_param(&mut self, index: u32, value: f32) {
        match index {
            0 => self.pitch_range = value.clamp(0.0, 0.5) as f64,
            1 => self.keylock = value >= 0.5,
            2 => self.reverse = value >= 0.5,
            3 => {
                let was = self.slip;
                self.slip = value >= 0.5;
                if !was && self.slip {
                    self.ghost = self.pos;
                }
            }
            _ => {}
        }
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(17);
        bytes.extend_from_slice(&self.pos.to_le_bytes());
        bytes.extend_from_slice(&self.ghost.to_le_bytes());
        bytes.push(self.ended as u8);
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 17 {
            self.pos = f64::from_le_bytes(bytes[..8].try_into().unwrap());
            self.ghost = f64::from_le_bytes(bytes[8..16].try_into().unwrap());
            self.ended = bytes[16] != 0;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
