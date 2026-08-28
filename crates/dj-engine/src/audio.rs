//! Built-in Audio module: plays any library track and emits a beat clock
//! at the tempo its BPM input is set to.
//!
//! - Inputs: `play` (switch; high plays, low pauses), `bpm` (clock tempo),
//!   `speed` (playback rate multiplier, 1 = the file's own rate), `loop`
//!   (switch, ON by default: the track repeats instead of ending).
//! - Outputs: `audio_l`, `audio_r` (mono files feed both) and `clock`, a
//!   10 ms trigger per beat at the `bpm` input's tempo.
//!
//! `bpm` and `speed` are ONE tempo in two units: the control side mirrors
//! every change of either onto the other, preserving `bpm / speed` — the
//! track's tempo at 1x (see `engine/audio_api.rs`). Loading a track resets
//! the pair (speed 1x, BPM = the track's library tempo), so the clock runs
//! in time with the audio and stays in time when either control is moved.
//! On the RT thread the two are independent per-sample reads — `speed`
//! drives the playhead, `bpm` drives the clock — so a wire into either
//! jack does exactly what its unit says.
//!
//! Decoding happens on the control thread (the [`crate::playback`]
//! pattern): tracks reach the RT module through an SPSC ring as
//! `Arc<TrackData>` and replaced ones travel back on a garbage ring for an
//! off-RT drop.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::graph::SIGNAL_MAX;
use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, DisplaySpec, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;
use crate::playback::TrackData;

pub const AUDIO_ID: &str = "builtin.audio";

/// Input jack indices (fixed: the manifest below is the only source).
pub(crate) const IN_PLAY: usize = 0;
pub(crate) const IN_BPM: usize = 1;
pub(crate) const IN_SPEED: usize = 2;
pub(crate) const IN_LOOP: usize = 3;

const OUT_AUDIO_L: usize = 0;
const OUT_AUDIO_R: usize = 1;
const OUT_CLOCK: usize = 2;

/// Tempo the BPM input starts at, and the tempo a track whose BPM the
/// library doesn't know is assumed to play at.
pub const DEFAULT_BPM: f32 = 120.0;
/// Clock trigger width in seconds (gate high = 10 V per PRD §4).
const CLOCK_PULSE_SECS: f32 = 0.010;

pub fn audio_manifest() -> Manifest {
    Manifest {
        id: AUDIO_ID.into(),
        name: "Audio".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        inputs: vec![
            JackDecl {
                id: "play".into(),
                name: "Play".into(),
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
                id: "bpm".into(),
                name: "BPM".into(),
                default: DEFAULT_BPM,
                audio: false,
                capture: false,
                knob: Some(KnobConfig {
                    style: KnobStyle::Continuous,
                    min: 20.0,
                    max: 300.0,
                    curve: Curve::Linear,
                    steps: None,
                }),
                display: Some(DisplaySpec {
                    unit: Some("BPM".into()),
                    ..DisplaySpec::default()
                }),
            },
            JackDecl {
                id: "speed".into(),
                name: "Speed".into(),
                default: 1.0,
                audio: false,
                capture: false,
                // Geometric: half speed and double speed sit the same
                // distance from 1x, which lands exactly mid-travel.
                knob: Some(KnobConfig {
                    style: KnobStyle::Continuous,
                    min: 0.25,
                    max: 4.0,
                    curve: Curve::Exp,
                    steps: None,
                }),
                display: Some(DisplaySpec {
                    unit: Some("x".into()),
                    ..DisplaySpec::default()
                }),
            },
            JackDecl {
                id: "loop".into(),
                name: "Loop".into(),
                // High by default: a loaded track repeats until you say
                // otherwise, so the module is useful the moment it plays.
                default: SIGNAL_MAX,
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
            OutputDecl {
                id: "clock".into(),
                name: "Clock".into(),
                display: None,
            },
        ],
        params: vec![],
        ui: None,
        latency_samples: 0,
    }
}

/// Transport state the RT module publishes once per block for the panel's
/// playhead: where the audible position is, how fast it moves and whether
/// it moves at all. f64s are stored as bit patterns (same trick as
/// [`crate::deck::DeckShared`]); may lag the audio by one block.
#[derive(Debug)]
pub struct AudioShared {
    pos_secs: AtomicU64,
    /// Track seconds advanced per output second (the `speed` input as the
    /// RT thread actually read it — knob or wire).
    rate: AtomicU64,
    playing: AtomicBool,
}

impl Default for AudioShared {
    fn default() -> Self {
        AudioShared {
            pos_secs: AtomicU64::new(0.0f64.to_bits()),
            rate: AtomicU64::new(1.0f64.to_bits()),
            playing: AtomicBool::new(false),
        }
    }
}

impl AudioShared {
    fn publish(&self, pos_secs: f64, rate: f64, playing: bool) {
        self.pos_secs.store(pos_secs.to_bits(), Ordering::Relaxed);
        self.rate.store(rate.to_bits(), Ordering::Relaxed);
        self.playing.store(playing, Ordering::Relaxed);
    }

    pub fn position_secs(&self) -> f64 {
        f64::from_bits(self.pos_secs.load(Ordering::Relaxed))
    }
    pub fn rate(&self) -> f64 {
        f64::from_bits(self.rate.load(Ordering::Relaxed))
    }
    pub fn playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }
}

/// Control-side state per Audio node: the track handoff ring, the garbage
/// return, the decoded track (duration + waveform peaks for the panel) and
/// the transport the RT module publishes.
pub struct AudioControl {
    pub tx: rtrb::Producer<Arc<TrackData>>,
    pub garbage_rx: rtrb::Consumer<Arc<TrackData>>,
    pub track: Option<Arc<TrackData>>,
    pub shared: Arc<AudioShared>,
}

/// Snapshot of an Audio node for UIs (serialized over IPC).
#[derive(Debug, Clone, Serialize)]
pub struct AudioStatus {
    pub track: Option<String>,
    pub duration_secs: f64,
    /// Audible position in track seconds, as of the last processed block.
    pub position_secs: f64,
    /// Track seconds per output second — what the playhead moves at.
    pub rate: f64,
    /// Audio is actually advancing (track loaded, play high, not ended).
    pub playing: bool,
    /// Clock tempo the BPM input is set to.
    pub bpm: f64,
    /// Playback rate multiplier the speed input is set to.
    pub speed: f64,
    /// Loop switch position (knob only — a wired jack is RT state).
    pub looping: bool,
}

/// The RT-side Audio module. Never allocates or blocks: tracks arrive over
/// an SPSC ring and replaced ones leave on the garbage ring (a full ring
/// drops here — bounded, load-only, mirroring [`crate::playback`]).
pub struct AudioModule {
    rx: rtrb::Consumer<Arc<TrackData>>,
    garbage_tx: rtrb::Producer<Arc<TrackData>>,
    track: Option<Arc<TrackData>>,
    engine_rate: f32,
    /// Playback position in source frames (fractional).
    pos: f64,
    /// Reached the end of the track (silent until play is re-triggered).
    ended: bool,
    prev_play_high: bool,
    /// Beat phase in 0..1; wrapping emits a clock trigger.
    clock_phase: f64,
    /// Samples of clock trigger still to emit.
    pulse_left: u32,
    pulse_samples: u32,
    shared: Arc<AudioShared>,
}

impl AudioModule {
    pub fn new(
        rx: rtrb::Consumer<Arc<TrackData>>,
        garbage_tx: rtrb::Producer<Arc<TrackData>>,
        engine_rate: f32,
        shared: Arc<AudioShared>,
    ) -> Self {
        AudioModule {
            rx,
            garbage_tx,
            track: None,
            engine_rate,
            pos: 0.0,
            ended: false,
            prev_play_high: false,
            clock_phase: 0.0,
            pulse_left: 0,
            pulse_samples: (CLOCK_PULSE_SECS * engine_rate).max(1.0) as u32,
            shared,
        }
    }

    /// Put the clock on beat one and fire its trigger — the audio is about
    /// to start from a known point (track load or play), and a clock that
    /// runs with the music has to start with it.
    fn restart_clock(&mut self) {
        self.clock_phase = 0.0;
        self.pulse_left = self.pulse_samples;
    }

    #[inline]
    fn sample_at(chan: &[f32], pos: f64) -> f32 {
        let i0 = pos as usize;
        let frac = (pos - i0 as f64) as f32;
        if frac == 0.0 || i0 + 1 >= chan.len() {
            chan[i0.min(chan.len() - 1)]
        } else {
            chan[i0] * (1.0 - frac) + chan[i0 + 1] * frac
        }
    }
}

impl HostModule for AudioModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        // Pick up newly loaded tracks (latest wins).
        let mut loaded = false;
        while let Ok(t) = self.rx.pop() {
            if let Some(old) = self.track.replace(t) {
                let _ = self.garbage_tx.push(old);
            }
            loaded = true;
        }
        if loaded {
            self.pos = 0.0;
            self.ended = false;
            self.restart_clock();
        }

        let play = &inputs[IN_PLAY];
        let bpm = &inputs[IN_BPM];
        let speed = &inputs[IN_SPEED];
        let looping = &inputs[IN_LOOP];
        for s in 0..frames {
            let play_high = play[s] >= 1.0;
            if play_high && !self.prev_play_high {
                if self.ended {
                    self.pos = 0.0;
                    self.ended = false;
                }
                self.restart_clock();
            }
            self.prev_play_high = play_high;

            // Handle the end of a pass BEFORE reading, so the first sample
            // of the next one — and the clock trigger marking it — land on
            // the same frame.
            if play_high && !self.ended {
                if let Some(track) = &self.track {
                    let n = track.frames() as f64;
                    if n <= 0.0 {
                        self.ended = true;
                    } else if self.pos >= n {
                        if looping[s] >= 1.0 {
                            // Back to the top, keeping the sub-sample
                            // remainder so the loop doesn't drift.
                            self.pos %= n;
                            self.restart_clock();
                        } else {
                            self.ended = true;
                        }
                    }
                }
            }

            let (l, r) = match &self.track {
                Some(track) if play_high && !self.ended => {
                    let l = Self::sample_at(&track.channels[0], self.pos);
                    let r = if track.channels.len() > 1 {
                        Self::sample_at(&track.channels[1], self.pos)
                    } else {
                        l
                    };
                    // Speed is a plain multiplier of the file's own rate;
                    // sample-rate conversion folds into the increment.
                    self.pos += (track.sample_rate as f64 / self.engine_rate as f64)
                        * speed[s].max(0.0) as f64;
                    (l, r)
                }
                _ => (0.0, 0.0),
            };
            outputs[OUT_AUDIO_L][s] = l * SIGNAL_MAX;
            outputs[OUT_AUDIO_R][s] = r * SIGNAL_MAX;

            // The clock is free-running: it keeps time while the track is
            // paused or finished, so sequencers stay locked to the tempo.
            self.clock_phase += bpm[s].max(0.0) as f64 / 60.0 / self.engine_rate as f64;
            if self.clock_phase >= 1.0 {
                self.clock_phase -= self.clock_phase.floor();
                self.pulse_left = self.pulse_samples;
            }
            outputs[OUT_CLOCK][s] = if self.pulse_left > 0 {
                self.pulse_left -= 1;
                SIGNAL_MAX
            } else {
                0.0
            };
        }

        // One publish per block for the panel's playhead: the position we
        // just reached plus the rate to extrapolate it with (the last
        // sample's speed — a block is 3 ms of control movement).
        let (pos_secs, rate) = match &self.track {
            Some(track) => (
                self.pos / track.sample_rate as f64,
                speed[..frames]
                    .last()
                    .map(|v| v.max(0.0) as f64)
                    .unwrap_or(0.0),
            ),
            None => (0.0, 0.0),
        };
        let playing = self.track.is_some() && self.prev_play_high && !self.ended;
        self.shared.publish(pos_secs, rate, playing);
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(17);
        bytes.extend_from_slice(&self.pos.to_le_bytes());
        bytes.extend_from_slice(&self.clock_phase.to_le_bytes());
        bytes.push(self.ended as u8);
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 17 {
            self.pos = f64::from_le_bytes(bytes[..8].try_into().unwrap());
            self.clock_phase = f64::from_le_bytes(bytes[8..16].try_into().unwrap());
            self.ended = bytes[16] != 0;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
