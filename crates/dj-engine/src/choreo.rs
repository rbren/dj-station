//! Built-in Choreography module: a beat-indexed multi-track timeline
//! (hundreds/thousands of beats — a full song) whose tracks each
//! materialize as output jacks.
//!
//! - Inputs: `clock` (a rising edge advances one beat), `reset` (re-arms so
//!   the next clock plays beat 0, phase-locking to the reset like the step
//!   sequencer).
//! - Outputs: dynamic, one per track (note tracks own two: note + velocity),
//!   drawn from `MAX_CHOREO_JACKS` preallocated slots like the MIDI
//!   modules. Jack ids are `t<slot>` (a note track also owns `t<slot+1>` for
//!   velocity) — stable across track renames and reorders, so persisted
//!   wires never break.
//! - Track kinds:
//!   - boolean: 0 or 10 V per beat.
//!   - continuous: -10..+10 V per beat, linearly interpolated toward the
//!     next beat's value using the measured clock interval.
//!   - note: monophonic per beat; the note jack holds the last played
//!     note's 1 V/oct voltage (0 V = C4 = MIDI 60), the velocity jack emits
//!     0..10 V while a note is active and 0 V otherwise (it doubles as the
//!     gate). Grid rows come from `octaves` x the selected scale above
//!     `base_note`.
//!
//! The RT side never touches [`ChoreoState`]: every control-side edit
//! compiles the state into an immutable [`ChoreoProgram`] (per-beat value
//! lanes — note voltages precomputed) and ships it through an SPSC ring as
//! an `Arc`, with replaced programs returned on a garbage ring for off-RT
//! drop (the playback module's track-handoff pattern).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;
use serde::{Deserialize, Serialize};

pub const CHOREO_ID: &str = "builtin.choreo";

/// Fixed output-jack budget (graph buffers are preallocated).
pub const MAX_CHOREO_JACKS: usize = 64;
/// Beats per timeline (a full song at fast tempos fits comfortably).
pub const MAX_CHOREO_BEATS: usize = 4096;

const IN_CLOCK: usize = 0;
const IN_RESET: usize = 1;
const GATE_V: f32 = 10.0;

/// Scales selectable on note tracks: display name -> semitone intervals
/// within one octave. The UI's row labels derive from the same table
/// (`CHOREO_SCALES` in app/src/components/ChoreoPanel.tsx, pinned by test).
pub const SCALES: &[(&str, &[u8])] = &[
    ("chromatic", &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    ("major", &[0, 2, 4, 5, 7, 9, 11]),
    ("minor", &[0, 2, 3, 5, 7, 8, 10]),
    ("harm minor", &[0, 2, 3, 5, 7, 8, 11]),
    ("penta maj", &[0, 2, 4, 7, 9]),
    ("penta min", &[0, 3, 5, 7, 10]),
    ("blues", &[0, 3, 5, 6, 7, 10]),
    ("dorian", &[0, 2, 3, 5, 7, 9, 10]),
    ("mixolydian", &[0, 2, 4, 5, 7, 9, 10]),
    ("whole tone", &[0, 2, 4, 6, 8, 10]),
];

pub fn scale_intervals(name: &str) -> Option<&'static [u8]> {
    SCALES.iter().find(|(n, _)| *n == name).map(|(_, iv)| *iv)
}

pub fn choreo_manifest() -> Manifest {
    let trig = |id: &str, name: &str| JackDecl {
        id: id.into(),
        name: name.into(),
        alias: None,
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
    Manifest {
        id: CHOREO_ID.into(),
        name: "Choreography".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::SEQUENCING.into(),
        deprecated: false,
        inputs: vec![trig("clock", "Clock"), trig("reset", "Reset")],
        // Output jacks are dynamic (allocated per track); the graph
        // preallocates MAX_CHOREO_JACKS output buffers.
        outputs: (0..MAX_CHOREO_JACKS)
            .map(|i| OutputDecl {
                id: format!("t{i}"),
                name: format!("Track {i}"),
                alias: None,
                display: None,
            })
            .collect(),
        params: vec![],
        ui: None,
        latency_samples: 0,
        bypass: Default::default(),
        presets: Default::default(),
    }
}

/// One note-track cell: at most one note per beat (no polyphony).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NoteStep {
    /// Grid row (0 = base note; row r = interval r % n, octave r / n).
    pub degree: u16,
    /// 0..1; scales the velocity jack's 0..10 V output.
    pub velocity: f32,
}

/// Kind-specific per-beat data of one track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChoreoTrackData {
    Boolean {
        steps: Vec<bool>,
    },
    Continuous {
        values: Vec<f32>,
    },
    Note {
        /// Grid height in octaves (1..=3).
        octaves: u8,
        /// Key into [`SCALES`].
        scale: String,
        /// MIDI note of degree 0 (60 = C4 = 0 V).
        base_note: u8,
        steps: Vec<Option<NoteStep>>,
    },
}

impl ChoreoTrackData {
    pub fn kind(&self) -> &'static str {
        match self {
            ChoreoTrackData::Boolean { .. } => "boolean",
            ChoreoTrackData::Continuous { .. } => "continuous",
            ChoreoTrackData::Note { .. } => "note",
        }
    }

    /// Output jacks this track owns (note tracks add a velocity jack).
    pub fn jack_count(&self) -> usize {
        match self {
            ChoreoTrackData::Note { .. } => 2,
            _ => 1,
        }
    }

    pub fn resize(&mut self, beats: usize) {
        match self {
            ChoreoTrackData::Boolean { steps } => steps.resize(beats, false),
            ChoreoTrackData::Continuous { values } => values.resize(beats, 0.0),
            ChoreoTrackData::Note { steps, .. } => steps.resize(beats, None),
        }
    }
}

/// One timeline track as persisted in the patch and shown in the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChoreoTrack {
    pub name: String,
    /// First output-jack slot; note tracks also own `jack + 1`. Stable
    /// across renames/reorders — persisted wires reference `t<jack>`.
    pub jack: usize,
    pub data: ChoreoTrackData,
}

/// Choreography module state, canonical on the control side and persisted
/// per instance in the patch (round-trips through save/load).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChoreoState {
    pub beats: usize,
    pub tracks: Vec<ChoreoTrack>,
}

impl Default for ChoreoState {
    fn default() -> Self {
        ChoreoState {
            beats: 16,
            tracks: Vec::new(),
        }
    }
}

/// 1 V/oct voltage of a note-grid cell (0 V = MIDI 60 = C4).
pub fn degree_to_volts(scale: &str, base_note: u8, degree: u16) -> f32 {
    let iv = scale_intervals(scale).unwrap_or(SCALES[0].1);
    let n = iv.len() as u16;
    let semis = iv[(degree % n) as usize] as i32 + 12 * (degree / n) as i32;
    (base_note as i32 - 60 + semis) as f32 / 12.0
}

impl ChoreoState {
    /// Compile to the RT program: one per-beat value lane per output jack.
    pub fn compile(&self) -> ChoreoProgram {
        let beats = self.beats.max(1);
        let mut lanes = Vec::new();
        for t in &self.tracks {
            match &t.data {
                ChoreoTrackData::Boolean { steps } => lanes.push(ProgramLane {
                    jack: t.jack as u16,
                    interpolate: false,
                    values: (0..beats)
                        .map(|b| {
                            if steps.get(b).copied().unwrap_or(false) {
                                GATE_V
                            } else {
                                0.0
                            }
                        })
                        .collect(),
                }),
                ChoreoTrackData::Continuous { values } => lanes.push(ProgramLane {
                    jack: t.jack as u16,
                    interpolate: true,
                    values: (0..beats)
                        .map(|b| values.get(b).copied().unwrap_or(0.0).clamp(-10.0, 10.0))
                        .collect(),
                }),
                ChoreoTrackData::Note {
                    octaves,
                    scale,
                    base_note,
                    steps,
                } => {
                    // Note lane holds the last played voltage; velocity
                    // lane doubles as the gate (0 V when no note).
                    let rows = scale_intervals(scale).unwrap_or(SCALES[0].1).len()
                        * (*octaves).max(1) as usize;
                    let mut note = Vec::with_capacity(beats);
                    let mut vel = Vec::with_capacity(beats);
                    let mut held = 0.0f32;
                    for b in 0..beats {
                        match steps.get(b).copied().flatten() {
                            Some(s) => {
                                let degree = s.degree.min(rows.saturating_sub(1) as u16);
                                held = degree_to_volts(scale, *base_note, degree);
                                note.push(held);
                                vel.push(s.velocity.clamp(0.0, 1.0) * GATE_V);
                            }
                            None => {
                                note.push(held);
                                vel.push(0.0);
                            }
                        }
                    }
                    lanes.push(ProgramLane {
                        jack: t.jack as u16,
                        interpolate: false,
                        values: note,
                    });
                    lanes.push(ProgramLane {
                        jack: (t.jack + 1) as u16,
                        interpolate: false,
                        values: vel,
                    });
                }
            }
        }
        ChoreoProgram {
            beats: beats as u32,
            lanes,
        }
    }
}

/// One output jack's per-beat values, precomputed control-side.
pub struct ProgramLane {
    pub jack: u16,
    /// Lerp toward the next beat's value across the beat (continuous
    /// tracks); others hold.
    pub interpolate: bool,
    pub values: Vec<f32>,
}

/// The compiled, immutable timeline the RT thread plays.
pub struct ChoreoProgram {
    pub beats: u32,
    pub lanes: Vec<ProgramLane>,
}

/// RT -> UI playhead (beat index; -1 until the first clock).
#[derive(Default)]
pub struct ChoreoShared {
    beat: AtomicI64,
}

impl ChoreoShared {
    pub fn beat(&self) -> i64 {
        self.beat.load(Ordering::Relaxed)
    }
}

/// Control-side plumbing for one Choreo node: pushes compiled programs to
/// the RT module and reclaims replaced ones for off-RT drop.
pub struct ChoreoControl {
    tx: rtrb::Producer<Arc<ChoreoProgram>>,
    garbage_rx: rtrb::Consumer<Arc<ChoreoProgram>>,
    pub shared: Arc<ChoreoShared>,
}

impl ChoreoControl {
    pub fn new(
        tx: rtrb::Producer<Arc<ChoreoProgram>>,
        garbage_rx: rtrb::Consumer<Arc<ChoreoProgram>>,
        shared: Arc<ChoreoShared>,
    ) -> Self {
        ChoreoControl {
            tx,
            garbage_rx,
            shared,
        }
    }

    pub fn push(&mut self, program: Arc<ChoreoProgram>) -> anyhow::Result<()> {
        while self.garbage_rx.pop().is_ok() {}
        self.tx
            .push(program)
            .map_err(|_| anyhow::anyhow!("too many pending choreography edits"))
    }
}

/// The RT-side choreography module: swaps in compiled programs from the
/// ring and renders lane values at the clocked beat position. Zero
/// allocations/locks on the RT thread (Arc swaps ship the old program back
/// on the garbage ring).
pub struct ChoreoRtModule {
    rx: rtrb::Consumer<Arc<ChoreoProgram>>,
    garbage_tx: rtrb::Producer<Arc<ChoreoProgram>>,
    program: Option<Arc<ChoreoProgram>>,
    shared: Arc<ChoreoShared>,
    beat: u32,
    /// True until the first clock after instantiation or a reset: the next
    /// clock plays beat 0 instead of advancing (step-sequencer convention).
    armed: bool,
    started: bool,
    last_clock: f32,
    last_reset: f32,
    /// Samples between the last two clock edges (drives interpolation).
    interval: f32,
    since_clock: f32,
    seen_interval: bool,
    pos_in_beat: f32,
    sample_rate: f32,
}

impl ChoreoRtModule {
    pub fn new(
        rx: rtrb::Consumer<Arc<ChoreoProgram>>,
        garbage_tx: rtrb::Producer<Arc<ChoreoProgram>>,
        shared: Arc<ChoreoShared>,
        sample_rate: f32,
    ) -> Self {
        ChoreoRtModule {
            rx,
            garbage_tx,
            program: None,
            shared,
            beat: 0,
            armed: true,
            started: false,
            last_clock: 0.0,
            last_reset: 0.0,
            interval: 0.0,
            since_clock: 0.0,
            seen_interval: false,
            pos_in_beat: 0.0,
            sample_rate: sample_rate.max(1.0),
        }
    }
}

impl HostModule for ChoreoRtModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        // Swap to the newest pending program (edits while running).
        while let Ok(p) = self.rx.pop() {
            if let Some(old) = self.program.replace(p) {
                // Off-RT drop; if the garbage ring is full, drop here
                // (bounded, edit-only path).
                let _ = self.garbage_tx.push(old);
            }
        }
        let Some(program) = self.program.as_ref() else {
            for out in outputs.iter_mut() {
                out[..frames].fill(0.0);
            }
            return;
        };
        let beats = program.beats.max(1);
        if self.beat >= beats {
            self.beat = beats - 1;
        }
        for out in outputs.iter_mut() {
            out[..frames].fill(0.0);
        }
        for s in 0..frames {
            let reset = inputs[IN_RESET][s];
            if reset >= 1.0 && self.last_reset < 1.0 {
                self.armed = true;
            }
            self.last_reset = reset;

            let clock = inputs[IN_CLOCK][s];
            self.since_clock += 1.0;
            if clock >= 1.0 && self.last_clock < 1.0 {
                if self.started && self.since_clock < 10.0 * self.sample_rate {
                    self.interval = self.since_clock.max(2.0);
                    self.seen_interval = true;
                }
                self.since_clock = 0.0;
                if self.armed {
                    self.armed = false;
                    self.beat = 0;
                } else {
                    self.beat = (self.beat + 1) % beats;
                }
                self.started = true;
                self.pos_in_beat = 0.0;
            }
            self.last_clock = clock;

            // Silent until the first clock (beat 0 hasn't played yet).
            if !self.started {
                continue;
            }
            let phase = if self.seen_interval && self.interval > 0.0 {
                (self.pos_in_beat / self.interval).min(1.0)
            } else {
                0.0
            };
            self.pos_in_beat += 1.0;

            let b = self.beat as usize;
            for lane in &program.lanes {
                let jack = lane.jack as usize;
                if jack >= outputs.len() || lane.values.is_empty() {
                    continue;
                }
                let v = lane.values[b.min(lane.values.len() - 1)];
                outputs[jack][s] = if lane.interpolate && phase > 0.0 {
                    let next = lane.values[(b + 1) % lane.values.len()];
                    v + (next - v) * phase
                } else {
                    v
                };
            }
        }
        self.shared.beat.store(
            if self.started { self.beat as i64 } else { -1 },
            Ordering::Relaxed,
        );
    }

    fn save_state(&mut self) -> Vec<u8> {
        self.beat.to_le_bytes().to_vec()
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if let Ok(b) = bytes.try_into() {
            self.beat = u32::from_le_bytes(b);
            self.started = true;
            self.armed = false;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
