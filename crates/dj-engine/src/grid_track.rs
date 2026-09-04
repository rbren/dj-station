//! Built-in Grid Track module (`builtin.grid_track`): one row of the Grid
//! page — a beat clip, the SEQUENCE of places it is laid on a timeline,
//! and the controls that mix it — played against a clock.
//!
//! - Inputs: `clock` (a rising edge is a beat of the grid), `reset` (parks
//!   the row on the program's start beat), `bpm` (the tempo the clip's
//!   audio was rendered at — written by the loader, like the Beat Clip
//!   module's), `level`, `pan`, `wet`, and the insert return `ret_l` /
//!   `ret_r`.
//! - Outputs: `audio_l` / `audio_r` (the row as it is heard) and
//!   `send_l` / `send_r` (the row's dry audio, for its effects rack).
//!
//! THE ROW'S ARRANGEMENT IS A PROGRAM, not patch state. Placements, the
//! level line and the play range live in the Grid document
//! (`grids/<name>.json`, owned by the app), which compiles them into a
//! [`GridTrackProgram`] and ships it over an SPSC ring as an `Arc`;
//! replaced programs go back on a garbage ring for an off-RT drop. What
//! the patch keeps is what every module keeps — its knobs.
//!
//! EVERYTHING IS IN ABSOLUTE BEATS — the Grid document's own columns.
//! `loop_start`/`loop_end` are the play range and `start_beat` is where a
//! start parks (the cue), all counted from the arrangement's beat 0, so
//! nothing has to be rotated into a range and the page's playhead is the
//! clock's position as it stands. The module still needs to know nothing
//! about bars or tempo automation: the [`crate::clock`] module owns the
//! tempo, and this one only counts its edges.
//!
//! THE CLOCK OWNS PHASE, exactly as in [`crate::beat_clip`]: an edge IS a
//! beat boundary, and between edges the position is interpolated from the
//! interval the last two measured. Nothing sounds until two edges have
//! given a tempo, so a row can never come in at a rate nobody has said.
//!
//! …WHICH IS WHY A STOP HAS TO BE SAID. Interpolating between edges means
//! a clock that has stopped pulsing is indistinguishable from one that is
//! merely between beats, so a row left to itself plays on for ever at the
//! last tempo it measured — a pause that went quiet on screen while the
//! room still heard it. [`crate::Engine::grid_track_transport`] is the other half
//! of a Grid pause: a held row drops its voices, stops advancing, and
//! takes edits in silence until it is told to run again.
//!
//! A COPY IS A VOICE. Entering a copy's span (its lead-in bleed included)
//! takes a voice from a small fixed pool, so two copies running into each
//! other overlap the way the Grid page's two scheduled sources do; the
//! bleed bookends are read out of the same grain stream as the loop, at
//! negative positions (lead-in) and beyond the loop's end (tail-out), so
//! a stretch moves all three together. The pass boundary cuts them: at
//! the loop's seam every voice stops, which is the Grid's rule that a
//! bookend an end of the play range cuts is not heard.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::graph::SIGNAL_MAX;
use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, DisplaySpec, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;
use crate::playback::{ClipAudio, ClipBleed, TrackData};
use crate::stretch::{sample_at, GrainStretch};

pub const GRID_TRACK_ID: &str = "builtin.grid_track";

pub(crate) const IN_CLOCK: usize = 0;
pub(crate) const IN_RESET: usize = 1;
pub(crate) const IN_BPM: usize = 2;
pub(crate) const IN_LEVEL: usize = 3;
pub(crate) const IN_PAN: usize = 4;
pub(crate) const IN_WET: usize = 5;
const IN_RET_L: usize = 6;
const IN_RET_R: usize = 7;

const OUT_AUDIO_L: usize = 0;
const OUT_AUDIO_R: usize = 1;
const OUT_SEND_L: usize = 2;
const OUT_SEND_R: usize = 3;

/// Longest gap between two edges that still counts as a beat (the Beat
/// Clip module's rule: a slower clock than this is a stopped one).
const MAX_INTERVAL_SECS: f32 = 4.0;

/// Copies that may sound at once. Two is what a join needs (one copy's
/// tail-out over the next's lead-in); the third is slack for a row whose
/// clips are laid closer than their bleed is long.
const VOICES: usize = 3;

/// How near the clip's own tempo the transport has to be before the
/// stretcher is skipped altogether: at unity the grains are transparent
/// but not free, and a grid at the tempo its clips were cut at is the
/// common case.
const STRETCH_EPS: f64 = 1e-4;

pub const GRID_TRACK_QUEUE_CAP: usize = 64;

/// One breakpoint of the row's level line: the gain in force from `beat`,
/// ramped linearly to the next point (`levelAt` in `app/src/grid.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LevelPoint {
    pub beat: f64,
    pub level: f64,
}

/// What the row plays: where its clip is laid, how loud it is over the
/// pass, and the loop it all sits in.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct GridTrackProgram {
    /// Grid columns the clip's own beat 0 lands on, sorted.
    #[serde(default)]
    pub copies: Vec<f64>,
    /// The row's level line; empty is unity all the way across.
    #[serde(default)]
    pub levels: Vec<LevelPoint>,
    /// The clip's length in its own beats. 0 silences the row (nothing
    /// says how long a copy is).
    #[serde(default)]
    pub clip_beats: f64,
    /// The beat the play range runs back to (beats are ABSOLUTE grid
    /// columns, as in [`crate::clock::ClockProgram`]).
    #[serde(default)]
    pub loop_start: f64,
    /// The beat the play range ends on; `loop_end <= loop_start` never
    /// wraps.
    #[serde(default)]
    pub loop_end: f64,
    /// Where a reset parks the position (the cue).
    #[serde(default)]
    pub start_beat: f64,
    /// The tempo the transport is expected to come in at, if the app
    /// knows it. A row measures its beat from the clock's edges, which
    /// takes two of them — and a Grid whose first beat is silent while
    /// the row works out what it was already told is not the Grid
    /// anyone drew. 0 falls back to measuring (a row patched under a
    /// clock nobody has described).
    #[serde(default)]
    pub start_bpm: f64,
}

impl GridTrackProgram {
    /// The level line at `beat`, holding the end values outside the
    /// points. `from` is a cursor into `levels` that the caller advances
    /// monotonically — the lookup is per sample, so it may not search.
    #[inline]
    fn level_at(&self, beat: f64, cursor: &mut usize) -> f64 {
        let pts = &self.levels;
        if pts.is_empty() {
            return 1.0;
        }
        while *cursor + 1 < pts.len() && pts[*cursor + 1].beat <= beat {
            *cursor += 1;
        }
        while *cursor > 0 && pts[*cursor].beat > beat {
            *cursor -= 1;
        }
        let a = pts[*cursor];
        if beat <= a.beat {
            return a.level;
        }
        match pts.get(*cursor + 1) {
            None => a.level,
            Some(b) => {
                let span = b.beat - a.beat;
                if span <= 0.0 {
                    b.level
                } else {
                    a.level + (b.level - a.level) * (beat - a.beat) / span
                }
            }
        }
    }
}

/// Commands from the control thread, applied at a block boundary.
pub enum GridTrackCmd {
    /// New audio for the row (a new clip, or the same clip re-cut).
    Load {
        audio: ClipAudio,
    },
    Program(Arc<GridTrackProgram>),
    /// Run or hold the row. A row reads its position BETWEEN the clock's
    /// edges, so a clock that stops pulsing is indistinguishable from one
    /// between beats: a held row is told, and only then goes quiet.
    Transport {
        running: bool,
    },
}

/// What the RT thread hands back for an off-RT drop.
pub enum GridTrackGarbage {
    Track(Arc<TrackData>),
    Program(Arc<GridTrackProgram>),
}

/// What the RT module publishes once per block.
#[derive(Debug, Default)]
pub struct GridTrackShared {
    beat: AtomicU64,
    playing: AtomicBool,
}

impl GridTrackShared {
    fn publish(&self, beat: f64, playing: bool) {
        self.beat.store(beat.to_bits(), Ordering::Relaxed);
        self.playing.store(playing, Ordering::Relaxed);
    }

    pub fn beat(&self) -> f64 {
        f64::from_bits(self.beat.load(Ordering::Relaxed))
    }
    pub fn playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }
}

/// Control-side state per Grid Track node.
pub struct GridTrackControl {
    pub tx: rtrb::Producer<GridTrackCmd>,
    pub garbage_rx: rtrb::Consumer<GridTrackGarbage>,
    pub shared: Arc<GridTrackShared>,
    pub program: Arc<GridTrackProgram>,
    /// The clip id whose audio the node holds — how the app tells a row
    /// that still needs its audio from one that is playing it.
    pub clip_id: Option<String>,
    pub audio: Option<ClipAudio>,
}

impl GridTrackControl {
    pub fn new(
        tx: rtrb::Producer<GridTrackCmd>,
        garbage_rx: rtrb::Consumer<GridTrackGarbage>,
        shared: Arc<GridTrackShared>,
    ) -> Self {
        GridTrackControl {
            tx,
            garbage_rx,
            shared,
            program: Arc::new(GridTrackProgram::default()),
            clip_id: None,
            audio: None,
        }
    }
}

/// Snapshot of a Grid Track node for UIs.
#[derive(Debug, Clone, Serialize)]
pub struct GridTrackStatus {
    pub clip_id: Option<String>,
    /// Transport-relative beat the row is on, as of the last block.
    pub beat: f64,
    pub playing: bool,
}

pub fn grid_track_manifest() -> Manifest {
    let trig = |id: &str, name: &str| JackDecl {
        id: id.into(),
        name: name.into(),
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
    };
    let knob = |id: &str, name: &str, min: f32, max: f32, default: f32| JackDecl {
        id: id.into(),
        name: name.into(),
        default,
        audio: false,
        capture: false,
        knob: Some(KnobConfig {
            style: KnobStyle::Continuous,
            min,
            max,
            curve: Curve::Linear,
            steps: None,
        }),
        display: None,
    };
    let audio_in = |id: &str, name: &str| JackDecl {
        id: id.into(),
        name: name.into(),
        default: 0.0,
        audio: true,
        capture: false,
        knob: None,
        display: None,
    };
    let out = |id: &str, name: &str| OutputDecl {
        id: id.into(),
        name: name.into(),
        display: None,
    };
    Manifest {
        id: GRID_TRACK_ID.into(),
        name: "Grid Track".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        deprecated: false,
        inputs: vec![
            trig("clock", "Clock"),
            trig("reset", "Reset"),
            JackDecl {
                id: "bpm".into(),
                name: "BPM".into(),
                default: 120.0,
                audio: false,
                capture: false,
                knob: Some(KnobConfig {
                    style: KnobStyle::Continuous,
                    min: crate::clock::MIN_BPM,
                    max: crate::clock::MAX_BPM,
                    curve: Curve::Linear,
                    steps: None,
                }),
                display: Some(DisplaySpec {
                    unit: Some("BPM".into()),
                    ..DisplaySpec::default()
                }),
            },
            knob("level", "Level", 0.0, 2.0, 1.0),
            knob("pan", "Pan", -1.0, 1.0, 0.0),
            knob("wet", "Wetness", 0.0, 1.0, 1.0),
            audio_in("ret_l", "Return L"),
            audio_in("ret_r", "Return R"),
        ],
        outputs: vec![
            out("audio_l", "Audio L"),
            out("audio_r", "Audio R"),
            out("send_l", "Send L"),
            out("send_r", "Send R"),
        ],
        params: vec![],
        ui: None,
        latency_samples: 0,
        bypass: Default::default(),
        presets: Default::default(),
    }
}

/// One sounding copy of the row's clip.
struct Voice {
    active: bool,
    /// Beat (transport-relative) the copy's own beat 0 sits on.
    start: f64,
    grains: GrainStretch,
}

/// The RT-side Grid Track module.
pub struct GridTrackRtModule {
    rx: rtrb::Consumer<GridTrackCmd>,
    garbage_tx: rtrb::Producer<GridTrackGarbage>,
    program: Arc<GridTrackProgram>,
    track: Option<Arc<TrackData>>,
    bleed: ClipBleed,
    engine_rate: f32,
    voices: Vec<Voice>,
    /// The copy the next entry will be, as an index into `program.copies`.
    next_copy: usize,
    /// Beat position of the last clock edge; the audible position adds
    /// the interpolation since.
    anchor: f64,
    pos: f64,
    started: bool,
    /// Whether the transport driving the row is running. TRUE until told
    /// otherwise, so a row wired to a clock in a plain patch plays on the
    /// edges it is given, exactly as it always has.
    running: bool,
    last_clock: f32,
    last_reset: f32,
    interval: f32,
    seen_edge: bool,
    since_clock: f32,
    level_cursor: usize,
    shared: Arc<GridTrackShared>,
}

impl GridTrackRtModule {
    pub fn new(
        rx: rtrb::Consumer<GridTrackCmd>,
        garbage_tx: rtrb::Producer<GridTrackGarbage>,
        engine_rate: f32,
        shared: Arc<GridTrackShared>,
    ) -> Self {
        let rate = engine_rate.max(1.0);
        GridTrackRtModule {
            rx,
            garbage_tx,
            program: Arc::new(GridTrackProgram::default()),
            track: None,
            bleed: ClipBleed::default(),
            engine_rate: rate,
            voices: (0..VOICES)
                .map(|_| Voice {
                    active: false,
                    start: 0.0,
                    grains: GrainStretch::new(rate),
                })
                .collect(),
            next_copy: 0,
            anchor: 0.0,
            pos: 0.0,
            started: false,
            running: true,
            last_clock: 0.0,
            last_reset: 0.0,
            interval: 0.0,
            seen_edge: false,
            since_clock: 0.0,
            level_cursor: 0,
            shared,
        }
    }

    /// Park on the program's start beat and drop every voice: nothing
    /// sounds again until the next clock edge.
    fn rearm(&mut self) {
        self.anchor = self.program.start_beat;
        self.pos = self.anchor;
        self.started = false;
        self.silence();
        self.reindex();
    }

    fn silence(&mut self) {
        for v in &mut self.voices {
            v.active = false;
            v.grains.reset();
        }
    }

    /// Point `next_copy` at the first copy this position has not entered.
    /// A copy starting exactly HERE is still to come — that is the copy a
    /// pass beginning on its downbeat has to play. Binary search, no
    /// allocation; only ever run on a reset, a wrap or an edit.
    fn reindex(&mut self) {
        let pos = self.pos;
        let lead = self.lead_beats();
        self.next_copy = self
            .program
            .copies
            .partition_point(|&start| start - lead < pos);
        self.level_cursor = 0;
    }

    /// Re-derive the voices after an EDIT: the cursor, plus whatever copy
    /// the position is already inside, so re-compiling the program under
    /// a running transport does not drop the clip in flight.
    fn resync(&mut self) {
        self.reindex();
        // A held row takes the edit but stays quiet: the page syncs after
        // every keystroke, and an edit made while paused must not be what
        // starts the sound again.
        if !self.started || !self.running {
            return;
        }
        let (lead, tail) = (self.lead_beats(), self.tail_beats());
        let span = self.program.clip_beats + tail;
        while self.next_copy < self.program.copies.len() {
            let start = self.program.copies[self.next_copy];
            if start - lead > self.pos {
                break;
            }
            self.next_copy += 1;
            if self.pos < start + span {
                let slot = self.voices.iter().position(|v| !v.active).unwrap_or(0);
                self.voices[slot].active = true;
                self.voices[slot].start = start;
                self.voices[slot].grains.reset();
            }
        }
    }

    /// How far ahead of a copy its lead-in bleed starts, in clip beats.
    /// The bleed's length is fixed audio, so it converts through the
    /// clip's own tempo — the ratio the copy's span is measured in.
    fn lead_beats(&self) -> f64 {
        let (Some(track), Some(left)) = (&self.track, &self.bleed.left) else {
            return 0.0;
        };
        let clip_frames = track.frames() as f64;
        if clip_frames <= 0.0 || self.program.clip_beats <= 0.0 {
            return 0.0;
        }
        left.frames() as f64 / (clip_frames / self.program.clip_beats)
    }

    fn tail_beats(&self) -> f64 {
        let (Some(track), Some(right)) = (&self.track, &self.bleed.right) else {
            return 0.0;
        };
        let clip_frames = track.frames() as f64;
        if clip_frames <= 0.0 || self.program.clip_beats <= 0.0 {
            return 0.0;
        }
        right.frames() as f64 / (clip_frames / self.program.clip_beats)
    }
}

impl HostModule for GridTrackRtModule {
    fn process(&mut self, inputs: &[Vec<f32>], outputs: &mut [Vec<f32>], mask: u64, frames: usize) {
        let mut reload = false;
        while let Ok(cmd) = self.rx.pop() {
            match cmd {
                GridTrackCmd::Load { audio } => {
                    if let Some(old) = self.track.replace(audio.track) {
                        let _ = self.garbage_tx.push(GridTrackGarbage::Track(old));
                    }
                    for old in [
                        std::mem::replace(&mut self.bleed.left, audio.bleed.left),
                        std::mem::replace(&mut self.bleed.right, audio.bleed.right),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        let _ = self.garbage_tx.push(GridTrackGarbage::Track(old));
                    }
                    reload = true;
                }
                GridTrackCmd::Program(p) => {
                    let old = std::mem::replace(&mut self.program, p);
                    let _ = self.garbage_tx.push(GridTrackGarbage::Program(old));
                    reload = true;
                }
                GridTrackCmd::Transport { running } => {
                    self.running = running;
                    if !running {
                        // Held HERE, and quiet from this block on: the
                        // position stops advancing and every copy in
                        // flight is dropped, bookends and all.
                        self.silence();
                        // The count to the next edge is abandoned with it.
                        // A held row's counter stands still, so measuring
                        // the beat across the hold would read the fraction
                        // it was paused on as a whole beat; the row keeps
                        // the beat it last measured instead.
                        self.seen_edge = false;
                    }
                }
            }
        }
        if reload {
            // A program edited under a running transport keeps the
            // position it is at — only what is laid on the timeline
            // changes — but the voices in flight are re-derived, so a
            // copy the edit deleted stops being heard.
            self.silence();
            self.resync();
        }

        let clock = &inputs[IN_CLOCK];
        let reset = &inputs[IN_RESET];
        let bpm = &inputs[IN_BPM];
        let level_in = &inputs[IN_LEVEL];
        let pan_in = &inputs[IN_PAN];
        let wet_in = &inputs[IN_WET];
        let insert = mask & ((1 << IN_RET_L) | (1 << IN_RET_R)) != 0;
        let clip_beats = self.program.clip_beats;
        let (loop_start, loop_end) = (self.program.loop_start, self.program.loop_end);
        let looping = loop_end > loop_start;
        let lead_beats = self.lead_beats();
        let tail_beats = self.tail_beats();
        let clip_frames = self
            .track
            .as_ref()
            .map(|t| t.frames() as f64)
            .unwrap_or(0.0);
        let native_step = self
            .track
            .as_ref()
            .map(|t| t.sample_rate as f64 / self.engine_rate as f64)
            .unwrap_or(1.0);

        for s in 0..frames {
            if reset[s] >= 1.0 && self.last_reset < 1.0 {
                self.rearm();
            }
            self.last_reset = reset[s];

            if self.running {
                self.since_clock += 1.0;
            }
            if clock[s] >= 1.0 && self.last_clock < 1.0 && self.running {
                if self.seen_edge && self.since_clock <= MAX_INTERVAL_SECS * self.engine_rate {
                    self.interval = self.since_clock.max(2.0);
                } else if self.interval <= 0.0 && self.program.start_bpm > 0.0 {
                    self.interval =
                        (60.0 / self.program.start_bpm * self.engine_rate as f64) as f32;
                }
                // A transport stopped and started again keeps the beat it
                // last measured, so only the very first start of a
                // session leans on the seed.
                self.since_clock = 0.0;
                self.seen_edge = true;
                let ready = self.interval > 0.0 && clip_beats > 0.0;
                if !ready {
                    self.rearm();
                } else if self.started {
                    self.anchor += 1.0;
                    if looping && self.anchor >= loop_end {
                        // The seam: the pass starts over and nothing
                        // carries across it.
                        self.anchor -= loop_end - loop_start;
                        self.pos = self.anchor;
                        self.silence();
                        self.reindex();
                    }
                } else {
                    self.anchor = self.program.start_beat;
                    self.started = true;
                    self.pos = self.anchor;
                    self.reindex();
                }
            }
            self.last_clock = clock[s];

            if self.started && self.running && self.interval > 0.0 {
                self.pos = self.anchor + (self.since_clock as f64) / self.interval as f64;
            }

            // Copies the position has just entered take a voice.
            while self.started
                && self.running
                && self.next_copy < self.program.copies.len()
                && self.program.copies[self.next_copy] - lead_beats <= self.pos
            {
                let start = self.program.copies[self.next_copy];
                self.next_copy += 1;
                if self.pos >= start + clip_beats + tail_beats {
                    continue;
                }
                // A pool this small can only run out where clips are laid
                // closer than their bleed is long; the oldest voice is
                // the one whose material is furthest behind.
                let slot = self.voices.iter().position(|v| !v.active).unwrap_or(0);
                let v = &mut self.voices[slot];
                v.active = true;
                v.start = start;
                v.grains.reset();
            }

            let (mut dry_l, mut dry_r) = (0.0f32, 0.0f32);
            if let Some(track) = &self.track {
                let beat_frames = 60.0 / (bpm[s].max(1.0) as f64) * track.sample_rate as f64;
                // Output samples one beat takes, against what it would
                // take read at the clip's own rate: unity means the grid
                // is running at the tempo the clip was cut at.
                let natural = beat_frames / native_step;
                let stretched = self.interval as f64;
                let transparent =
                    stretched > 0.0 && (stretched / natural - 1.0).abs() < STRETCH_EPS;
                for v in &mut self.voices {
                    if !v.active {
                        continue;
                    }
                    let at = self.pos - v.start;
                    if at < -lead_beats || at >= clip_beats + tail_beats {
                        v.active = false;
                        v.grains.reset();
                        continue;
                    }
                    let head = at * beat_frames;
                    let mut read = |pos: f64, gain: f32| {
                        let gl = sample_at(&track.channels[0], pos);
                        let gr = if track.channels.len() > 1 {
                            sample_at(&track.channels[1], pos)
                        } else {
                            gl
                        };
                        // The bookends sit either side of the loop on the
                        // same timeline, so they read out of the very
                        // same position (see `ClipBleed`).
                        let (mut bl, mut br) = (0.0f32, 0.0f32);
                        if let Some(left) = &self.bleed.left {
                            let at = pos + left.frames() as f64;
                            bl += sample_at(&left.channels[0], at);
                            br += sample_at(left.channels.get(1).unwrap_or(&left.channels[0]), at);
                        }
                        if let Some(right) = &self.bleed.right {
                            let at = pos - clip_frames;
                            bl += sample_at(&right.channels[0], at);
                            br +=
                                sample_at(right.channels.get(1).unwrap_or(&right.channels[0]), at);
                        }
                        dry_l += (gl + bl) * gain;
                        dry_r += (gr + br) * gain;
                    };
                    if transparent {
                        read(head, 1.0);
                    } else {
                        let taps = v.grains.tick(head, native_step, &track.channels[0]);
                        for tap in taps.iter().flatten() {
                            read(tap.pos, tap.gain);
                        }
                    }
                }
            }

            // Wetness only means something when something came back: a
            // row with no rack behind it plays dry whatever the knob
            // says, the rule a deck's insert follows.
            let wet = if insert {
                wet_in[s].clamp(0.0, 1.0)
            } else {
                0.0
            };
            let ret_l = inputs[IN_RET_L][s] / SIGNAL_MAX;
            let ret_r = inputs[IN_RET_R][s] / SIGNAL_MAX;
            let mut l = dry_l * (1.0 - wet) + ret_l * wet;
            let mut r = dry_r * (1.0 - wet) + ret_r * wet;

            let automation = self.program.level_at(self.pos, &mut self.level_cursor) as f32;
            let gain = automation * level_in[s].max(0.0);
            l *= gain;
            r *= gain;
            // Balance, not constant power: dead centre is unity, which is
            // what an untouched row has always been.
            let pan = pan_in[s].clamp(-1.0, 1.0);
            l *= (1.0 - pan).min(1.0);
            r *= (1.0 + pan).min(1.0);

            outputs[OUT_AUDIO_L][s] = l * SIGNAL_MAX;
            outputs[OUT_AUDIO_R][s] = r * SIGNAL_MAX;
            outputs[OUT_SEND_L][s] = dry_l * SIGNAL_MAX;
            outputs[OUT_SEND_R][s] = dry_r * SIGNAL_MAX;
        }

        let playing = self.started && self.voices.iter().any(|v| v.active);
        self.shared.publish(self.pos, playing);
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(21);
        bytes.extend_from_slice(&self.anchor.to_le_bytes());
        bytes.extend_from_slice(&self.interval.to_le_bytes());
        bytes.push(self.started as u8);
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 13 {
            self.anchor = f64::from_le_bytes(bytes[..8].try_into().unwrap());
            self.pos = self.anchor;
            self.interval = f32::from_le_bytes(bytes[8..12].try_into().unwrap());
            self.started = bytes[12] != 0 && self.interval > 0.0;
            self.seen_edge = self.started;
            self.reindex();
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(seconds: f64, freq: f64) -> Arc<TrackData> {
        let rate = 48_000.0;
        let n = (seconds * rate) as usize;
        Arc::new(TrackData {
            channels: vec![(0..n)
                .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / rate).sin() as f32 * 0.5)
                .collect()],
            sample_rate: rate as f32,
        })
    }

    struct Harness {
        /// Kept alive: dropping the producer would close the ring.
        _tx: rtrb::Producer<GridTrackCmd>,
        m: GridTrackRtModule,
        frames: usize,
        pulse: usize,
    }

    impl Harness {
        /// A module fed a clock at `bpm`, rendered a block at a time.
        fn new(clip_secs: f64, program: GridTrackProgram) -> Self {
            let (mut tx, rx) = rtrb::RingBuffer::new(GRID_TRACK_QUEUE_CAP);
            let (garbage_tx, _g) = rtrb::RingBuffer::new(GRID_TRACK_QUEUE_CAP);
            let shared = Arc::new(GridTrackShared::default());
            let mut m = GridTrackRtModule::new(rx, garbage_tx, 48_000.0, shared);
            tx.push(GridTrackCmd::Load {
                audio: ClipAudio {
                    track: tone(clip_secs, 220.0),
                    bleed: ClipBleed::default(),
                },
            })
            .unwrap();
            tx.push(GridTrackCmd::Program(Arc::new(program))).unwrap();
            m.process(&Self::silent_inputs(64), &mut Self::outs(64), 0, 64);
            Harness {
                _tx: tx,
                m,
                frames: 64,
                pulse: 4,
            }
        }

        fn silent_inputs(frames: usize) -> Vec<Vec<f32>> {
            let mut v = vec![vec![0.0; frames]; 8];
            v[IN_BPM] = vec![120.0; frames];
            v[IN_LEVEL] = vec![1.0; frames];
            v[IN_WET] = vec![0.0; frames];
            v
        }

        fn outs(frames: usize) -> Vec<Vec<f32>> {
            vec![vec![0.0; frames]; 4]
        }

        /// Render `beats` beats at 120 BPM, returning peak |L| per beat.
        fn beats(&mut self, beats: usize) -> Vec<f32> {
            let spb = 24_000; // 120 BPM at 48 kHz
            let mut peaks = Vec::new();
            for _ in 0..beats {
                let mut peak = 0.0f32;
                let mut rendered = 0;
                while rendered < spb {
                    let frames = self.frames.min(spb - rendered);
                    let mut inputs = Self::silent_inputs(frames);
                    if rendered == 0 {
                        for v in inputs[IN_CLOCK].iter_mut().take(self.pulse.min(frames)) {
                            *v = 10.0;
                        }
                    }
                    let mut outputs = Self::outs(frames);
                    self.m.process(&inputs, &mut outputs, 0, frames);
                    for &v in &outputs[OUT_AUDIO_L][..frames] {
                        peak = peak.max(v.abs());
                    }
                    rendered += frames;
                }
                peaks.push(peak);
            }
            peaks
        }
    }

    #[test]
    fn a_copy_sounds_only_over_the_beats_it_is_laid_on() {
        // A two-beat clip laid at beat 2 of an eight-beat loop.
        let mut h = Harness::new(
            1.0,
            GridTrackProgram {
                copies: vec![2.0],
                clip_beats: 2.0,
                loop_end: 8.0,
                ..GridTrackProgram::default()
            },
        );
        let peaks = h.beats(9);
        // The first edge only measures: two are needed for a tempo, so
        // the transport's beat 0 is the harness's beat 1 (the Beat Clip
        // module's rule). The copy is therefore heard on harness beats
        // 3 and 4 — transport beats 2 and 3 — and nowhere else.
        for (i, p) in peaks.iter().enumerate() {
            let sounds = i == 3 || i == 4;
            assert_eq!(*p > 0.01, sounds, "beat {i} peak {p} of {peaks:?}");
        }
    }

    #[test]
    fn the_level_line_rides_the_row() {
        let mut h = Harness::new(
            1.0,
            GridTrackProgram {
                copies: vec![0.0, 2.0],
                levels: vec![
                    LevelPoint {
                        beat: 0.0,
                        level: 1.0,
                    },
                    LevelPoint {
                        beat: 2.0,
                        level: 0.25,
                    },
                ],
                clip_beats: 2.0,
                loop_end: 8.0,
                ..GridTrackProgram::default()
            },
        );
        let peaks = h.beats(5);
        // Harness beat 1 is transport beat 0, at unity; harness beat 3 is
        // transport beat 2, under the flat 0.25 tail of the line.
        assert!(peaks[1] > 4.0, "{peaks:?}");
        assert!(peaks[3] > 1.0 && peaks[3] < peaks[1] * 0.5, "{peaks:?}");
    }

    #[test]
    fn a_seeded_row_comes_in_on_the_transports_first_beat() {
        let mut h = Harness::new(
            1.0,
            GridTrackProgram {
                copies: vec![0.0],
                clip_beats: 2.0,
                loop_end: 4.0,
                start_bpm: 120.0,
                ..GridTrackProgram::default()
            },
        );
        let peaks = h.beats(3);
        assert!(peaks[0] > 0.01, "the first beat sounds: {peaks:?}");
        assert!(peaks[1] > 0.01, "and the second: {peaks:?}");
        assert!(peaks[2] < 0.01, "the copy is two beats long: {peaks:?}");
    }
    #[test]
    fn silence_without_a_program_or_a_clip() {
        let mut h = Harness::new(1.0, GridTrackProgram::default());
        assert!(h.beats(4).iter().all(|p| *p < 1e-6));
    }
}
