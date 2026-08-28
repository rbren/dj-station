//! Built-in Beat Clip module: a clip built in the Beatify tab, played in
//! the rack at whatever tempo its clock runs at.
//!
//! - Inputs: `clock` (a rising edge is a beat), `reset` (re-arms, so the
//!   next clock plays beat 0), `bpm` (the tempo the clip's audio was
//!   rendered at — the project's, written by the loader).
//! - Outputs: `audio_l`, `audio_r` (mono clips feed both).
//!
//! THE CLOCK OWNS BOTH TEMPO AND PHASE. The interval between the last two
//! edges is the beat: the playhead advances by one clip beat per interval
//! (so a clock at twice the clip's own tempo plays it twice as fast), and
//! every edge re-anchors the playhead onto that beat's boundary. A clip is
//! therefore never heard starting between ticks — a four-beat clip laid
//! against a four-beat bar comes back around exactly on the downbeat.
//!
//! NOTHING IS HEARD UNTIL TWO EDGES HAVE BEEN MEASURED: one edge gives
//! phase but no tempo, and a clip that started before the speed was known
//! would have to lurch onto it. So the first edge only arms; the second —
//! the one that says how long a beat is — plays beat 0. A reset (or a new
//! clip) parks the module at beat 0 and silences it until the next edge,
//! the same convention [`crate::choreo`] uses; it does NOT forget the
//! tempo, so a running clock restarts the clip immediately.
//!
//! The tempo change is a STRETCH, not a speed-up: [`crate::stretch`] reads
//! grains at the clip's own rate around a playhead that moves at the
//! clock's, so a clip played faster keeps its pitch. Same machinery as the
//! deck's keylock.
//!
//! What the patch keeps is the BINDING ([`BeatClipRef`]: which project,
//! which clip), never the audio — a clip is placements, not a file (see
//! `app/src-tauri/src/beatify_clip.rs`), so the app re-assembles it after
//! a patch load and hands the samples over the same SPSC ring the Audio
//! module uses.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use crate::graph::SIGNAL_MAX;
use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, DisplaySpec, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;
use crate::playback::TrackData;
use crate::stretch::{sample_at, GrainStretch};

pub const BEAT_CLIP_ID: &str = "builtin.beat_clip";

pub(crate) const IN_CLOCK: usize = 0;
pub(crate) const IN_RESET: usize = 1;
pub(crate) const IN_BPM: usize = 2;

const OUT_AUDIO_L: usize = 0;
const OUT_AUDIO_R: usize = 1;

/// Tempo the BPM input starts at, before a clip declares its own.
pub const DEFAULT_BPM: f32 = 120.0;

/// A clock edge this far apart is a new start, not a tempo: without the
/// guard, arming a patch minutes after the last edge would stretch one
/// clip beat over the whole gap.
const MAX_INTERVAL_SECS: f32 = 10.0;

/// Which clip a Beat Clip module plays: the Beatify project and the clip
/// inside it. This — not the audio — is what a patch persists, so a saved
/// patch reloads the clip as it now stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeatClipRef {
    /// Beatify project id (`p3`).
    pub project: String,
    /// Clip id within that project (`clips.json`).
    pub clip: String,
    /// The clip's name when it was bound — display only.
    #[serde(default)]
    pub name: String,
    /// The Beatify project the clip was cut in, by name — display only,
    /// like `name`: a deck says where its clip came from, and two decks
    /// holding an "intro" each are told apart by it.
    #[serde(default)]
    pub project_name: String,
    /// Which parts of a track the clip is made of ("drums", "bass", …),
    /// as it was when bound — display only, like the name. Empty for a
    /// patch saved before clips said, and re-filled on the next load.
    #[serde(default)]
    pub stems: Vec<String>,
}

pub fn beat_clip_manifest() -> Manifest {
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
    Manifest {
        id: BEAT_CLIP_ID.into(),
        name: "Beat Clip".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        inputs: vec![
            trig("clock", "Clock"),
            trig("reset", "Reset"),
            JackDecl {
                id: "bpm".into(),
                name: "Clip BPM".into(),
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
        params: vec![],
        ui: None,
        latency_samples: 0,
        bypass: Default::default(),
    }
}

/// What the RT module publishes once per block for the panel: where the
/// playhead is, which beat it is on (-1 = waiting for a clock), and the
/// tempo the clock is running at (0 = not known yet). f64s ride as bit
/// patterns, like [`crate::audio::AudioShared`].
#[derive(Debug, Default)]
pub struct BeatClipShared {
    pos_secs: AtomicU64,
    clock_bpm: AtomicU64,
    beat: AtomicI64,
    playing: AtomicBool,
}

impl BeatClipShared {
    fn publish(&self, pos_secs: f64, clock_bpm: f64, beat: i64, playing: bool) {
        self.pos_secs.store(pos_secs.to_bits(), Ordering::Relaxed);
        self.clock_bpm.store(clock_bpm.to_bits(), Ordering::Relaxed);
        self.beat.store(beat, Ordering::Relaxed);
        self.playing.store(playing, Ordering::Relaxed);
    }

    pub fn position_secs(&self) -> f64 {
        f64::from_bits(self.pos_secs.load(Ordering::Relaxed))
    }
    pub fn clock_bpm(&self) -> f64 {
        f64::from_bits(self.clock_bpm.load(Ordering::Relaxed))
    }
    pub fn beat(&self) -> i64 {
        self.beat.load(Ordering::Relaxed)
    }
    pub fn playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }
}

/// Control-side state per Beat Clip node: the audio handoff ring, the
/// garbage return, the assembled clip and the transport the RT module
/// publishes. `loaded` is the binding the audio in hand came from — it is
/// how the app tells a node that still needs assembling (patch load, undo)
/// from one that is playing what it should.
pub struct BeatClipControl {
    pub tx: rtrb::Producer<Arc<TrackData>>,
    pub garbage_rx: rtrb::Consumer<Arc<TrackData>>,
    pub track: Option<Arc<TrackData>>,
    pub loaded: Option<BeatClipRef>,
    pub shared: Arc<BeatClipShared>,
}

/// Snapshot of a Beat Clip node for UIs (serialized over IPC).
#[derive(Debug, Clone, Serialize)]
pub struct BeatClipStatus {
    /// The clip this module is bound to (absent until one is loaded).
    pub clip: Option<BeatClipRef>,
    pub duration_secs: f64,
    /// Audible position in clip seconds, as of the last processed block.
    pub position_secs: f64,
    /// Clip length in beats at the BPM input's tempo.
    pub beats: usize,
    /// Beat being played, or -1 while the module waits for a clock.
    pub beat: i64,
    /// Tempo the clip's audio was rendered at (the BPM input).
    pub bpm: f64,
    /// Tempo the last two clock edges measured out, 0 until there are two.
    pub clock_bpm: f64,
    pub playing: bool,
}

/// Clip length in beats at `bpm`: clips are cut in whole beats, so the
/// nearest one is the count (never zero — a clip is at least a beat).
pub fn beats_of(duration_secs: f64, bpm: f64) -> usize {
    if duration_secs <= 0.0 || bpm <= 0.0 || duration_secs.is_nan() || bpm.is_nan() {
        return 0;
    }
    ((duration_secs * bpm / 60.0).round() as usize).max(1)
}

/// The RT-side Beat Clip module. Never allocates or blocks: clips arrive
/// over an SPSC ring and replaced ones leave on the garbage ring.
pub struct BeatClipModule {
    rx: rtrb::Consumer<Arc<TrackData>>,
    garbage_tx: rtrb::Producer<Arc<TrackData>>,
    track: Option<Arc<TrackData>>,
    engine_rate: f32,
    /// VIRTUAL playhead in clip frames: it moves at the clock's tempo,
    /// while the grains reading it move at the clip's own (that split is
    /// what keeps the pitch).
    pos: f64,
    /// Beat of the clip the last clock edge landed on.
    beat: u32,
    /// Audible: a tempo is known and an edge has started the clip.
    started: bool,
    last_clock: f32,
    last_reset: f32,
    /// Engine samples between the last two clock edges; 0 = no tempo yet,
    /// which is why nothing plays.
    interval: f32,
    /// An edge has been seen, so `since_clock` is a real gap.
    seen_edge: bool,
    since_clock: f32,
    grains: GrainStretch,
    shared: Arc<BeatClipShared>,
}

impl BeatClipModule {
    pub fn new(
        rx: rtrb::Consumer<Arc<TrackData>>,
        garbage_tx: rtrb::Producer<Arc<TrackData>>,
        engine_rate: f32,
        shared: Arc<BeatClipShared>,
    ) -> Self {
        BeatClipModule {
            rx,
            garbage_tx,
            track: None,
            engine_rate: engine_rate.max(1.0),
            pos: 0.0,
            beat: 0,
            started: false,
            last_clock: 0.0,
            last_reset: 0.0,
            interval: 0.0,
            seen_edge: false,
            since_clock: 0.0,
            grains: GrainStretch::new(engine_rate),
            shared,
        }
    }

    /// Park at beat 0 and wait for a clock. Phase is 0 from this instant;
    /// the audio only moves again on the next edge, because a clip that
    /// restarted between ticks would be off the grid it was cut on. The
    /// measured tempo survives — this is a phase reset, not a re-learn.
    fn rearm(&mut self) {
        self.pos = 0.0;
        self.beat = 0;
        self.started = false;
        self.grains.reset();
    }
}

impl HostModule for BeatClipModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        // Pick up a newly assembled clip (latest wins).
        let mut loaded = false;
        while let Ok(t) = self.rx.pop() {
            if let Some(old) = self.track.replace(t) {
                let _ = self.garbage_tx.push(old);
            }
            loaded = true;
        }
        if loaded {
            self.rearm();
        }

        let clock = &inputs[IN_CLOCK];
        let reset = &inputs[IN_RESET];
        let bpm = &inputs[IN_BPM];
        for s in 0..frames {
            if reset[s] >= 1.0 && self.last_reset < 1.0 {
                self.rearm();
            }
            self.last_reset = reset[s];

            // Clip frames in one beat at the tempo the clip was rendered
            // at: the unit both the wrap and the playback rate are in.
            let beat_frames = self
                .track
                .as_ref()
                .map(|t| 60.0 / bpm[s].max(1.0) as f64 * t.sample_rate as f64)
                .unwrap_or(0.0);
            let beats = self
                .track
                .as_ref()
                .map(|t| beats_of(t.duration_secs(), bpm[s].max(1.0) as f64))
                .unwrap_or(0);

            self.since_clock += 1.0;
            if clock[s] >= 1.0 && self.last_clock < 1.0 {
                // Two edges make a tempo. One that is not a tempo (the
                // first ever, or a gap too long to be a beat) leaves the
                // module armed and silent, waiting for the pair.
                let measured = self.seen_edge
                    && self.since_clock <= MAX_INTERVAL_SECS * self.engine_rate
                    && beats > 0;
                self.interval = if measured {
                    self.since_clock.max(2.0)
                } else {
                    0.0
                };
                self.since_clock = 0.0;
                self.seen_edge = true;
                if !measured {
                    self.rearm();
                } else {
                    if self.started {
                        self.beat = (self.beat + 1) % beats as u32;
                    } else {
                        // The edge that first knew the tempo is beat 0.
                        self.beat = 0;
                        self.started = true;
                    }
                    // The edge IS the beat boundary: phase is the clock's,
                    // not the playhead's, so drift can never accumulate.
                    // The grains keep running across the jump — the
                    // overlap-add is the crossfade a re-anchor needs.
                    self.pos = self.beat as f64 * beat_frames;
                }
            }
            self.last_clock = clock[s];

            let (l, r) = match &self.track {
                Some(track) if self.started && self.pos < track.frames() as f64 => {
                    // Grains read at the clip's OWN rate (sample-rate
                    // conversion only), so the pitch is the clip's however
                    // fast the clock runs it.
                    let step = track.sample_rate as f64 / self.engine_rate as f64;
                    let taps = self.grains.tick(self.pos, step, &track.channels[0]);
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
                    // One clip beat per clock interval: the whole tempo
                    // change lives in this advance.
                    self.pos += beat_frames / self.interval as f64;
                    (l, r)
                }
                _ => (0.0, 0.0),
            };
            outputs[OUT_AUDIO_L][s] = l * SIGNAL_MAX;
            outputs[OUT_AUDIO_R][s] = r * SIGNAL_MAX;
        }

        let (pos_secs, playing) = match &self.track {
            Some(track) => (
                self.pos / track.sample_rate as f64,
                self.started && self.pos < track.frames() as f64,
            ),
            None => (0.0, false),
        };
        let clock_bpm = if self.interval > 0.0 {
            60.0 * self.engine_rate as f64 / self.interval as f64
        } else {
            0.0
        };
        self.shared.publish(
            pos_secs,
            clock_bpm,
            if self.started { self.beat as i64 } else { -1 },
            playing,
        );
    }

    /// Transport across a hot reload: the playhead, its beat, and the
    /// tempo the clock had measured (without which nothing may play).
    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(17);
        bytes.extend_from_slice(&self.pos.to_le_bytes());
        bytes.extend_from_slice(&self.beat.to_le_bytes());
        bytes.extend_from_slice(&self.interval.to_le_bytes());
        bytes.push(self.started as u8);
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 17 {
            self.pos = f64::from_le_bytes(bytes[..8].try_into().unwrap());
            self.beat = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
            self.interval = f32::from_le_bytes(bytes[12..16].try_into().unwrap());
            self.started = bytes[16] != 0 && self.interval > 0.0;
            self.seen_edge = self.started;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
