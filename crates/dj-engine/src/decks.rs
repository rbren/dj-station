//! Built-in Decks module (`builtin.decks`): eight Beatify clips on ONE
//! clock, mixed down to a stereo pair — the engine behind the Decks tab.
//!
//! - Inputs: `bpm` (the bank's tempo; every slot is stretched to it),
//!   `reset` (a rising edge parks the whole bank on beat 0) and a RETURN
//!   pair per deck (`d1_in_l`…`d8_in_r`).
//! - Outputs: `audio_l`/`audio_r` (the live mix), `mon_l`/`mon_r` (the
//!   decks switched to Monitor), `clock` (one pulse per bank beat), and
//!   per deck a SEND pair (`d1_l`/`d1_r`) plus its three tone controls as
//!   CV (`d1_high`/`d1_mid`/`d1_low`).
//! - Params: `surface` (does this bank listen to the Launch Control XL).
//!
//! THE RACK IS THE BANK'S EFFECTS LOOP. A deck's send always carries its
//! audio; wiring anything back into that deck's return makes the modules
//! in between its INSERT — the deck's own path stops reaching the mix, so
//! nothing is heard twice — and the fader, mute and monitor switch still
//! belong to the deck. The three tone controls work the same way round:
//! their CV outputs always carry the knob positions, and patching one
//! takes that band OFF the deck's audio (it sits flat) because a knob
//! doing two jobs is a knob you cannot read.
//!
//! MONITOR IS A CUE, NOT A SOLO: a deck switched to it leaves the live
//! pair and comes out of the monitor pair instead, and every other deck
//! carries on exactly as it was. The app sends the two pairs to two
//! chosen output devices. Each pair has a MASTER fader of its own
//! ([`MasterBus`], patch state like the slot mix): the level of everything
//! going to the room, and the level of everything going to the
//! headphones, with no way for one to move the other.
//!
//! ONE CLOCK, NO PER-SLOT TRANSPORT. The module owns a single fractional
//! beat counter that advances at the `bpm` input's tempo, and a slot's
//! playhead is DERIVED from it — `beat_pos - phase`, wrapped by the slot's
//! own length. That is what makes the bank phase-aligned by construction:
//! every clip's beat 0 lands on a beat of the same grid, so an 8-beat clip
//! and a 2-beat clip come round together and a 6-beat clip lands on the
//! even beats they share. [`cycle_beats`] is how long the whole bank takes
//! to come round — the one thing about that arithmetic the tab still says
//! out loud.
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
//! monitor switch they already set stay where they are.
//!
//! QUEUE AND DROP ARE THE MUTE, ON THE GRID ([`DeckArm`]). A queue unmutes
//! the deck THEN AND THERE and the RT thread holds it silent until the
//! clip's own FIRST beat next comes round (its loop seam), so a queued
//! clip always enters from its top; a drop mutes it and the RT thread
//! holds it up until the clip has played its last beat. So the control
//! side never has to be told what happened — the state a patch keeps is
//! already the state the arm is on its way to — and the only thing
//! living on the audio thread
//! is the TIMING, which is the one thing the audio thread can get right.
//! An arm is transport, not patch state: nothing serializes it, a load
//! clears it, and a bank restored from a patch comes back unarmed.
//!
//! CONTROL STATE IS CANONICAL CONTROL-SIDE ([`DecksState`], persisted per
//! instance in the patch like [`crate::choreo::ChoreoState`]) and mirrors
//! to the RT thread over a lock-free SPSC ring; the audio behind a slot's
//! binding is re-assembled by the app layer, exactly like a Beat Clip's
//! (`decks_pending`). Both the panel and the Launch Control XL write that
//! same state — the surface is decoded with [`crate::launch_control`]'s
//! own device map, one column per slot (three knobs = high/mid/low, fader
//! = level, the two buttons = mute and monitor), so what the tab draws and
//! what the hardware does can never be two different mappings — and the
//! bank lights the surface's buttons back ([`led_for`]), so the controller
//! shows the same state the strip does.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicU8, Ordering};
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
/// First per-slot RETURN jack. Two (L/R) per slot: wire a deck's send
/// through the rack and back in here and the modules become that deck's
/// insert — what comes back is what the bank mixes.
pub(crate) const IN_RETURN_BASE: usize = 2;
pub const N_INPUTS: usize = IN_RETURN_BASE + SLOTS * 2;

const OUT_AUDIO_L: usize = 0;
const OUT_AUDIO_R: usize = 1;
/// The monitor pair: a slot switched to Monitor leaves the live mix and
/// comes out here instead (the app sends this pair to the monitor device).
const OUT_MON_L: usize = 2;
const OUT_MON_R: usize = 3;
/// One pulse per beat of the bank's own clock, for the rack.
const OUT_CLOCK: usize = 4;
/// First per-slot output. Five each: the send pair, then the three tone
/// controls as CV.
pub(crate) const OUT_SLOT_BASE: usize = 5;
pub(crate) const OUT_PER_SLOT: usize = 5;
pub const N_OUTPUTS: usize = OUT_SLOT_BASE + SLOTS * OUT_PER_SLOT;

/// Tone controls, in the order their CV outputs (and the surface's three
/// knob rows) sit: high, mid, low.
pub const TONES: [SlotControl; 3] = [SlotControl::High, SlotControl::Mid, SlotControl::Low];

/// A slot's return jack (`ch` 0 = L, 1 = R).
pub fn return_jack(slot: usize, ch: usize) -> usize {
    IN_RETURN_BASE + slot * 2 + ch
}

/// A slot's send jack (`ch` 0 = L, 1 = R).
pub fn send_jack(slot: usize, ch: usize) -> usize {
    OUT_SLOT_BASE + slot * OUT_PER_SLOT + ch
}

/// A slot's tone-control CV output (`tone` indexes [`TONES`]).
pub fn tone_jack(slot: usize, tone: usize) -> usize {
    OUT_SLOT_BASE + slot * OUT_PER_SLOT + 2 + tone
}

/// How long the clock output's pulse is held, in seconds (~1 ms, the
/// width the built-in MIDI clock uses).
const CLOCK_PULSE_SECS: f32 = 0.001;

/// An off from a surface button this soon after its own on is a FINGER
/// COMING OFF a momentary button, not a second press (see
/// [`crate::Engine::decks_feed`]).
pub const MOMENTARY_RELEASE_SECS: f64 = 0.25;

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
        deprecated: false,
        inputs: vec![
            JackDecl {
                id: "bpm".into(),
                name: "Bank BPM".into(),
                default: DEFAULT_BPM,
                audio: false,
                capture: false,
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
                capture: false,
                knob: Some(KnobConfig {
                    style: KnobStyle::Button,
                    min: 0.0,
                    max: 10.0,
                    curve: Curve::Linear,
                    steps: None,
                }),
                display: None,
            },
        ]
        .into_iter()
        // A deck's RETURN: the far end of its insert. Plain wire jacks
        // (no knob) — this is audio coming back, not a control.
        .chain((0..SLOTS).flat_map(|slot| {
            [("l", "L"), ("r", "R")].map(|(side, name)| JackDecl {
                id: format!("d{}_in_{side}", slot + 1),
                name: format!("Deck {} Return {name}", slot + 1),
                default: 0.0,
                audio: true,
                capture: false,
                knob: None,
                display: None,
            })
        }))
        .collect(),
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
            OutputDecl {
                id: "mon_l".into(),
                name: "Monitor L".into(),
                display: None,
            },
            OutputDecl {
                id: "mon_r".into(),
                name: "Monitor R".into(),
                display: None,
            },
            OutputDecl {
                id: "clock".into(),
                name: "Clock".into(),
                display: None,
            },
        ]
        .into_iter()
        .chain((0..SLOTS).flat_map(|slot| {
            let n = slot + 1;
            [
                OutputDecl {
                    id: format!("d{n}_l"),
                    name: format!("Deck {n} Send L"),
                    display: None,
                },
                OutputDecl {
                    id: format!("d{n}_r"),
                    name: format!("Deck {n} Send R"),
                    display: None,
                },
                OutputDecl {
                    id: format!("d{n}_high"),
                    name: format!("Deck {n} High CV"),
                    display: None,
                },
                OutputDecl {
                    id: format!("d{n}_mid"),
                    name: format!("Deck {n} Mid CV"),
                    display: None,
                },
                OutputDecl {
                    id: format!("d{n}_low"),
                    name: format!("Deck {n} Low CV"),
                    display: None,
                },
            ]
        }))
        .collect(),
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
        bypass: Default::default(),
        presets: Default::default(),
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
    /// Monitor (cue): this deck leaves the live mix and comes out of the
    /// bank's monitor pair instead. `solo` is the name it was saved under
    /// before it meant this.
    #[serde(default, alias = "solo")]
    pub monitor: bool,
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
            monitor: false,
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
    /// The two OUTPUT faders: everything on the live pair, and everything
    /// on the cue pair, after the slots have been mixed. 1 is unity.
    #[serde(default = "unity")]
    pub master_live: f32,
    #[serde(default = "unity")]
    pub master_monitor: f32,
}

impl Default for DecksState {
    fn default() -> Self {
        DecksState {
            slots: vec![DeckSlotState::default(); SLOTS],
            master_live: 1.0,
            master_monitor: 1.0,
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

    /// The fader on one of the bank's two output pairs.
    pub fn master(&self, bus: MasterBus) -> f32 {
        match bus {
            MasterBus::Live => self.master_live,
            MasterBus::Monitor => self.master_monitor,
        }
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
    Monitor,
}

impl SlotControl {
    /// The Launch Control XL row that drives this control: knobs top to
    /// bottom are high/mid/low (a mixer's EQ order), the fader is level,
    /// and the two buttons are mute and monitor.
    pub fn from_surface_row(r: usize) -> Option<Self> {
        Some(match r {
            row::SEND_A => SlotControl::High,
            row::SEND_B => SlotControl::Mid,
            row::PAN => SlotControl::Low,
            row::FADER => SlotControl::Level,
            row::FOCUS => SlotControl::Mute,
            row::CONTROL => SlotControl::Monitor,
            _ => return None,
        })
    }

    /// Is this a momentary button (toggles the state) rather than a
    /// continuous control (sets it)?
    pub fn is_button(self) -> bool {
        matches!(self, SlotControl::Mute | SlotControl::Monitor)
    }

    /// What `volts` off the surface means for this control: 0..10 V spans
    /// a fader's 0..1 and a tone control's 0..[`EQ_MAX`].
    pub fn value_of_volts(self, volts: f32) -> f32 {
        let unit = (volts / 10.0).clamp(0.0, 1.0);
        match self {
            SlotControl::Level => unit,
            SlotControl::High | SlotControl::Mid | SlotControl::Low => unit * EQ_MAX,
            SlotControl::Mute | SlotControl::Monitor => unit,
        }
    }
}

/// One of the bank's two output pairs — the room and the headphones.
/// Each carries a master fader, applied to the mix the slots have already
/// been through: MONITOR IS A CUE, so the two are independent and the
/// live master never touches what is being auditioned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MasterBus {
    Live,
    Monitor,
}

/// A quantized transport arm on one slot — a mute the bank's clock is
/// still holding. The slot's mix state is ALREADY the destination (a
/// queue unmutes, a drop mutes); the arm is only the RT thread waiting
/// for the beat to hand it over on, so nothing here is patch state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeckArm {
    /// The deck is where its mute says it is.
    #[default]
    None,
    /// Unmuted, held silent until the clip's first beat comes round.
    Queue,
    /// Muted, held audible until the clip's last beat has played.
    Drop,
}

impl DeckArm {
    fn from_bits(bits: u8) -> Self {
        match bits {
            1 => DeckArm::Queue,
            2 => DeckArm::Drop,
            _ => DeckArm::None,
        }
    }
}

/// What the RT thread publishes for one slot each block.
#[derive(Debug, Default)]
pub struct SlotShared {
    pos_secs: AtomicU64,
    beat: AtomicI64,
    sounding: AtomicBool,
    playing: AtomicBool,
    /// The arm the RT thread is still holding, as [`DeckArm`] bits — it
    /// clears itself on the beat it fires — and the serial of the request
    /// that put it there, so the control thread can tell "already fired"
    /// from "not looked at yet" ([`DecksControl::live_arm`]).
    arm: AtomicU8,
    arm_serial: AtomicU64,
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
    /// Beat of its own loop the slot is on (the silent tail counts), or -1
    /// when nothing is loaded.
    pub fn slot_beat(&self, slot: usize) -> i64 {
        self.slots[slot].beat.load(Ordering::Relaxed)
    }
    /// Whether that beat is one of the clip's own rather than its tail.
    pub fn slot_sounding(&self, slot: usize) -> bool {
        self.slots[slot].sounding.load(Ordering::Relaxed)
    }
    pub fn slot_playing(&self, slot: usize) -> bool {
        self.slots[slot].playing.load(Ordering::Relaxed)
    }
    /// The quantized start/stop this slot is still holding, and the
    /// serial of the request it came from (0 = nothing asked for yet).
    pub fn slot_arm(&self, slot: usize) -> DeckArm {
        DeckArm::from_bits(self.slots[slot].arm.load(Ordering::Relaxed))
    }
    pub fn slot_arm_serial(&self, slot: usize) -> u64 {
        self.slots[slot].arm_serial.load(Ordering::Relaxed)
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
        monitor: bool,
    },
    Timing {
        slot: u8,
        tail: u32,
        phase: i32,
    },
    /// Which of a slot's three tone controls have their CV output patched
    /// into the rack — those stop touching the audio (see
    /// [`DecksRtModule::process`]).
    Tone {
        slot: u8,
        patched: [bool; 3],
    },
    /// Hold this slot's freshly written mute until the beat it belongs on
    /// ([`DeckArm`]). `serial` is the request's number, published back so
    /// the control thread knows the arm has been seen.
    Arm {
        slot: u8,
        arm: DeckArm,
        serial: u64,
    },
    /// The faders on the two output pairs, after the slot mix.
    Master {
        live: f32,
        monitor: f32,
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
    /// When each surface button was last seen pressed, so a release can
    /// be told from a second press ([`MOMENTARY_RELEASE_SECS`]). WALL
    /// clock, not audio frames: the surface is played whether or not the
    /// engine is running, and this is control-thread code. `None` is a
    /// button that has not been down — an off arriving then is a TOGGLE
    /// template's second press, never a finger coming off.
    pub(crate) button_down: [Option<std::time::Instant>; SLOTS * 2],
    /// Slots whose lamps on the surface no longer match their state.
    pub(crate) leds_dirty: [bool; SLOTS],
    /// Channel nibble the device last spoke on — LED messages go back the
    /// way they came, because the surface changes channel per template.
    pub(crate) surface_channel: u8,
    /// The arm each slot was last ASKED for and the serial that ask went
    /// out under. The RT thread answers with both, which is how
    /// [`DecksControl::live_arm`] tells an arm it has already fired from
    /// one it has not looked at yet.
    pub(crate) arm: [DeckArm; SLOTS],
    pub(crate) arm_serial: [u64; SLOTS],
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
            button_down: [None; SLOTS * 2],
            leds_dirty: [true; SLOTS],
            surface_channel: DEFAULT_SURFACE_CHANNEL,
            arm: [DeckArm::None; SLOTS],
            arm_serial: [0; SLOTS],
        }
    }

    /// What a slot is STILL waiting on. The RT thread's own answer once it
    /// has seen the request (it clears the arm on the beat it fires), and
    /// the request itself until then — a bank whose engine is not running
    /// stays armed, because nothing has happened to fire it.
    pub fn live_arm(&self, slot: usize) -> DeckArm {
        if self.arm[slot] == DeckArm::None {
            return DeckArm::None;
        }
        if self.shared.slot_arm_serial(slot) == self.arm_serial[slot] {
            self.shared.slot_arm(slot)
        } else {
            self.arm[slot]
        }
    }
}

/// Channel LED messages go out on until the device has spoken (factory
/// template 1).
pub const DEFAULT_SURFACE_CHANNEL: u8 = 8;

/// Launch Control XL LED velocities: `12 + red + 16*green`, red and green
/// 0..3. A lit control says what it is doing — mute is red, monitor is
/// green — so the surface reads like the strip does.
pub mod led {
    pub const OFF: u8 = 12;
    pub const RED: u8 = 15;
    pub const GREEN: u8 = 60;
}

/// The lamp velocity for one deck's two buttons (mute, monitor).
pub fn led_for(mute: bool, monitor: bool) -> (u8, u8) {
    (
        if mute { led::RED } else { led::OFF },
        if monitor { led::GREEN } else { led::OFF },
    )
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
    /// Cueing: this deck is on the monitor pair instead of the live mix.
    pub monitor: bool,
    /// Whether this deck's return is wired — its send goes through the
    /// rack and what comes back is what the bank mixes.
    pub insert: bool,
    /// Which of the three tone controls have their CV output patched into
    /// the rack, in [`TONES`] order (high, mid, low). A patched one drives
    /// that jack and leaves the deck's own tone alone.
    pub tone_patched: [bool; 3],
    pub duration_secs: f64,
    pub position_secs: f64,
    /// Beat of its own loop the slot is on — the silent tail counts too,
    /// because the lamp is showing where the loop IS. -1 = nothing loaded.
    pub beat: i64,
    /// Whether that beat is the clip's own audio rather than its tail.
    pub sounding: bool,
    pub playing: bool,
    /// A quantized start or stop the bank's clock is still holding: the
    /// mute above is where this deck is GOING, the arm is what it is
    /// waiting for.
    pub arm: DeckArm,
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
    /// The faders on the two output pairs (1 = unity).
    pub master_live: f32,
    pub master_monitor: f32,
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
    monitor: bool,
    /// Tone controls whose CV output is patched into the rack (high, mid,
    /// low): those bands stay flat here.
    tone_patched: [bool; 3],
    /// A mute this slot is not obeying yet — see [`DeckArm`] — and the
    /// serial of the request that armed it, published back untouched.
    arm: DeckArm,
    arm_serial: u64,
    /// Where the slot's loop was on the previous sample, so the pass it
    /// just finished can be seen (a drop fires on that edge).
    last_local: f64,
    /// Smoothed level actually applied, so mute/monitor/fader moves ramp.
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
            monitor: false,
            tone_patched: [false; 3],
            arm: DeckArm::None,
            arm_serial: 0,
            last_local: 0.0,
            gain: 0.0,
            grains: GrainStretch::new(engine_rate),
            eq: [BandSplit::default(); 2],
        }
    }

    /// The three band gains this slot's audio actually gets: a tone
    /// control whose CV output is patched has left the deck, so its band
    /// sits flat.
    fn bands(&self) -> (f32, f32, f32) {
        (
            if self.tone_patched[2] { 1.0 } else { self.low },
            if self.tone_patched[1] { 1.0 } else { self.mid },
            if self.tone_patched[0] { 1.0 } else { self.high },
        )
    }

    fn length_beats(&self) -> u32 {
        if self.beats == 0 {
            0
        } else {
            self.beats + self.tail
        }
    }

    /// The gain this slot is heading for. An arm stands in for the mute
    /// while the clock is still holding it: a queued deck is silent
    /// though it is unmuted, a dropping one plays on though it is muted.
    fn gain_target(&self) -> f32 {
        let open = self.level.max(0.0);
        match self.arm {
            DeckArm::Queue => 0.0,
            DeckArm::Drop => open,
            DeckArm::None => {
                if self.mute {
                    0.0
                } else {
                    open
                }
            }
        }
    }

    /// Has the loop just come round to the clip's first beat — the edge a
    /// queue waits for? That is the loop seam, where every pass of the
    /// clip starts. A slot holding nothing has no first beat to wait for,
    /// so a queue on it fires straight away.
    fn at_first_beat(&self, local: f64) -> bool {
        self.length_beats() == 0 || local < self.last_local
    }

    /// Has the loop just played past the clip's last beat — the edge a
    /// drop waits for? Either the playhead ran into the silent tail or the
    /// whole loop came round. A slot holding nothing has no last beat to
    /// play, so it is always past it.
    fn past_last_beat(&self, local: f64) -> bool {
        if self.length_beats() == 0 {
            return true;
        }
        let last = self.beats as f64;
        local < self.last_local || (local >= last && self.last_local < last)
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
    /// The two output faders, and the smoothed gains actually applied —
    /// which start AT unity, so a bank nobody has touched multiplies its
    /// mix by exactly 1.0.
    master: [f32; 2],
    master_gain: [f32; 2],
    /// One-pole coefficients of the tone-control crossovers and of the
    /// gain smoother, all fixed at construction.
    a_low: f32,
    a_high: f32,
    a_gain: f32,
    /// Samples of the clock output's pulse still to go, and the beat the
    /// last one was fired on.
    clock_left: u32,
    clock_len: u32,
    last_beat: i64,
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
            master: [1.0; 2],
            master_gain: [1.0; 2],
            a_low: one_pole(EQ_LOW_HZ, rate),
            a_high: one_pole(EQ_HIGH_HZ, rate),
            a_gain: 1.0 - (-1.0 / (GAIN_SMOOTH_SECS * rate)).exp(),
            clock_left: 0,
            clock_len: ((rate * CLOCK_PULSE_SECS) as u32).max(1),
            // Beat 0 has not happened yet: the first sample fires it.
            last_beat: -1,
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
                // A new clip is a new timeline: no grain may cross into it,
                // and no arm survives into it either — what was queued or
                // dropping was the clip that just left.
                s.grains.reset();
                s.eq = [BandSplit::default(); 2];
                s.arm = DeckArm::None;
                s.last_local = 0.0;
            }
            DecksCmd::Mix {
                slot,
                level,
                low,
                mid,
                high,
                mute,
                monitor,
            } => {
                let Some(s) = self.slots.get_mut(slot as usize) else {
                    return;
                };
                s.level = level;
                s.low = low;
                s.mid = mid;
                s.high = high;
                s.mute = mute;
                s.monitor = monitor;
            }
            DecksCmd::Timing { slot, tail, phase } => {
                let Some(s) = self.slots.get_mut(slot as usize) else {
                    return;
                };
                s.tail = tail;
                s.phase = phase;
            }
            DecksCmd::Tone { slot, patched } => {
                let Some(s) = self.slots.get_mut(slot as usize) else {
                    return;
                };
                s.tone_patched = patched;
            }
            DecksCmd::Arm { slot, arm, serial } => {
                let Some(s) = self.slots.get_mut(slot as usize) else {
                    return;
                };
                s.arm = arm;
                s.arm_serial = serial;
            }
            DecksCmd::Master { live, monitor } => {
                self.master = [live.max(0.0), monitor.max(0.0)];
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
    fn process(&mut self, inputs: &[Vec<f32>], outputs: &mut [Vec<f32>], mask: u64, frames: usize) {
        while let Ok(cmd) = self.rx.pop() {
            self.apply(cmd);
        }

        // The three tone controls go out as CV whether or not the deck is
        // playing: they are knob positions, and a knob has a position even
        // in silence. Constant across the block, like every control read.
        for (i, slot) in self.slots.iter().enumerate() {
            for (t, control) in TONES.iter().enumerate() {
                let value = match control {
                    SlotControl::High => slot.high,
                    SlotControl::Mid => slot.mid,
                    _ => slot.low,
                };
                let volts = (value / EQ_MAX).clamp(0.0, 1.0) * SIGNAL_MAX;
                outputs[tone_jack(i, t)][..frames].fill(volts);
            }
        }

        let bpm = &inputs[IN_BPM];
        let reset = &inputs[IN_RESET];
        let (a_low, a_high, a_gain) = (self.a_low, self.a_high, self.a_gain);
        let master = self.master;
        let engine_rate = self.engine_rate;
        for s in 0..frames {
            if reset[s] >= 1.0 && self.last_reset < 1.0 {
                self.beat_pos = 0.0;
                self.last_beat = -1;
                for slot in &mut self.slots {
                    slot.grains.reset();
                }
            }
            self.last_reset = reset[s];

            // One pulse per beat of the bank's own clock — the thing the
            // rack can lock to.
            let beat = self.beat_pos.floor() as i64;
            if beat != self.last_beat {
                self.last_beat = beat;
                self.clock_left = self.clock_len;
            }
            outputs[OUT_CLOCK][s] = if self.clock_left > 0 {
                self.clock_left -= 1;
                SIGNAL_MAX
            } else {
                0.0
            };

            let tempo = bpm[s].clamp(MIN_BPM, MAX_BPM) as f64;
            let (mut mix_l, mut mix_r) = (0.0f32, 0.0f32);
            let (mut mon_l, mut mon_r) = (0.0f32, 0.0f32);
            for (i, slot) in self.slots.iter_mut().enumerate() {
                let len = slot.length_beats();
                let local = if len > 0 {
                    (self.beat_pos - slot.phase as f64).rem_euclid(len as f64)
                } else {
                    0.0
                };
                // A queued deck waits for ITS OWN first beat to come
                // round — the loop seam — so it enters in phase with its
                // loop start, never partway through the clip. A dropping
                // one plays its clip out and stops on the edge where the
                // clip's last beat has played — never mid-clip.
                if slot.arm == DeckArm::Queue && slot.at_first_beat(local) {
                    slot.arm = DeckArm::None;
                }
                if slot.arm == DeckArm::Drop && slot.past_last_beat(local) {
                    slot.arm = DeckArm::None;
                }
                slot.last_local = local;

                let target = slot.gain_target();
                slot.gain += a_gain * (target - slot.gain);
                // A wired return makes the rack this deck's insert: what
                // comes back is what the bank mixes, in place of the
                // deck's own path.
                let insert =
                    mask & (1 << return_jack(i, 0)) != 0 || mask & (1 << return_jack(i, 1)) != 0;

                // The deck's own audio, which is also what its send
                // carries — silent whenever there is nothing to read (no
                // clip, or the loop's silent tail).
                let (mut l, mut r) = (0.0f32, 0.0f32);
                let mut sounding = false;
                if let Some(track) = &slot.track {
                    let beat_frames = 60.0 / slot.source_bpm as f64 * track.sample_rate as f64;
                    let pos = local * beat_frames;
                    if len > 0 && local < slot.beats as f64 && pos < track.frames() as f64 {
                        // Grains read at the clip's own rate while the
                        // playhead moves at the bank's — that split is the
                        // whole stretch.
                        let step = track.sample_rate as f64 / engine_rate as f64;
                        let taps = slot.grains.tick(pos, step, &track.channels[0]);
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
                        let (low, mid, high) = slot.bands();
                        l = slot.eq[0].process(l, a_low, a_high, low, mid, high);
                        r = slot.eq[1].process(r, a_low, a_high, low, mid, high);
                        sounding = true;
                    }
                }
                outputs[send_jack(i, 0)][s] = l * SIGNAL_MAX;
                outputs[send_jack(i, 1)][s] = r * SIGNAL_MAX;

                if insert {
                    // Back off the rack in engine units; the fader and the
                    // mute still belong to the deck.
                    l = inputs[return_jack(i, 0)][s] / SIGNAL_MAX;
                    r = inputs[return_jack(i, 1)][s] / SIGNAL_MAX;
                } else if !sounding {
                    continue;
                }
                // Monitor takes the deck OFF the live pair and puts it on
                // the monitor one — it is a cue, not a solo: nothing else
                // changes.
                let (bus_l, bus_r) = if slot.monitor {
                    (&mut mon_l, &mut mon_r)
                } else {
                    (&mut mix_l, &mut mix_r)
                };
                *bus_l += l * slot.gain;
                *bus_r += r * slot.gain;
            }
            // The two output faders, last of all and ramped like a slot's
            // own: they are the whole pair's level, so nothing on the way
            // to them can tell they are there.
            for (gain, target) in self.master_gain.iter_mut().zip(master) {
                *gain += a_gain * (target - *gain);
            }
            outputs[OUT_AUDIO_L][s] = mix_l * self.master_gain[0] * SIGNAL_MAX;
            outputs[OUT_AUDIO_R][s] = mix_r * self.master_gain[0] * SIGNAL_MAX;
            outputs[OUT_MON_L][s] = mon_l * self.master_gain[1] * SIGNAL_MAX;
            outputs[OUT_MON_R][s] = mon_r * self.master_gain[1] * SIGNAL_MAX;
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
            let (pos_secs, beat, sounding, playing) = match (&slot.track, len) {
                (Some(track), len) if len > 0 => {
                    let local = (self.beat_pos - slot.phase as f64).rem_euclid(len as f64);
                    // The beat is where the LOOP is, tail included: a
                    // silent beat is still a beat the lamp must show.
                    let sounding = local < slot.beats as f64;
                    (
                        local * 60.0 / slot.source_bpm as f64,
                        local as i64,
                        sounding,
                        sounding && slot.gain > 1e-4 && track.frames() > 0,
                    )
                }
                _ => (0.0, -1, false, false),
            };
            pub_slot
                .pos_secs
                .store(pos_secs.to_bits(), Ordering::Relaxed);
            pub_slot.beat.store(beat, Ordering::Relaxed);
            pub_slot.sounding.store(sounding, Ordering::Relaxed);
            pub_slot.playing.store(playing, Ordering::Relaxed);
            pub_slot.arm.store(slot.arm as u8, Ordering::Relaxed);
            pub_slot
                .arm_serial
                .store(slot.arm_serial, Ordering::Relaxed);
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
    fn manifest_is_one_clock_two_pairs_and_a_loop_per_deck() {
        let m = decks_manifest();
        assert_eq!(m.id, DECKS_ID);
        let ins: Vec<&str> = m.inputs.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ins.len(), N_INPUTS);
        assert_eq!(&ins[..2], ["bpm", "reset"]);
        // The tempo and the reset first, then a return pair per deck.
        assert_eq!(ins[return_jack(0, 0)], "d1_in_l");
        assert_eq!(ins[return_jack(7, 1)], "d8_in_r");
        let outs: Vec<&str> = m.outputs.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(outs.len(), N_OUTPUTS);
        assert_eq!(
            &outs[..5],
            ["audio_l", "audio_r", "mon_l", "mon_r", "clock"]
        );
        assert_eq!(outs[send_jack(0, 0)], "d1_l");
        assert_eq!(outs[tone_jack(0, 0)], "d1_high");
        assert_eq!(outs[tone_jack(0, 2)], "d1_low");
        assert_eq!(outs[tone_jack(7, 2)], "d8_low");
        // The mask the RT reads is a u64, so the jacks have to fit in it.
        const { assert!(N_INPUTS <= 64) };
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
            Some((3, SlotControl::Monitor))
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
        let mut inputs = vec![vec![0.0; frames]; N_INPUTS];
        inputs[IN_BPM].fill(bpm);
        let mut outputs = vec![vec![0.0; frames]; N_OUTPUTS];
        m.process(&inputs, &mut outputs, 0, frames);
        (outputs.remove(0), shared)
    }

    /// Render with wires: `mask` says which input jacks are connected and
    /// `returns` fills them, so an insert can be tested.
    fn render_patched(
        setup: impl FnOnce(&mut rtrb::Producer<DecksCmd>),
        frames: usize,
        mask: u64,
        returns: impl Fn(usize, usize) -> f32,
    ) -> Vec<Vec<f32>> {
        let (mut tx, rx) = rtrb::RingBuffer::new(64);
        let (garbage_tx, _garbage_rx) = rtrb::RingBuffer::new(64);
        let shared = Arc::new(DecksShared::default());
        let mut m = DecksRtModule::new(rx, garbage_tx, 48_000.0, shared);
        setup(&mut tx);
        let mut inputs = vec![vec![0.0; frames]; N_INPUTS];
        inputs[IN_BPM].fill(120.0);
        for (jack, buf) in inputs.iter_mut().enumerate() {
            if mask & (1 << jack) == 0 {
                continue;
            }
            for (s, v) in buf.iter_mut().enumerate() {
                *v = returns(jack, s);
            }
        }
        let mut outputs = vec![vec![0.0; frames]; N_OUTPUTS];
        m.process(&inputs, &mut outputs, mask, frames);
        outputs
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

    fn mix(tx: &mut rtrb::Producer<DecksCmd>, slot: u8, level: f32, mute: bool, monitor: bool) {
        tx.push(DecksCmd::Mix {
            slot,
            level,
            low: 1.0,
            mid: 1.0,
            high: 1.0,
            mute,
            monitor,
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
    fn mute_and_level_ramp_rather_than_click() {
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
    fn monitor_moves_a_deck_to_the_cue_pair_and_leaves_the_rest_alone() {
        let out = render_patched(
            |tx| {
                load(tx, 0, 2, 0.5);
                mix(tx, 0, 1.0, false, false);
                load(tx, 1, 2, 0.25);
                mix(tx, 1, 1.0, false, true);
            },
            4800,
            0,
            |_, _| 0.0,
        );
        let live = &out[OUT_AUDIO_L][4700..];
        let mon = &out[OUT_MON_L][4700..];
        assert!(
            live.iter().all(|s| (*s - 0.5 * SIGNAL_MAX).abs() < 0.05),
            "the live pair carries the deck that is NOT being cued, untouched"
        );
        assert!(
            mon.iter().all(|s| (*s - 0.25 * SIGNAL_MAX).abs() < 0.05),
            "and the cued deck comes out of the monitor pair"
        );
    }

    #[test]
    fn a_wired_return_makes_the_rack_that_decks_insert() {
        // Slot 1's return carries a constant; its own clip must not reach
        // the mix as well, or the deck would be heard twice.
        let mask = 1 << return_jack(0, 0) | 1 << return_jack(0, 1);
        let out = render_patched(
            |tx| {
                load(tx, 0, 2, 0.5);
                mix(tx, 0, 1.0, false, false);
            },
            4800,
            mask,
            |_, _| 0.25 * SIGNAL_MAX,
        );
        let live = &out[OUT_AUDIO_L][4700..];
        assert!(
            live.iter().all(|s| (*s - 0.25 * SIGNAL_MAX).abs() < 0.05),
            "what comes back is what is mixed, at the deck's own fader"
        );
        let send = &out[send_jack(0, 0)][4700..];
        assert!(
            send.iter().all(|s| (*s - 0.5 * SIGNAL_MAX).abs() < 0.05),
            "and the send still carries the deck's own audio, pre-fader"
        );
    }

    #[test]
    fn a_patched_tone_control_drives_its_jack_and_leaves_the_audio_flat() {
        let mask = 0;
        let out = render_patched(
            |tx| {
                load(tx, 0, 2, 0.5);
                tx.push(DecksCmd::Mix {
                    slot: 0,
                    level: 1.0,
                    low: 0.0,
                    mid: 1.0,
                    high: 1.0,
                    mute: false,
                    monitor: false,
                })
                .unwrap();
                // Low is patched into the rack: it stops cutting the bass.
                tx.push(DecksCmd::Tone {
                    slot: 0,
                    patched: [false, false, true],
                })
                .unwrap();
            },
            4800,
            mask,
            |_, _| 0.0,
        );
        // Low at 0 with the CV unpatched would gut a DC-ish clip; patched,
        // the audio comes through at unity.
        let live = &out[OUT_AUDIO_L][4700..];
        assert!(
            live.iter().all(|s| (*s - 0.5 * SIGNAL_MAX).abs() < 0.05),
            "a patched tone control leaves its band alone: {:?}",
            &live[..4]
        );
        // ...and the jack carries the knob position, 0 V for a cut.
        assert!(out[tone_jack(0, 2)].iter().all(|v| *v == 0.0));
        // A control still on the deck sits at its own value: unity is
        // half of the 0..EQ_MAX span.
        let mid = out[tone_jack(0, 1)][0];
        assert!((mid - SIGNAL_MAX / EQ_MAX).abs() < 1e-6, "mid CV {mid}");
    }

    #[test]
    fn the_clock_output_pulses_once_a_beat() {
        // Two beats at 120 BPM = one second.
        let out = render_patched(
            |tx| {
                load(tx, 0, 2, 0.5);
                mix(tx, 0, 1.0, false, false);
            },
            48_000,
            0,
            |_, _| 0.0,
        );
        let clock = &out[OUT_CLOCK];
        let edges = clock
            .windows(2)
            .filter(|w| w[0] == 0.0 && w[1] > 0.0)
            .count()
            // The very first sample is beat 0's pulse, which has no edge
            // before it.
            + usize::from(clock[0] > 0.0);
        assert_eq!(edges, 2, "one pulse per beat");
        assert!(clock[0] > 0.0 && clock[47] > 0.0 && clock[100] == 0.0);
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
        let mut outputs = vec![vec![0.0; frames]; N_OUTPUTS];
        let mut inputs = vec![vec![0.0; frames]; N_INPUTS];
        inputs[IN_BPM].fill(120.0);
        m.process(&inputs, &mut outputs, 0, frames);
        assert!(shared.beat() > 0.4);
        inputs[IN_RESET].fill(10.0);
        m.process(&inputs, &mut outputs, 0, frames);
        assert!(
            (shared.beat() - 0.5).abs() < 1e-6,
            "the reset restarts the count, got {}",
            shared.beat()
        );
    }

    /// A bank an arm test can drive block by block: the module, the
    /// command ring and the atomics it publishes.
    fn rt_bank() -> (rtrb::Producer<DecksCmd>, DecksRtModule, Arc<DecksShared>) {
        let (tx, rx) = rtrb::RingBuffer::new(64);
        let (garbage_tx, _g) = rtrb::RingBuffer::new(64);
        let shared = Arc::new(DecksShared::default());
        let m = DecksRtModule::new(rx, garbage_tx, 48_000.0, shared.clone());
        (tx, m, shared)
    }

    fn arm(tx: &mut rtrb::Producer<DecksCmd>, slot: u8, arm: DeckArm, serial: u64) {
        tx.push(DecksCmd::Arm { slot, arm, serial }).unwrap();
    }

    /// Render `frames` more of `m` at 120 BPM and hand back the live L
    /// output, so a test can walk a bank beat by beat.
    fn block(m: &mut DecksRtModule, frames: usize) -> Vec<f32> {
        let mut inputs = vec![vec![0.0; frames]; N_INPUTS];
        inputs[IN_BPM].fill(120.0);
        let mut outputs = vec![vec![0.0; frames]; N_OUTPUTS];
        m.process(&inputs, &mut outputs, 0, frames);
        outputs.remove(OUT_AUDIO_L)
    }

    /// A beat at 120 BPM and 48 kHz.
    const BEAT: usize = 24_000;

    #[test]
    fn a_queued_deck_waits_for_its_clips_first_beat_and_then_plays() {
        let (mut tx, mut m, shared) = rt_bank();
        load(&mut tx, 0, 2, 0.5);
        mix(&mut tx, 0, 1.0, true, false);
        // Half a beat in, muted and silent.
        block(&mut m, BEAT / 2);

        // Queue: the deck is unmuted THEN AND THERE, and the bank holds it.
        mix(&mut tx, 0, 1.0, false, false);
        arm(&mut tx, 0, DeckArm::Queue, 1);
        // This block crosses the bank's beat 1 — the MIDDLE of the
        // two-beat clip. A queue is not a beat-boundary start: the deck
        // waits for its clip's own first beat, so it stays silent here.
        let held = block(&mut m, BEAT);
        assert!(
            held.iter().all(|s| s.abs() < 1e-6),
            "an unmuted deck stays silent while its queue is held — even across a bank beat"
        );
        assert_eq!(shared.slot_arm(0), DeckArm::Queue);
        assert_eq!(shared.slot_arm_serial(0), 1);

        // Beat 2 is the loop seam — the clip's first beat coming round —
        // and it lands halfway through this block.
        let played = block(&mut m, BEAT);
        assert_eq!(
            shared.slot_arm(0),
            DeckArm::None,
            "the clip's first beat fired the queue"
        );
        assert!(
            played[..BEAT / 2 - 100].iter().all(|s| s.abs() < 1e-6),
            "silent up to the seam"
        );
        assert!(
            played[played.len() - 100..]
                .iter()
                .all(|s| (*s - 0.5 * SIGNAL_MAX).abs() < 0.05),
            "and past it the deck is playing at its fader"
        );
        // On the seam means ON it: the ramp is the anti-click 10 ms, so
        // the deck is already up a fifth of a beat past it.
        assert!(played[BEAT / 2 + BEAT / 4] > 0.4 * SIGNAL_MAX);
    }

    #[test]
    fn a_shifted_clips_queue_fires_on_its_own_first_beat_not_the_banks_grid() {
        let (mut tx, mut m, shared) = rt_bank();
        load(&mut tx, 0, 2, 0.5);
        // Shifted a beat: the clip's first beat plays on the bank's ODD
        // beats, and that is where its queue must land.
        tx.push(DecksCmd::Timing {
            slot: 0,
            tail: 0,
            phase: 1,
        })
        .unwrap();
        mix(&mut tx, 0, 1.0, false, false);
        arm(&mut tx, 0, DeckArm::Queue, 1);

        // Beat 0 and beat 1 pass; the seam for a shift of 1 is beat 1.
        block(&mut m, BEAT / 2);
        assert_eq!(shared.slot_arm(0), DeckArm::Queue, "beat 0 is mid-clip");
        block(&mut m, BEAT);
        assert_eq!(shared.slot_arm(0), DeckArm::None, "beat 1 is its seam");
    }

    #[test]
    fn a_dropped_deck_plays_its_clip_out_and_stops_on_the_seam() {
        let (mut tx, mut m, shared) = rt_bank();
        // Two beats of clip: the loop comes round every second.
        load(&mut tx, 0, 2, 0.5);
        mix(&mut tx, 0, 1.0, false, false);
        block(&mut m, BEAT);

        // Drop: muted THEN AND THERE, and the bank keeps it up anyway.
        mix(&mut tx, 0, 1.0, true, false);
        arm(&mut tx, 0, DeckArm::Drop, 1);
        let rest_of_the_clip = block(&mut m, BEAT - 1_000);
        assert!(
            rest_of_the_clip[rest_of_the_clip.len() - 100..]
                .iter()
                .all(|s| (*s - 0.5 * SIGNAL_MAX).abs() < 0.05),
            "a muted deck plays on until its clip runs out"
        );
        assert_eq!(shared.slot_arm(0), DeckArm::Drop);

        // The clip's last beat ends 1000 samples into this block; the
        // mute ramps out over the anti-click 10 ms from there.
        let seam = block(&mut m, BEAT);
        assert_eq!(shared.slot_arm(0), DeckArm::None, "the seam fired the drop");
        assert!(
            seam[8_000..].iter().all(|s| s.abs() < 1e-4),
            "and past the seam the deck is gone, not playing the clip again"
        );
    }

    #[test]
    fn a_drop_stops_when_the_clip_runs_out_not_when_the_tail_does() {
        let (mut tx, mut m, shared) = rt_bank();
        // One beat of clip and one of silence hung on the end.
        load(&mut tx, 0, 1, 0.5);
        mix(&mut tx, 0, 1.0, false, false);
        tx.push(DecksCmd::Timing {
            slot: 0,
            tail: 1,
            phase: 0,
        })
        .unwrap();
        block(&mut m, BEAT / 2);

        mix(&mut tx, 0, 1.0, true, false);
        arm(&mut tx, 0, DeckArm::Drop, 7);
        block(&mut m, BEAT / 2 - 1_000);
        assert_eq!(
            shared.slot_arm(0),
            DeckArm::Drop,
            "the clip is still running"
        );
        assert_eq!(shared.slot_arm_serial(0), 7);

        // Into the tail: the clip has played its last beat, so the drop is
        // done — it does not wait for the whole loop to come round.
        block(&mut m, 2_000);
        assert_eq!(shared.slot_arm(0), DeckArm::None);
    }

    #[test]
    fn loading_a_clip_clears_whatever_the_slot_was_armed_for() {
        let (mut tx, mut m, shared) = rt_bank();
        load(&mut tx, 0, 2, 0.5);
        mix(&mut tx, 0, 1.0, false, false);
        block(&mut m, BEAT / 2);
        mix(&mut tx, 0, 1.0, true, false);
        arm(&mut tx, 0, DeckArm::Drop, 1);
        block(&mut m, 128);
        assert_eq!(shared.slot_arm(0), DeckArm::Drop);

        load(&mut tx, 0, 4, 0.25);
        let out = block(&mut m, BEAT / 2);
        assert_eq!(shared.slot_arm(0), DeckArm::None);
        assert!(
            out[out.len() - 100..].iter().all(|s| s.abs() < 1e-6),
            "the new clip obeys the slot's own mute"
        );
    }
}
