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
use crate::manifest::{categories, JackDecl, Manifest, OutputDecl, ParamDecl};
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
const OUT_STEM_BASE: usize = 6; // stem_vocals..stem_other = 6..=9

/// Stems per track (M3): vocals / drums / bass / other, in this order
/// everywhere (jacks, params, cached FLAC files).
pub const N_STEMS: usize = 4;
pub const STEM_IDS: [&str; N_STEMS] = ["vocals", "drums", "bass", "other"];
/// Param indices 4..=7 are the per-stem gains (see `deck_manifest`).
const PARAM_STEM_BASE: u32 = 4;

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
    let mut outputs = vec![
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
    ];
    // Stem output jacks (M3): independently routable, post-stem-gain.
    for stem in STEM_IDS {
        outputs.push(OutputDecl {
            id: format!("stem_{stem}"),
            name: format!("Stem {}{}", stem[..1].to_uppercase(), &stem[1..]),
        });
    }
    let mut params = vec![
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
    ];
    // Per-stem gains (M3): 0 = muted, 1 = full. When stems are loaded the
    // main audio outs are the gain-weighted stem sum, so muting a stem
    // removes it from the mix; the stem jacks are post-gain too.
    for stem in STEM_IDS {
        params.push(ParamDecl {
            id: format!("stem_{stem}"),
            name: format!("Stem {}{} Gain", stem[..1].to_uppercase(), &stem[1..]),
            param_type: "float".into(),
            default: serde_json::json!(1.0),
            min: Some(0.0),
            max: Some(1.0),
        });
    }
    Manifest {
        id: DECK_ID.into(),
        name: "DJ Deck".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        inputs,
        outputs,
        params,
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

/// Decoded stems for the loaded track (M3), [`STEM_IDS`] order. Same
/// sample rate as the track so the deck reads all five sources with one
/// position. Decoding happens on the control thread (`deck_load_stems`).
pub struct StemData {
    pub stems: [TrackData; N_STEMS],
}

/// Off-RT drop payloads: anything the RT thread replaces travels back to
/// the control thread on the garbage ring.
pub enum DeckGarbage {
    Track(Arc<TrackData>),
    Stems(Arc<StemData>),
}

/// Commands from the control thread, applied at block boundaries.
/// Fixed-size; `Arc` payloads only ever decrement refcounts on the RT side
/// (the control thread keeps its own clones alive).
pub enum DeckCmd {
    Load(Arc<TrackData>),
    /// Load (or clear, with `None`) the per-stem audio for the current
    /// track.
    LoadStems(Option<Arc<StemData>>),
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
    pub garbage_rx: rtrb::Consumer<DeckGarbage>,
    pub shared: Arc<DeckShared>,
    pub track: Option<Arc<TrackData>>,
    /// Stems currently loaded (control-side clone + source paths).
    pub stems: Option<(Arc<StemData>, [String; N_STEMS])>,
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
        garbage_rx: rtrb::Consumer<DeckGarbage>,
        shared: Arc<DeckShared>,
    ) -> Self {
        DeckControl {
            cmd_tx,
            garbage_rx,
            shared,
            track: None,
            stems: None,
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
    /// Stems loaded for the current track (M3): the main outs mix the
    /// gain-weighted stems and the stem jacks are live.
    pub stems_loaded: bool,
}

mod rt;
pub use rt::DeckModule;
