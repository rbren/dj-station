//! Built-in Decks module (`builtin.decks`): eight Beatify clips on ONE
//! clock, mixed down to a stereo pair — the engine behind the Decks tab.
//!
//! - Inputs: `bpm` (the bank's tempo; every slot is stretched to it) and
//!   `reset` (a rising edge parks the whole bank on beat 0).
//! - Outputs: `audio_l`, `audio_r`.
//! - Params: `surface` (does this bank listen to the Launch Control XL).
//!
//! ONE CLOCK, NO PER-SLOT TRANSPORT. The module owns a single fractional
//! beat counter that advances at the `bpm` input's tempo, and a slot's
//! playhead is DERIVED from it — `beat_pos - phase`, wrapped by the slot's
//! own length. That is what makes the bank phase-aligned by construction:
//! every clip's beat 0 lands on a beat of the same grid, so an 8-beat clip
//! and a 2-beat clip come round together and a 6-beat clip lands on the
//! even beats they share ([`align_beats`] is the gcd that names that
//! grid). Seven beats against eight share nothing but beat 0 of a 56-beat
//! cycle, and the status says so rather than pretending
//! ([`slots_align`] / [`DeckSlotStatus::aligned`]).
//!
//! A clip is played at the bank's tempo, not at its own: the playhead
//! moves at `bpm`, while [`crate::stretch`]'s grains read the audio at the
//! rate it was rendered at, so the pitch stays where the clip put it (the
//! deck's keylock and the Beat Clip module use the same machinery). What
//! one clip beat means is the slot's `source_bpm`, written by the loader
//! from the Beatify project the clip was cut in.
//!
//! Slots load MUTED and un-shifted: dropping a clip into a running bank
//! can never make a noise the user did not ask for, and the level, EQ and
//! solo they already set stay where they are.
//!
//! CONTROL STATE IS CANONICAL CONTROL-SIDE ([`DecksState`], persisted per
//! instance in the patch like [`crate::choreo::ChoreoState`]) and mirrors
//! to the RT thread over a lock-free SPSC ring; the audio behind a slot's
//! binding is re-assembled by the app layer, exactly like a Beat Clip's
//! (`decks_pending`). Both the panel and the Launch Control XL write that
//! same state — the surface is decoded with [`crate::launch_control`]'s
//! own device map, one column per slot (three knobs = high/mid/low, fader
//! = level, the two buttons = mute and solo), so what the tab draws and
//! what the hardware does can never be two different mappings.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use crate::beat_clip::BeatClipRef;
use crate::graph::SIGNAL_MAX;
use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::launch_control::{row, ROWS};
use crate::manifest::{categories, DisplaySpec, JackDecl, Manifest, OutputDecl, ParamDecl};
use crate::module_host::HostModule;
use crate::playback::TrackData;
use crate::stretch::{sample_at, GrainStretch};

pub const DECKS_ID: &str = "builtin.decks";

/// Slots in a bank — one per Launch Control XL column, deliberately.
pub const SLOTS: usize = 8;

/// Param naming whether this bank follows the Launch Control XL.
pub const SURFACE_PARAM: &str = "surface";

pub(crate) const IN_BPM: usize = 0;
pub(crate) const IN_RESET: usize = 1;

const OUT_AUDIO_L: usize = 0;
const OUT_AUDIO_R: usize = 1;

/// Tempo a fresh bank runs at.
pub const DEFAULT_BPM: f32 = 120.0;
pub const MIN_BPM: f32 = 20.0;
pub const MAX_BPM: f32 = 300.0;

/// Full-scale value of a tone control: 0 kills the band, 1 is flat, 2 is
/// +6 dB — so the surface's knob at 12 o'clock (5 V) is exactly flat.
pub const EQ_MAX: f32 = 2.0;

/// Band split of the three tone controls. First-order crossovers, and the
/// mid band is the REMAINDER of the other two, so flat is bit-exact
/// bypass rather than "nearly".
const EQ_LOW_HZ: f32 = 200.0;
const EQ_HIGH_HZ: f32 = 2000.0;

/// Level/mute/solo changes reach the audio over this long, so a mute is a
/// mute and not a click.
const GAIN_SMOOTH_SECS: f32 = 0.010;

/// Beats a bank's cycle is reported up to; beyond it the clips are not
/// meaningfully coming round together anyway.
pub const MAX_CYCLE_BEATS: u32 = 4096;

/// Extra silent beats a slot can carry, and how far a slot may be shifted
/// — both only bound the UI's arithmetic, not the music.
pub const MAX_TAIL_BEATS: u32 = 64;

pub fn gcd(a: u32, b: u32) -> u32 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    a
}

/// Beats after which two loops line up again, saturating at
/// [`MAX_CYCLE_BEATS`] (a 7-against-8 pair is 56; nothing useful lives
/// past a few thousand).
pub fn lcm(a: u32, b: u32) -> u32 {
    if a == 0 || b == 0 {
        return a.max(b);
    }
    (a as u64 / gcd(a, b) as u64 * b as u64).min(MAX_CYCLE_BEATS as u64) as u32
}

/// The beat grid one slot's starts land on, given every other loaded
/// slot: the gcd of their lengths. Eight beats beside two is 2 — the
/// short clip starts on every even beat, one of which is the long one's
/// downbeat; eight beside seven is 1, which is another way of saying
/// nothing is shared.
pub fn align_beats(len: u32, others: &[u32]) -> u32 {
    others.iter().fold(len, |acc, o| gcd(acc, *o))
}

/// Whether two loop lengths hold any phase relationship worth the name.
/// A one-beat loop starts on every beat, so it is aligned with anything;
/// otherwise the two must share a factor.
pub fn slots_align(a: u32, b: u32) -> bool {
    a.min(b) <= 1 || gcd(a, b) > 1
}

/// How often the whole bank comes round: the lcm of every loaded slot.
pub fn cycle_beats(lens: &[u32]) -> u32 {
    lens.iter()
        .filter(|l| **l > 0)
        .fold(0, |acc, l| lcm(acc, *l))
}

/// Clip length in beats at `bpm` — clips are cut in whole beats, so the
/// nearest one is the count.
pub fn beats_of(duration_secs: f64, bpm: f64) -> u32 {
    crate::beat_clip::beats_of(duration_secs, bpm) as u32
}

pub fn decks_manifest() -> Manifest {
    Manifest {
        id: DECKS_ID.into(),
        name: "Decks".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        inputs: vec![
            JackDecl {
                id: "bpm".into(),
                name: "Bank BPM".into(),
                default: DEFAULT_BPM,
                audio: false,
                knob: Some(KnobConfig {
                    style: KnobStyle::Continuous,
                    min: MIN_BPM,
                    max: MAX_BPM,
                    curve: Curve::Linear,
                    steps: None,
                }),
                display: Some(DisplaySpec {
                    unit: Some("BPM".into()),
                    ..DisplaySpec::default()
                }),
            },
            JackDecl {
                id: "reset".into(),
                name: "Reset".into(),
                default: 0.0,
                audio: false,
                knob: Some(KnobConfig {
                    style: KnobStyle::Button,
                    min: 0.0,
                    max: 10.0,
                    curve: Curve::Linear,
                    steps: None,
                }),
                display: None,
            },
        ],
        outputs: vec![
            OutputDecl {
                id: "audio_l".into(),
                name: "Audio L".into(),
                display: None,
            },
            OutputDecl {
                id: "audio_r".into(),
                name: "Audio R".into(),
                display: None,
            },
        ],
        params: vec![ParamDecl {
            id: SURFACE_PARAM.into(),
            name: "Follow Launch Control XL".into(),
            param_type: "toggle".into(),
            default: serde_json::json!(true),
            min: None,
            max: None,
        }],
        ui: None,
        latency_samples: 0,
    }
}

/// One slot's control state: what it plays, where it sits on the bank's
/// grid, and how it is mixed. Persisted in the patch (the AUDIO is not —
/// a Beatify clip is placements, re-assembled on load).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeckSlotState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<BeatClipRef>,
    /// Clip length in beats, at `source_bpm`.
    #[serde(default)]
    pub beats: u32,
    /// The tempo the clip's audio was rendered at (its project's).
    #[serde(default = "default_bpm")]
    pub source_bpm: f32,
    /// Extra beats of silence played after the clip, before it wraps.
    #[serde(default)]
    pub tail: u32,
    /// Whole-beat shift of this slot against the bank's grid.
    #[serde(default)]
    pub phase: i32,
    #[serde(default = "unity")]
    pub level: f32,
    #[serde(default = "unity")]
    pub low: f32,
    #[serde(default = "unity")]
    pub mid: f32,
    #[serde(default = "unity")]
    pub high: f32,
    /// Clips arrive muted: a load can never make an unasked-for noise.
    #[serde(default = "yes")]
    pub mute: bool,
    #[serde(default)]
    pub solo: bool,
}

fn default_bpm() -> f32 {
    DEFAULT_BPM
}
fn unity() -> f32 {
    1.0
}
fn yes() -> bool {
    true
}

impl Default for DeckSlotState {
    fn default() -> Self {
        DeckSlotState {
            clip: None,
            beats: 0,
            source_bpm: DEFAULT_BPM,
            tail: 0,
            phase: 0,
            level: 1.0,
            low: 1.0,
            mid: 1.0,
            high: 1.0,
            mute: true,
            solo: false,
        }
    }
}

impl DeckSlotState {
    /// The slot's loop length: the clip plus whatever silence was hung on
    /// the end of it (never zero — an empty slot has no length at all).
    pub fn length_beats(&self) -> u32 {
        if self.beats == 0 {
            0
        } else {
            self.beats + self.tail
        }
    }
}

/// A whole bank's control state, as the patch keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecksState {
    pub slots: Vec<DeckSlotState>,
}

impl Default for DecksState {
    fn default() -> Self {
        DecksState {
            slots: vec![DeckSlotState::default(); SLOTS],
        }
    }
}

impl DecksState {
    /// Always exactly [`SLOTS`] slots, whatever a saved patch (or a future
    /// bank size) hands over.
    pub fn normalized(mut self) -> Self {
        self.slots.truncate(SLOTS);
        self.slots.resize(SLOTS, DeckSlotState::default());
        self
    }

    /// Loop lengths of the loaded slots, for the alignment arithmetic.
    pub fn lengths(&self) -> Vec<u32> {
        self.slots
            .iter()
            .map(DeckSlotState::length_beats)
            .filter(|l| *l > 0)
            .collect()
    }
}

/// Which control of a slot an edit addresses. The same six controls the
/// Launch Control XL column carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlotControl {
    Level,
    High,
    Mid,
    Low,
    Mute,
    Solo,
}

impl SlotControl {
    /// The Launch Control XL row that drives this control: knobs top to
    /// bottom are high/mid/low (a mixer's EQ order), the fader is level,
    /// and the two buttons are mute and solo.
    pub fn from_surface_row(r: usize) -> Option<Self> {
        Some(match r {
            row::SEND_A => SlotControl::High,
            row::SEND_B => SlotControl::Mid,
            row::PAN => SlotControl::Low,
            row::FADER => SlotControl::Level,
            row::FOCUS => SlotControl::Mute,
            row::CONTROL => SlotControl::Solo,
            _ => return None,
        })
    }

    /// Is this a momentary button (toggles the state) rather than a
    /// continuous control (sets it)?
    pub fn is_button(self) -> bool {
        matches!(self, SlotControl::Mute | SlotControl::Solo)
    }

    /// What `volts` off the surface means for this control: 0..10 V spans
    /// a fader's 0..1 and a tone control's 0..[`EQ_MAX`].
    pub fn value_of_volts(self, volts: f32) -> f32 {
        let unit = (volts / 10.0).clamp(0.0, 1.0);
        match self {
            SlotControl::Level => unit,
            SlotControl::High | SlotControl::Mid | SlotControl::Low => unit * EQ_MAX,
            SlotControl::Mute | SlotControl::Solo => unit,
        }
    }
}

/// What the RT thread publishes for one slot each block.
#[derive(Debug, Default)]
pub struct SlotShared {
    pos_secs: AtomicU64,
    beat: AtomicI64,
    playing: AtomicBool,
}

/// The bank's transport, published once per block (f64s ride as bit
/// patterns, like [`crate::audio::AudioShared`]).
#[derive(Debug, Default)]
pub struct DecksShared {
    beat: AtomicU64,
    bpm: AtomicU64,
    slots: [SlotShared; SLOTS],
}

impl DecksShared {
    /// Fractional beats since the bank last reset.
    pub fn beat(&self) -> f64 {
        f64::from_bits(self.beat.load(Ordering::Relaxed))
    }
    pub fn bpm(&self) -> f64 {
        f64::from_bits(self.bpm.load(Ordering::Relaxed))
    }
    pub fn slot_position_secs(&self, slot: usize) -> f64 {
        f64::from_bits(self.slots[slot].pos_secs.load(Ordering::Relaxed))
    }
    /// Beat of its own clip the slot is on, or -1 when it is silent.
    pub fn slot_beat(&self, slot: usize) -> i64 {
        self.slots[slot].beat.load(Ordering::Relaxed)
    }
    pub fn slot_playing(&self, slot: usize) -> bool {
        self.slots[slot].playing.load(Ordering::Relaxed)
    }
}

/// Commands from the control thread, applied at a block boundary.
/// Fixed-size; `Arc` payloads only ever move (the control thread keeps its
/// own clone alive, and what the RT thread replaces leaves on the garbage
/// ring).
pub enum DecksCmd {
    Load {
        slot: u8,
        track: Option<Arc<TrackData>>,
        beats: u32,
        source_bpm: f32,
    },
    Mix {
        slot: u8,
        level: f32,
        low: f32,
        mid: f32,
        high: f32,
        mute: bool,
        solo: bool,
    },
    Timing {
        slot: u8,
        tail: u32,
        phase: i32,
    },
    /// Park the bank on beat 0.
    Reset,
}

/// Control-side state per Decks node: the command ring, the garbage
/// return, the canonical slot state, the audio each slot holds and the
/// surface decoder that dedups the controller's repeats.
pub struct DecksControl {
    pub tx: rtrb::Producer<DecksCmd>,
    pub garbage_rx: rtrb::Consumer<Arc<TrackData>>,
    pub shared: Arc<DecksShared>,
    pub state: DecksState,
    /// The audio in each slot's hands. `None` beside a bound clip is a
    /// slot the app layer still has to assemble (`decks_pending`).
    pub tracks: Vec<Option<Arc<TrackData>>>,
    pub surface: crate::launch_control::LaunchControlControl,
}

impl DecksControl {
    pub fn new(
        tx: rtrb::Producer<DecksCmd>,
        garbage_rx: rtrb::Consumer<Arc<TrackData>>,
        shared: Arc<DecksShared>,
    ) -> Self {
        DecksControl {
            tx,
            garbage_rx,
            shared,
            state: DecksState::default(),
            tracks: vec![None; SLOTS],
            surface: crate::launch_control::LaunchControlControl::default(),
        }
    }
}

/// One slot, as a UI sees it.
#[derive(Debug, Clone, Serialize)]
pub struct DeckSlotStatus {
    pub slot: usize,
    pub clip: Option<BeatClipRef>,
    /// Whether the audio behind the binding is actually in hand.
    pub loaded: bool,
    pub beats: u32,
    pub tail: u32,
    pub phase: i32,
    /// The tempo the clip was rendered at.
    pub source_bpm: f32,
    /// Bank tempo over source tempo: 1.0 plays the clip as rendered.
    pub stretch: f64,
    pub level: f32,
    pub low: f32,
    pub mid: f32,
    pub high: f32,
    pub mute: bool,
    pub solo: bool,
    /// The beat grid this slot's starts land on, against the rest of the
    /// bank (the gcd of the loop lengths).
    pub align_beats: u32,
    /// False when this clip shares no phase with something else loaded —
    /// seven beats against eight.
    pub aligned: bool,
    pub duration_secs: f64,
    pub position_secs: f64,
    /// Beat of its own clip the slot is playing, -1 when silent.
    pub beat: i64,
    pub playing: bool,
}

/// A bank, as a UI sees it.
#[derive(Debug, Clone, Serialize)]
pub struct DecksStatus {
    pub bpm: f64,
    /// Fractional beats since the bank last reset.
    pub beat: f64,
    /// Beats until every loaded slot comes round together.
    pub cycle_beats: u32,
    /// Whether this bank follows the Launch Control XL.
    pub surface: bool,
    /// Whether a surface is plugged in at all (engine-wide).
    pub surface_connected: bool,
    pub slots: Vec<DeckSlotStatus>,
}

/// A three-band tone control, one instance per channel. First-order
/// crossovers with the mid band taken as the remainder, so all three at
/// unity returns the input untouched.
#[derive(Debug, Default, Clone, Copy)]
struct BandSplit {
    lp_low: f32,
    lp_high: f32,
}

impl BandSplit {
    #[inline]
    fn process(&mut self, x: f32, a_low: f32, a_high: f32, low: f32, mid: f32, high: f32) -> f32 {
        self.lp_low += a_low * (x - self.lp_low);
        self.lp_high += a_high * (x - self.lp_high);
        let band_low = self.lp_low;
        let band_high = x - self.lp_high;
        let band_mid = self.lp_high - self.lp_low;
        band_low * low + band_mid * mid + band_high * high
    }
}

struct RtSlot {
    track: Option<Arc<TrackData>>,
    beats: u32,
    source_bpm: f32,
    tail: u32,
    phase: i32,
    level: f32,
    low: f32,
    mid: f32,
    high: f32,
    mute: bool,
    solo: bool,
    /// Smoothed level actually applied, so mute/solo/fader moves ramp.
    gain: f32,
    grains: GrainStretch,
    eq: [BandSplit; 2],
}

impl RtSlot {
    fn new(engine_rate: f32) -> Self {
        RtSlot {
            track: None,
            beats: 0,
            source_bpm: DEFAULT_BPM,
            tail: 0,
            phase: 0,
            level: 1.0,
            low: 1.0,
            mid: 1.0,
            high: 1.0,
            mute: true,
            solo: false,
            gain: 0.0,
            grains: GrainStretch::new(engine_rate),
            eq: [BandSplit::default(); 2],
        }
    }

    fn length_beats(&self) -> u32 {
        if self.beats == 0 {
            0
        } else {
            self.beats + self.tail
        }
    }
}

/// The RT-side bank. Never allocates or blocks: clips and control changes
/// arrive over an SPSC ring and replaced clips leave on the garbage ring.
pub struct DecksRtModule {
    rx: rtrb::Consumer<DecksCmd>,
    garbage_tx: rtrb::Producer<Arc<TrackData>>,
    slots: Vec<RtSlot>,
    engine_rate: f32,
    /// Fractional beats since the last reset — the bank's whole transport.
    beat_pos: f64,
    last_reset: f32,
    /// One-pole coefficients of the tone-control crossovers and of the
    /// gain smoother, all fixed at construction.
    a_low: f32,
    a_high: f32,
    a_gain: f32,
    shared: Arc<DecksShared>,
}

/// One-pole lowpass coefficient for a cutoff in Hz.
fn one_pole(hz: f32, rate: f32) -> f32 {
    (1.0 - (-2.0 * std::f32::consts::PI * hz / rate).exp()).clamp(0.0, 1.0)
}

impl DecksRtModule {
    pub fn new(
        rx: rtrb::Consumer<DecksCmd>,
        garbage_tx: rtrb::Producer<Arc<TrackData>>,
        engine_rate: f32,
        shared: Arc<DecksShared>,
    ) -> Self {
        let rate = engine_rate.max(1.0);
        DecksRtModule {
            rx,
            garbage_tx,
            slots: (0..SLOTS).map(|_| RtSlot::new(rate)).collect(),
            engine_rate: rate,
            beat_pos: 0.0,
            last_reset: 0.0,
            a_low: one_pole(EQ_LOW_HZ, rate),
            a_high: one_pole(EQ_HIGH_HZ, rate),
            a_gain: 1.0 - (-1.0 / (GAIN_SMOOTH_SECS * rate)).exp(),
            shared,
        }
    }

    fn apply(&mut self, cmd: DecksCmd) {
        match cmd {
            DecksCmd::Load {
                slot,
                track,
                beats,
                source_bpm,
            } => {
                let Some(s) = self.slots.get_mut(slot as usize) else {
                    return;
                };
                let old = std::mem::replace(&mut s.track, track);
                if let Some(old) = old {
                    let _ = self.garbage_tx.push(old);
                }
                s.beats = beats;
                s.source_bpm = source_bpm.max(1.0);
                // A new clip is a new timeline: no grain may cross into it.
                s.grains.reset();
                s.eq = [BandSplit::default(); 2];
            }
            DecksCmd::Mix {
                slot,
                level,
                low,
                mid,
                high,
                mute,
                solo,
            } => {
                let Some(s) = self.slots.get_mut(slot as usize) else {
                    return;
                };
                s.level = level;
                s.low = low;
                s.mid = mid;
                s.high = high;
                s.mute = mute;
                s.solo = solo;
            }
            DecksCmd::Timing { slot, tail, phase } => {
                let Some(s) = self.slots.get_mut(slot as usize) else {
                    return;
                };
                s.tail = tail;
                s.phase = phase;
            }
            DecksCmd::Reset => {
                self.beat_pos = 0.0;
                for slot in &mut self.slots {
                    slot.grains.reset();
                }
            }
        }
    }
}

impl HostModule for DecksRtModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        while let Ok(cmd) = self.rx.pop() {
            self.apply(cmd);
        }

        // Solo is a property of the bank, so it is decided once per block
        // rather than per slot per sample.
        let any_solo = self
            .slots
            .iter()
            .any(|s| s.solo && s.track.is_some() && s.beats > 0);

        let bpm = &inputs[IN_BPM];
        let reset = &inputs[IN_RESET];
        let (a_low, a_high, a_gain) = (self.a_low, self.a_high, self.a_gain);
        for s in 0..frames {
            if reset[s] >= 1.0 && self.last_reset < 1.0 {
                self.beat_pos = 0.0;
                for slot in &mut self.slots {
                    slot.grains.reset();
                }
            }
            self.last_reset = reset[s];

            let tempo = bpm[s].clamp(MIN_BPM, MAX_BPM) as f64;
            let (mut mix_l, mut mix_r) = (0.0f32, 0.0f32);
            for slot in &mut self.slots {
                let target = if slot.mute || (any_solo && !slot.solo) {
                    0.0
                } else {
                    slot.level.max(0.0)
                };
                slot.gain += a_gain * (target - slot.gain);

                let Some(track) = &slot.track else { continue };
                let len = slot.length_beats();
                if len == 0 {
                    continue;
                }
                let beat_frames = 60.0 / slot.source_bpm as f64 * track.sample_rate as f64;
                let local = (self.beat_pos - slot.phase as f64).rem_euclid(len as f64);
                let pos = local * beat_frames;
                // The tail is silence: past the clip's own beats there is
                // nothing to read, but the slot keeps counting.
                if local >= slot.beats as f64 || pos >= track.frames() as f64 {
                    continue;
                }
                // Grains read at the clip's own rate while the playhead
                // moves at the bank's — that split is the whole stretch.
                let step = track.sample_rate as f64 / self.engine_rate as f64;
                let taps = slot.grains.tick(pos, step, &track.channels[0]);
                let (mut l, mut r) = (0.0f32, 0.0f32);
                for tap in taps.iter().flatten() {
                    let gl = sample_at(&track.channels[0], tap.pos);
                    let gr = if track.channels.len() > 1 {
                        sample_at(&track.channels[1], tap.pos)
                    } else {
                        gl
                    };
                    l += gl * tap.gain;
                    r += gr * tap.gain;
                }
                let l = slot.eq[0].process(l, a_low, a_high, slot.low, slot.mid, slot.high);
                let r = slot.eq[1].process(r, a_low, a_high, slot.low, slot.mid, slot.high);
                mix_l += l * slot.gain;
                mix_r += r * slot.gain;
            }
            outputs[OUT_AUDIO_L][s] = mix_l * SIGNAL_MAX;
            outputs[OUT_AUDIO_R][s] = mix_r * SIGNAL_MAX;
            self.beat_pos += tempo / 60.0 / self.engine_rate as f64;
        }

        self.shared
            .beat
            .store(self.beat_pos.to_bits(), Ordering::Relaxed);
        let tempo = bpm[frames.saturating_sub(1)].clamp(MIN_BPM, MAX_BPM) as f64;
        self.shared.bpm.store(tempo.to_bits(), Ordering::Relaxed);
        for (i, slot) in self.slots.iter().enumerate() {
            let pub_slot = &self.shared.slots[i];
            let len = slot.length_beats();
            let (pos_secs, beat, playing) = match (&slot.track, len) {
                (Some(track), len) if len > 0 => {
                    let local = (self.beat_pos - slot.phase as f64).rem_euclid(len as f64);
                    let sounding = local < slot.beats as f64;
                    (
                        local * 60.0 / slot.source_bpm as f64,
                        if sounding { local as i64 } else { -1 },
                        sounding && slot.gain > 1e-4 && track.frames() > 0,
                    )
                }
                _ => (0.0, -1, false),
            };
            pub_slot
                .pos_secs
                .store(pos_secs.to_bits(), Ordering::Relaxed);
            pub_slot.beat.store(beat, Ordering::Relaxed);
            pub_slot.playing.store(playing, Ordering::Relaxed);
        }
    }

    /// The bank's phase across a hot reload — where the clock is. Every
    /// slot's playhead is derived from it, and the clips themselves come
    /// back from the control thread.
    fn save_state(&mut self) -> Vec<u8> {
        self.beat_pos.to_le_bytes().to_vec()
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 8 {
            self.beat_pos = f64::from_le_bytes(bytes[..8].try_into().unwrap());
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Slot a Launch Control XL jack belongs to, and what it drives there.
/// The surface's columns ARE the bank's slots.
pub fn surface_target(jack: usize) -> Option<(usize, SlotControl)> {
    let slot = jack / ROWS;
    if slot >= SLOTS {
        return None;
    }
    SlotControl::from_surface_row(jack % ROWS).map(|c| (slot, c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch_control::{decode, jack_index};

    #[test]
    fn manifest_is_one_clock_and_one_stereo_pair() {
        let m = decks_manifest();
        assert_eq!(m.id, DECKS_ID);
        let ins: Vec<&str> = m.inputs.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ins, ["bpm", "reset"]);
        let outs: Vec<&str> = m.outputs.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(outs, ["audio_l", "audio_r"]);
        // Following the surface is a mode toggle, so it is a param and
        // rides in the patch (params-vs-inputs rule).
        assert_eq!(m.params.len(), 1);
        assert_eq!(m.params[0].id, SURFACE_PARAM);
        assert_eq!(m.params[0].default_f32(), 1.0);
        assert_eq!(m.inputs[IN_BPM].default, DEFAULT_BPM);
    }

    #[test]
    fn a_fresh_slot_is_muted_flat_and_empty() {
        let s = DeckSlotState::default();
        assert!(s.mute, "a slot must never arrive making noise");
        assert_eq!((s.level, s.low, s.mid, s.high), (1.0, 1.0, 1.0, 1.0));
        assert_eq!(s.length_beats(), 0, "nothing loaded has no length");
        assert_eq!(DecksState::default().slots.len(), SLOTS);
    }

    #[test]
    fn alignment_is_the_gcd_of_the_loop_lengths() {
        // The ticket's cases: 2 against 8 starts with it, 6 against 8
        // lands on the even beats they share, 7 shares nothing.
        assert_eq!(align_beats(2, &[8]), 2);
        assert_eq!(align_beats(6, &[8]), 2);
        assert_eq!(align_beats(7, &[8]), 1);
        assert_eq!(align_beats(4, &[8, 12]), 4);
        // A slot with nothing else loaded is its own grid.
        assert_eq!(align_beats(6, &[]), 6);

        assert!(slots_align(2, 8));
        assert!(slots_align(6, 8));
        assert!(!slots_align(7, 8));
        // A one-beat loop starts on every beat, so it fits anything.
        assert!(slots_align(1, 7));
    }

    #[test]
    fn the_cycle_is_when_everything_comes_round_together() {
        assert_eq!(cycle_beats(&[8, 2]), 8);
        assert_eq!(cycle_beats(&[8, 6]), 24);
        assert_eq!(cycle_beats(&[8, 7]), 56);
        assert_eq!(cycle_beats(&[]), 0);
        // Nothing musical lives past the cap, and it must not overflow.
        assert_eq!(cycle_beats(&[4096, 4095]), MAX_CYCLE_BEATS);
    }

    #[test]
    fn a_surface_column_is_a_slot_and_its_rows_are_its_controls() {
        // Column 1's three knobs, top to bottom, are high/mid/low.
        assert_eq!(
            surface_target(jack_index(0, row::SEND_A)),
            Some((0, SlotControl::High))
        );
        assert_eq!(
            surface_target(jack_index(0, row::SEND_B)),
            Some((0, SlotControl::Mid))
        );
        assert_eq!(
            surface_target(jack_index(0, row::PAN)),
            Some((0, SlotControl::Low))
        );
        assert_eq!(
            surface_target(jack_index(7, row::FADER)),
            Some((7, SlotControl::Level))
        );
        assert_eq!(
            surface_target(jack_index(3, row::FOCUS)),
            Some((3, SlotControl::Mute))
        );
        assert_eq!(
            surface_target(jack_index(3, row::CONTROL)),
            Some((3, SlotControl::Solo))
        );
        // And the device map is the Launch Control's own: fader 3 is CC 79.
        let (jack, volts) = decode([0xB8, 79, 127]).unwrap();
        assert_eq!(surface_target(jack), Some((2, SlotControl::Level)));
        assert_eq!(SlotControl::Level.value_of_volts(volts), 1.0);
        // A knob at 12 o'clock is flat.
        assert_eq!(SlotControl::Mid.value_of_volts(5.0), 1.0);
        assert_eq!(SlotControl::High.value_of_volts(10.0), EQ_MAX);
        assert!(SlotControl::Mute.is_button() && !SlotControl::Level.is_button());
    }

    /// Render `frames` of a bank whose slots are set up by `setup`.
    fn render(
        setup: impl FnOnce(&mut rtrb::Producer<DecksCmd>),
        frames: usize,
        bpm: f32,
    ) -> (Vec<f32>, Arc<DecksShared>) {
        let (mut tx, rx) = rtrb::RingBuffer::new(64);
        let (garbage_tx, _garbage_rx) = rtrb::RingBuffer::new(64);
        let shared = Arc::new(DecksShared::default());
        let mut m = DecksRtModule::new(rx, garbage_tx, 48_000.0, shared.clone());
        setup(&mut tx);
        let inputs = vec![vec![bpm; frames], vec![0.0; frames]];
        let mut outputs = vec![vec![0.0; frames]; 2];
        m.process(&inputs, &mut outputs, 0, frames);
        (outputs.remove(0), shared)
    }

    /// A one-beat clip at 120 BPM: a constant, so the level it comes out
    /// at is readable straight off the samples.
    fn flat_clip(value: f32, beats: usize) -> Arc<TrackData> {
        Arc::new(TrackData {
            channels: vec![vec![value; 24_000 * beats]],
            sample_rate: 48_000.0,
        })
    }

    fn load(tx: &mut rtrb::Producer<DecksCmd>, slot: u8, beats: u32, value: f32) {
        tx.push(DecksCmd::Load {
            slot,
            track: Some(flat_clip(value, beats as usize)),
            beats,
            source_bpm: 120.0,
        })
        .unwrap();
    }

    fn mix(tx: &mut rtrb::Producer<DecksCmd>, slot: u8, level: f32, mute: bool, solo: bool) {
        tx.push(DecksCmd::Mix {
            slot,
            level,
            low: 1.0,
            mid: 1.0,
            high: 1.0,
            mute,
            solo,
        })
        .unwrap();
    }

    #[test]
    fn a_loaded_slot_is_silent_until_it_is_unmuted() {
        let (out, _) = render(
            |tx| {
                load(tx, 0, 2, 0.5);
                mix(tx, 0, 1.0, true, false);
            },
            4800,
            120.0,
        );
        assert!(
            out.iter().all(|s| s.abs() < 1e-6),
            "a muted slot must be silent"
        );

        let (out, _) = render(
            |tx| {
                load(tx, 0, 2, 0.5);
                mix(tx, 0, 1.0, false, false);
            },
            4800,
            120.0,
        );
        // The gain ramp is 10 ms, so read well past it.
        let tail = &out[out.len() - 100..];
        assert!(
            tail.iter().all(|s| (*s - 0.5 * SIGNAL_MAX).abs() < 0.05),
            "an unmuted slot plays its clip at unity: {:?}",
            &tail[..4]
        );
    }

    #[test]
    fn mute_and_solo_ramp_rather_than_click() {
        let (out, _) = render(
            |tx| {
                load(tx, 0, 2, 0.5);
                mix(tx, 0, 1.0, false, false);
            },
            4800,
            120.0,
        );
        let jump = out
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(
            jump < 0.2,
            "unmuting must ramp, not step (biggest jump {jump})"
        );
    }

    #[test]
    fn solo_anywhere_silences_every_slot_that_is_not_soloed() {
        let (out, shared) = render(
            |tx| {
                load(tx, 0, 2, 0.5);
                mix(tx, 0, 1.0, false, false);
                load(tx, 1, 2, 0.25);
                mix(tx, 1, 1.0, false, true);
            },
            4800,
            120.0,
        );
        let tail = &out[out.len() - 100..];
        assert!(
            tail.iter().all(|s| (*s - 0.25 * SIGNAL_MAX).abs() < 0.05),
            "only the soloed slot is heard"
        );
        assert!(!shared.slot_playing(0), "slot 1 is soloed out");
        assert!(shared.slot_playing(1));
    }

    #[test]
    fn the_tail_is_silence_the_slot_keeps_counting_through() {
        // One beat of audio plus one beat of tail, at 120 BPM: half a
        // second on, half a second off.
        let (out, _) = render(
            |tx| {
                load(tx, 0, 1, 0.5);
                mix(tx, 0, 1.0, false, false);
                tx.push(DecksCmd::Timing {
                    slot: 0,
                    tail: 1,
                    phase: 0,
                })
                .unwrap();
            },
            48_000,
            120.0,
        );
        assert!(out[23_000].abs() > 0.1, "the clip's own beat sounds");
        assert!(
            out[30_000..47_000].iter().all(|s| s.abs() < 1e-6),
            "the tail is silence"
        );
    }

    #[test]
    fn a_phase_shift_moves_the_slot_a_whole_beat_on_the_banks_grid() {
        // Two beats of clip, shifted by one: at beat 0 of the bank the
        // slot is on ITS beat 1.
        let (_, shared) = render(
            |tx| {
                load(tx, 0, 2, 0.5);
                mix(tx, 0, 1.0, false, false);
                tx.push(DecksCmd::Timing {
                    slot: 0,
                    tail: 0,
                    phase: 1,
                })
                .unwrap();
            },
            128,
            120.0,
        );
        assert_eq!(shared.slot_beat(0), 1);
    }

    #[test]
    fn slots_share_one_clock_so_a_short_clip_lands_on_the_long_ones_grid() {
        // 8 beats beside 2, a beat and a half in: the long clip is on its
        // beat 1 and the short one on its beat 1 as well — the same beat
        // of the same grid.
        let frames = 24_000 + 12_000; // 1.5 beats at 120 BPM
        let (_, shared) = render(
            |tx| {
                load(tx, 0, 8, 0.5);
                mix(tx, 0, 1.0, false, false);
                load(tx, 1, 2, 0.5);
                mix(tx, 1, 1.0, false, false);
            },
            frames,
            120.0,
        );
        assert_eq!(shared.slot_beat(0), 1);
        assert_eq!(shared.slot_beat(1), 1);
        assert!((shared.beat() - 1.5).abs() < 1e-6);
    }

    #[test]
    fn the_bank_tempo_stretches_a_clip_without_moving_its_grid() {
        // At 240 BPM a two-beat clip is over in half a second, so a
        // second of render is exactly two passes: beat 0 comes round at
        // 0.5 s.
        let (_, shared) = render(
            |tx| {
                load(tx, 0, 2, 0.5);
                mix(tx, 0, 1.0, false, false);
            },
            24_000,
            240.0,
        );
        assert!(
            (shared.beat() - 2.0).abs() < 1e-6,
            "half a second at 240 BPM is two beats, got {}",
            shared.beat()
        );
        assert_eq!(shared.slot_beat(0), 0, "and the clip is back at its start");
    }

    #[test]
    fn flat_tone_controls_are_bypass_and_a_killed_band_is_gone() {
        let mut split = BandSplit::default();
        let (a_low, a_high) = (
            one_pole(EQ_LOW_HZ, 48_000.0),
            one_pole(EQ_HIGH_HZ, 48_000.0),
        );
        for i in 0..2000 {
            let x = (i as f32 / 7.0).sin() * 0.5;
            let y = split.process(x, a_low, a_high, 1.0, 1.0, 1.0);
            assert!((y - x).abs() < 1e-6, "flat must be bypass");
        }
        // Kill the lows and a DC-ish input dies with them.
        let mut split = BandSplit::default();
        let mut last = 0.0;
        for _ in 0..48_000 {
            last = split.process(0.5, a_low, a_high, 0.0, 1.0, 1.0);
        }
        assert!(last.abs() < 1e-3, "killing the low band kills DC: {last}");
    }

    #[test]
    fn a_reset_parks_the_whole_bank_on_beat_zero() {
        let (mut tx, rx) = rtrb::RingBuffer::new(64);
        let (garbage_tx, _g) = rtrb::RingBuffer::new(64);
        let shared = Arc::new(DecksShared::default());
        let mut m = DecksRtModule::new(rx, garbage_tx, 48_000.0, shared.clone());
        load(&mut tx, 0, 2, 0.5);
        mix(&mut tx, 0, 1.0, false, false);
        let frames = 12_000;
        let mut outputs = vec![vec![0.0; frames]; 2];
        m.process(
            &[vec![120.0; frames], vec![0.0; frames]],
            &mut outputs,
            0,
            frames,
        );
        assert!(shared.beat() > 0.4);
        m.process(
            &[vec![120.0; frames], vec![10.0; frames]],
            &mut outputs,
            0,
            frames,
        );
        assert!(
            (shared.beat() - 0.5).abs() < 1e-6,
            "the reset restarts the count, got {}",
            shared.beat()
        );
    }
}
