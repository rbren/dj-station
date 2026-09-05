//! Built-in Clock module (`builtin.clock`): the transport every clocked
//! module in a patch can hang off — a tempo, a run switch, and a beat
//! position the module owns.
//!
//! - Inputs: `bpm` (the tempo, also a knob), `run` (high runs the clock),
//!   `reset` (a rising edge parks it back on its start beat).
//! - Outputs: `clock` (one pulse per beat), `reset` (one pulse when the
//!   transport starts, so everything downstream parks together) and
//!   `phase` (0..10 V ramp across the current beat).
//!
//! THE CLOCK OWNS THE BEAT POSITION, which is what separates it from a
//! plain pulse generator: it counts beats from `start_beat`, optionally
//! wraps at `loop_beats` (the Grid's play range), and can read its tempo
//! off a BREAKPOINT LANE indexed by that position rather than off the
//! `bpm` input. A tempo ramp written over beats therefore plays as an
//! integral — the same arithmetic the Grid page draws (`app/src/grid.ts`
//! `bpmAt`) — instead of a stack of fixed-tempo renders.
//!
//! The lane, the loop and the start beat are a [`ClockProgram`]: the
//! control side compiles one and ships it over an SPSC ring as an `Arc`,
//! with replaced programs returned on a garbage ring for an off-RT drop
//! (the choreo/playback handoff pattern). The RT side never reads
//! control-side state.
//!
//! The transport can be driven two ways and they agree: the `run`/`reset`
//! JACKS (so a clock is patchable like any other module) and
//! [`crate::Engine::clock_transport`] (so a page's transport buttons do
//! not have to fake edges). Either one starting the clock emits the
//! `reset` pulse.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::graph::SIGNAL_MAX;
use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, DisplaySpec, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;

pub const CLOCK_ID: &str = "builtin.clock";

pub const MIN_BPM: f32 = 20.0;
pub const MAX_BPM: f32 = 300.0;

pub(crate) const IN_BPM: usize = 0;
const IN_RUN: usize = 1;
const IN_RESET: usize = 2;

const OUT_CLOCK: usize = 0;
const OUT_RESET: usize = 1;
const OUT_PHASE: usize = 2;

/// Pulse width, in seconds — the Decks bank's, so a clip module reads the
/// two clocks the same way.
const PULSE_SECS: f32 = 0.001;

/// How many commands may be in flight to one clock node.
pub const CLOCK_QUEUE_CAP: usize = 64;

/// One breakpoint of the tempo lane: the tempo in force from `beat`,
/// ramped linearly to the next point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TempoPoint {
    pub beat: f64,
    pub bpm: f64,
}

/// What the clock runs: its tempo lane (empty = the `bpm` input alone),
/// the beat a start parks on, and the loop it wraps in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClockProgram {
    /// Sorted by beat. Outside the ends the end values hold, exactly like
    /// the Grid page's tempo lane.
    #[serde(default)]
    pub points: Vec<TempoPoint>,
    /// Where a start (or a `reset` edge) parks the position.
    #[serde(default)]
    pub start_beat: f64,
    /// The beat the loop runs back to. Beats are ABSOLUTE — a Grid page
    /// counts columns from the start of its arrangement, not from
    /// wherever its play range happens to begin — so a range is a pair.
    #[serde(default)]
    pub loop_start: f64,
    /// The beat the loop ends on; `loop_end <= loop_start` free-runs.
    #[serde(default)]
    pub loop_end: f64,
    /// Wrap at `loop_end` (true) or stop there (false).
    #[serde(default)]
    pub looping: bool,
}

impl Default for ClockProgram {
    fn default() -> Self {
        ClockProgram {
            points: Vec::new(),
            start_beat: 0.0,
            loop_start: 0.0,
            loop_end: 0.0,
            looping: true,
        }
    }
}

impl ClockProgram {
    /// The tempo at `beat`: the lane where it has points, otherwise
    /// `fallback` (the `bpm` input). Mirrors `bpmAt` in `app/src/grid.ts`.
    #[inline]
    pub fn bpm_at(&self, beat: f64, fallback: f64) -> f64 {
        let pts = &self.points;
        if pts.is_empty() {
            return fallback;
        }
        if beat <= pts[0].beat {
            return pts[0].bpm;
        }
        let last = pts[pts.len() - 1];
        if beat >= last.beat {
            return last.bpm;
        }
        for w in pts.windows(2) {
            let (a, b) = (w[0], w[1]);
            if beat <= b.beat {
                let span = b.beat - a.beat;
                if span <= 0.0 {
                    return b.bpm;
                }
                return a.bpm + (b.bpm - a.bpm) * (beat - a.beat) / span;
            }
        }
        last.bpm
    }
}

/// Commands from the control thread, applied at a block boundary.
pub enum ClockCmd {
    Program(Arc<ClockProgram>),
    /// Run or hold the clock. `restart` parks the position on the
    /// program's start beat first and emits the `reset` pulse — the
    /// difference between play-from-the-top and resume.
    Transport {
        running: bool,
        restart: bool,
    },
}

/// What the RT module publishes once per block: where the transport is.
#[derive(Debug, Default)]
pub struct ClockShared {
    beat: AtomicU64,
    bpm: AtomicU64,
    running: AtomicBool,
}

impl ClockShared {
    fn publish(&self, beat: f64, bpm: f64, running: bool) {
        self.beat.store(beat.to_bits(), Ordering::Relaxed);
        self.bpm.store(bpm.to_bits(), Ordering::Relaxed);
        self.running.store(running, Ordering::Relaxed);
    }

    /// Fractional beat position as of the last processed block.
    pub fn beat(&self) -> f64 {
        f64::from_bits(self.beat.load(Ordering::Relaxed))
    }
    pub fn bpm(&self) -> f64 {
        f64::from_bits(self.bpm.load(Ordering::Relaxed))
    }
    pub fn running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }
}

/// Control-side state per Clock node.
pub struct ClockControl {
    pub tx: rtrb::Producer<ClockCmd>,
    pub garbage_rx: rtrb::Consumer<Arc<ClockProgram>>,
    pub shared: Arc<ClockShared>,
    /// The program the node is running (the control thread's own clone).
    pub program: Arc<ClockProgram>,
    /// Whether the transport has been told to run. Transport, not patch
    /// state: a clock is created stopped.
    pub running: bool,
}

impl ClockControl {
    pub fn new(
        tx: rtrb::Producer<ClockCmd>,
        garbage_rx: rtrb::Consumer<Arc<ClockProgram>>,
        shared: Arc<ClockShared>,
    ) -> Self {
        ClockControl {
            tx,
            garbage_rx,
            shared,
            program: Arc::new(ClockProgram::default()),
            running: false,
        }
    }
}

/// Snapshot of a Clock node for UIs (serialized over IPC).
#[derive(Debug, Clone, Serialize)]
pub struct ClockStatus {
    /// Fractional beat position, as of the RT thread's last block.
    pub beat: f64,
    /// The tempo it is running at right now (lane value where there is
    /// one).
    pub bpm: f64,
    pub running: bool,
}

pub fn clock_manifest() -> Manifest {
    Manifest {
        id: CLOCK_ID.into(),
        name: "Clock".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::SEQUENCING.into(),
        deprecated: false,
        inputs: vec![
            JackDecl {
                id: "bpm".into(),
                name: "BPM".into(),
                alias: None,
                default: 120.0,
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
                id: "run".into(),
                name: "Run".into(),
                alias: None,
                default: 0.0,
                audio: false,
                capture: false,
                knob: Some(KnobConfig {
                    style: KnobStyle::Switch,
                    min: 0.0,
                    max: 10.0,
                    curve: Curve::Linear,
                    steps: None,
                }),
                display: None,
            },
            JackDecl {
                id: "reset".into(),
                name: "Reset".into(),
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
            },
        ],
        outputs: vec![
            OutputDecl {
                id: "clock".into(),
                name: "Clock".into(),
                alias: None,
                display: None,
            },
            OutputDecl {
                id: "reset".into(),
                name: "Reset".into(),
                alias: None,
                display: None,
            },
            OutputDecl {
                id: "phase".into(),
                name: "Phase".into(),
                alias: None,
                display: None,
            },
        ],
        params: vec![],
        ui: None,
        latency_samples: 0,
        bypass: Default::default(),
        presets: Default::default(),
    }
}

/// The RT-side Clock. Never allocates: programs arrive over an SPSC ring
/// and replaced ones leave on the garbage ring.
pub struct ClockRtModule {
    rx: rtrb::Consumer<ClockCmd>,
    garbage_tx: rtrb::Producer<Arc<ClockProgram>>,
    program: Arc<ClockProgram>,
    engine_rate: f32,
    /// Fractional beat position of the transport.
    pos: f64,
    /// Told to run by the API (the `run` jack is ORed with this).
    run_cmd: bool,
    running: bool,
    last_run_in: f32,
    last_reset_in: f32,
    /// Samples of pulse left to hold on each pulse output.
    clock_left: u32,
    reset_left: u32,
    pulse_len: u32,
    shared: Arc<ClockShared>,
}

impl ClockRtModule {
    pub fn new(
        rx: rtrb::Consumer<ClockCmd>,
        garbage_tx: rtrb::Producer<Arc<ClockProgram>>,
        engine_rate: f32,
        shared: Arc<ClockShared>,
    ) -> Self {
        let rate = engine_rate.max(1.0);
        ClockRtModule {
            rx,
            garbage_tx,
            program: Arc::new(ClockProgram::default()),
            engine_rate: rate,
            pos: 0.0,
            run_cmd: false,
            running: false,
            last_run_in: 0.0,
            last_reset_in: 0.0,
            clock_left: 0,
            reset_left: 0,
            pulse_len: ((rate * PULSE_SECS) as u32).max(1),
            shared,
        }
    }

    /// Park on the start beat and announce it: the beat the transport
    /// resumes from is a beat boundary, so the clock pulses there too and
    /// everything downstream comes in together.
    fn restart(&mut self) {
        self.pos = self.program.start_beat;
        self.clock_left = self.pulse_len;
        self.reset_left = self.pulse_len;
    }
}

impl HostModule for ClockRtModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        while let Ok(cmd) = self.rx.pop() {
            match cmd {
                ClockCmd::Program(p) => {
                    let old = std::mem::replace(&mut self.program, p);
                    let _ = self.garbage_tx.push(old);
                }
                ClockCmd::Transport { running, restart } => {
                    self.run_cmd = running;
                    if restart {
                        self.restart();
                    }
                }
            }
        }

        let bpm_in = &inputs[IN_BPM];
        let run_in = &inputs[IN_RUN];
        let reset_in = &inputs[IN_RESET];
        let (loop_start, loop_end) = (self.program.loop_start, self.program.loop_end);
        let looping = loop_end > loop_start;
        for s in 0..frames {
            if reset_in[s] >= 1.0 && self.last_reset_in < 1.0 {
                self.restart();
            }
            self.last_reset_in = reset_in[s];
            let run_edge = run_in[s] >= 1.0 && self.last_run_in < 1.0;
            self.last_run_in = run_in[s];
            if run_edge {
                self.restart();
            }
            let want_run = self.run_cmd || run_in[s] >= 1.0;
            if want_run && !self.running {
                // Started by the API without a restart (resume): the beat
                // it comes in on is still a boundary for the followers.
                self.clock_left = self.pulse_len;
                self.reset_left = self.pulse_len;
            }
            self.running = want_run;

            let fallback = bpm_in[s].clamp(MIN_BPM, MAX_BPM) as f64;
            let bpm = self
                .program
                .bpm_at(self.pos, fallback)
                .clamp(MIN_BPM as f64, MAX_BPM as f64);
            if self.running {
                let before = self.pos;
                self.pos += bpm / 60.0 / self.engine_rate as f64;
                if looping && self.pos >= loop_end {
                    if self.program.looping {
                        self.pos -= loop_end - loop_start;
                        // The wrap lands ON a beat of the loop, so the
                        // pass after it comes in with a pulse of its own.
                        self.clock_left = self.pulse_len;
                    } else {
                        self.pos = loop_end;
                        self.running = false;
                        self.run_cmd = false;
                    }
                } else if self.pos.floor() > before.floor() {
                    self.clock_left = self.pulse_len;
                }
            }

            outputs[OUT_CLOCK][s] = if self.clock_left > 0 {
                self.clock_left -= 1;
                SIGNAL_MAX
            } else {
                0.0
            };
            outputs[OUT_RESET][s] = if self.reset_left > 0 {
                self.reset_left -= 1;
                SIGNAL_MAX
            } else {
                0.0
            };
            let phase = self.pos - self.pos.floor();
            outputs[OUT_PHASE][s] = (phase as f32) * SIGNAL_MAX;
        }

        let bpm = self.program.bpm_at(
            self.pos,
            bpm_in[frames.saturating_sub(1)].clamp(MIN_BPM, MAX_BPM) as f64,
        );
        self.shared.publish(self.pos, bpm, self.running);
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(9);
        bytes.extend_from_slice(&self.pos.to_le_bytes());
        bytes.push(self.run_cmd as u8);
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 9 {
            self.pos = f64::from_le_bytes(bytes[..8].try_into().unwrap());
            self.run_cmd = bytes[8] != 0;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module(rate: f32) -> (rtrb::Producer<ClockCmd>, ClockRtModule, Arc<ClockShared>) {
        let (tx, rx) = rtrb::RingBuffer::new(CLOCK_QUEUE_CAP);
        let (garbage_tx, _garbage_rx) = rtrb::RingBuffer::new(CLOCK_QUEUE_CAP);
        let shared = Arc::new(ClockShared::default());
        (
            tx,
            ClockRtModule::new(rx, garbage_tx, rate, shared.clone()),
            shared,
        )
    }

    /// Run `blocks` blocks of `frames` at `bpm` and count the clock pulses.
    fn run(m: &mut ClockRtModule, bpm: f32, frames: usize, blocks: usize) -> usize {
        let inputs = vec![vec![bpm; frames], vec![0.0; frames], vec![0.0; frames]];
        let mut outputs = vec![vec![0.0; frames], vec![0.0; frames], vec![0.0; frames]];
        let mut edges = 0;
        let mut last = 0.0;
        for _ in 0..blocks {
            m.process(&inputs, &mut outputs, 0, frames);
            for &v in &outputs[0][..frames] {
                if v >= 1.0 && last < 1.0 {
                    edges += 1;
                }
                last = v;
            }
        }
        edges
    }

    #[test]
    fn stopped_clock_is_silent_and_running_one_pulses_per_beat() {
        let (mut tx, mut m, shared) = module(48_000.0);
        assert_eq!(run(&mut m, 120.0, 480, 100), 0, "a stopped clock is silent");
        assert!(!shared.running());

        tx.push(ClockCmd::Transport {
            running: true,
            restart: true,
        })
        .unwrap();
        // One second at 120 BPM is two beats; the start pulses too.
        let edges = run(&mut m, 120.0, 480, 100);
        assert_eq!(edges, 3);
        assert!((shared.beat() - 2.0).abs() < 1e-6, "beat {}", shared.beat());
    }

    #[test]
    fn the_tempo_lane_overrides_the_bpm_input() {
        let (mut tx, mut m, shared) = module(48_000.0);
        tx.push(ClockCmd::Program(Arc::new(ClockProgram {
            points: vec![
                TempoPoint {
                    beat: 0.0,
                    bpm: 240.0,
                },
                TempoPoint {
                    beat: 8.0,
                    bpm: 240.0,
                },
            ],
            ..ClockProgram::default()
        })))
        .unwrap();
        tx.push(ClockCmd::Transport {
            running: true,
            restart: true,
        })
        .unwrap();
        // 240 BPM is four beats a second, whatever the input says.
        assert_eq!(run(&mut m, 60.0, 480, 100), 5);
        assert!((shared.bpm() - 240.0).abs() < 1e-9);
    }

    #[test]
    fn a_loop_wraps_and_a_one_shot_stops() {
        let (mut tx, mut m, shared) = module(48_000.0);
        tx.push(ClockCmd::Program(Arc::new(ClockProgram {
            loop_end: 4.0,
            looping: true,
            ..ClockProgram::default()
        })))
        .unwrap();
        tx.push(ClockCmd::Transport {
            running: true,
            restart: true,
        })
        .unwrap();
        // Three seconds at 120 BPM = six beats over a four-beat loop.
        run(&mut m, 120.0, 480, 300);
        assert!((shared.beat() - 2.0).abs() < 1e-6, "beat {}", shared.beat());

        let (mut tx, mut m, shared) = module(48_000.0);
        tx.push(ClockCmd::Program(Arc::new(ClockProgram {
            loop_end: 4.0,
            looping: false,
            ..ClockProgram::default()
        })))
        .unwrap();
        tx.push(ClockCmd::Transport {
            running: true,
            restart: true,
        })
        .unwrap();
        run(&mut m, 120.0, 480, 300);
        assert!(!shared.running(), "a one-shot stops at the end");
        assert!((shared.beat() - 4.0).abs() < 1e-9);
    }
}
