//! Built-in Playback module (PRD M1): plays a library track inside the
//! patch graph.
//!
//! - Inputs: `play_gate` (high ≥ 1.0 plays; low pauses), `speed`
//!   (pitch-style: +1.0 doubles the playback rate, -1.0 halves it).
//! - Outputs: `audio_l`, `audio_r` (mono files feed both).
//! - Decoding (symphonia: mp3/flac/wav/aac at minimum) happens on the
//!   control thread; the RT side only reads preloaded sample memory.
//!   Sample-rate conversion to the engine rate is folded into the playback
//!   increment (linear interpolation), so a file at the engine rate with
//!   `speed = 0` reproduces its samples exactly (null test).
//!
//! Track handoff is RT-safe: decoded tracks travel to the RT module through
//! an SPSC ring as `Arc<TrackData>`; replaced tracks are shipped back on a
//! garbage ring and dropped on the control thread.

use anyhow::Result;
use std::path::Path;
use std::sync::Arc;

use crate::graph::SIGNAL_MAX;
use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;
use crate::stretch::sample_at;

pub const PLAYBACK_ID: &str = "builtin.playback";

pub fn playback_manifest() -> Manifest {
    Manifest {
        id: PLAYBACK_ID.into(),
        name: "Playback".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        deprecated: false,
        inputs: vec![
            JackDecl {
                id: "play_gate".into(),
                name: "Play Gate".into(),
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
            JackDecl {
                id: "speed".into(),
                name: "Speed".into(),
                default: 0.0,
                audio: false,
                capture: false,
                knob: Some(KnobConfig {
                    style: KnobStyle::Continuous,
                    min: -2.0,
                    max: 2.0,
                    curve: Curve::Linear,
                    steps: None,
                }),
                display: None,
            },
            JackDecl {
                id: "loop".into(),
                name: "Loop".into(),
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
        presets: Default::default(),
    }
}

/// A fully decoded track, deinterleaved per channel, in [-1, 1].
pub struct TrackData {
    pub channels: Vec<Vec<f32>>,
    pub sample_rate: f32,
}

/// LOOP BLEED: the material a beat clip keeps from OUTSIDE its loop, so
/// the seam has continuity. `right` is the audio that followed the clip
/// in the track it was cut from and is laid over the loop's START (a pass
/// carries the previous one's tail across the seam); `left` is the audio
/// that came before it and is laid over the loop's END (a pass announces
/// the next one). Neither is mixed into the loop: the player overlays
/// them, which is what lets the first pass drop the right one and the
/// last — a dropped deck — drop the left. Filed as metadata beside the
/// clip (`dj_analysis::clip::BeatClipMeta`), never baked into its audio.
#[derive(Clone, Default)]
pub struct ClipBleed {
    pub left: Option<Arc<TrackData>>,
    pub right: Option<Arc<TrackData>>,
}

impl ClipBleed {
    /// What the overlays add for one grain tap at `pos` (loop frames) in
    /// a loop `loop_frames` long. `head`/`tail` are the passes' say:
    /// silence the right bleed on the first pass and the left bleed on
    /// the last one. Out-of-range reads are silent ([`sample_at`]), so
    /// the overlay simply stops where its material runs out.
    #[inline]
    pub fn tap(&self, pos: f64, loop_frames: f64, head: bool, tail: bool) -> (f32, f32) {
        let (mut l, mut r) = (0.0f32, 0.0f32);
        let mut read = |track: &TrackData, at: f64| {
            let gl = sample_at(&track.channels[0], at);
            let gr = if track.channels.len() > 1 {
                sample_at(&track.channels[1], at)
            } else {
                gl
            };
            l += gl;
            r += gr;
        };
        if head {
            if let Some(track) = &self.right {
                read(track, pos);
            }
        }
        if tail {
            if let Some(track) = &self.left {
                read(track, pos - (loop_frames - track.frames() as f64));
            }
        }
        (l, r)
    }
}

/// A clip as it is handed to a player: the loop, and the bleed that goes
/// over its seam. A bare [`TrackData`] converts into one with no bleed,
/// so every caller that has no bleed to give keeps passing the audio.
#[derive(Clone)]
pub struct ClipAudio {
    pub track: Arc<TrackData>,
    pub bleed: ClipBleed,
}

impl From<TrackData> for ClipAudio {
    fn from(track: TrackData) -> Self {
        Arc::new(track).into()
    }
}

impl From<Arc<TrackData>> for ClipAudio {
    fn from(track: Arc<TrackData>) -> Self {
        ClipAudio {
            track,
            bleed: ClipBleed::default(),
        }
    }
}

impl TrackData {
    pub fn frames(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }

    pub fn duration_secs(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }

    /// Waveform overview: peak |sample| per bucket over the channel mix
    /// (0..=1), spanning the whole track. Control thread only — every
    /// waveform UI (deck, audio module) reads the same shape.
    pub fn peaks(&self, buckets: usize) -> Vec<f32> {
        let frames = self.frames();
        if frames == 0 || buckets == 0 {
            return Vec::new();
        }
        let buckets = buckets.min(frames);
        let mut out = vec![0.0f32; buckets];
        let per = frames as f64 / buckets as f64;
        for (b, peak) in out.iter_mut().enumerate() {
            let start = (b as f64 * per) as usize;
            let end = (((b + 1) as f64 * per) as usize).min(frames);
            let mut p = 0.0f32;
            for i in start..end {
                let mut s = self.channels[0][i].abs();
                if self.channels.len() > 1 {
                    s = s.max(self.channels[1][i].abs());
                }
                p = p.max(s);
            }
            *peak = p;
        }
        out
    }
}

/// Decode an audio file fully into memory, on the control thread. One
/// pipeline for the whole app: `dj_analysis::decode_audio` (same formats,
/// same error tolerance, and the FLAC declared-length truncation), only
/// re-shaped into the RT-side `TrackData`.
pub fn decode_file(path: &Path) -> Result<TrackData> {
    Ok(shape(dj_analysis::decode_audio(path)?))
}

/// [`decode_file`] for a file out of the stem cache, which is written in
/// a lossy format whose encoder delay `dj_analysis::decode_stem` takes
/// back off — a stem that started a few milliseconds late would no longer
/// line up with its track.
pub fn decode_stem_file(path: &Path) -> Result<TrackData> {
    Ok(shape(dj_analysis::decode_stem(path)?))
}

fn shape(audio: dj_analysis::AudioData) -> TrackData {
    TrackData {
        channels: audio.channels,
        sample_rate: audio.sample_rate as f32,
    }
}

/// The RT-side playback module. Receives decoded tracks over an SPSC ring;
/// never allocates or blocks on the RT path (replaced tracks go back over
/// the garbage ring; if that ring is full the drop happens here, a bounded,
/// load-only exception mirroring module hot-swap).
pub struct PlaybackModule {
    rx: rtrb::Consumer<Arc<TrackData>>,
    garbage_tx: rtrb::Producer<Arc<TrackData>>,
    track: Option<Arc<TrackData>>,
    engine_rate: f32,
    /// Playback position in source frames (fractional).
    pos: f64,
    /// Reached end of a non-looping track.
    ended: bool,
    looping: bool,
    prev_gate_high: bool,
}

impl PlaybackModule {
    pub fn new(
        rx: rtrb::Consumer<Arc<TrackData>>,
        garbage_tx: rtrb::Producer<Arc<TrackData>>,
        engine_rate: f32,
    ) -> Self {
        PlaybackModule {
            rx,
            garbage_tx,
            track: None,
            engine_rate,
            pos: 0.0,
            ended: false,
            looping: false,
            prev_gate_high: false,
        }
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

impl HostModule for PlaybackModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        // Pick up newly loaded tracks (latest wins).
        while let Ok(t) = self.rx.pop() {
            if let Some(old) = self.track.replace(t) {
                let _ = self.garbage_tx.push(old);
            }
            self.pos = 0.0;
            self.ended = false;
        }

        let gate = &inputs[0];
        let speed = &inputs[1];
        if frames > 0 {
            // loop is an ordinary input jack (gate semantics, block rate).
            self.looping = inputs[2][0] >= 1.0;
        }
        for s in 0..frames {
            let gate_high = gate[s] >= 1.0;
            // Rising edge after a completed non-looping track restarts it.
            if gate_high && !self.prev_gate_high && self.ended {
                self.pos = 0.0;
                self.ended = false;
            }
            self.prev_gate_high = gate_high;

            let (l, r) = match &self.track {
                Some(track) if gate_high && !self.ended => {
                    let n = track.frames();
                    let l = Self::sample_at(&track.channels[0], self.pos);
                    let r = if track.channels.len() > 1 {
                        Self::sample_at(&track.channels[1], self.pos)
                    } else {
                        l
                    };
                    // +1.0 speed = double rate; SR conversion folded in.
                    let ratio = (track.sample_rate as f64 / self.engine_rate as f64)
                        * 2f64.powf(speed[s] as f64);
                    self.pos += ratio;
                    if self.pos >= n as f64 {
                        if self.looping {
                            self.pos %= n as f64;
                        } else {
                            self.ended = true;
                        }
                    }
                    (l, r)
                }
                _ => (0.0, 0.0),
            };
            outputs[0][s] = l * SIGNAL_MAX;
            outputs[1][s] = r * SIGNAL_MAX;
        }
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(9);
        bytes.extend_from_slice(&self.pos.to_le_bytes());
        bytes.push(self.ended as u8);
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 9 {
            self.pos = f64::from_le_bytes(bytes[..8].try_into().unwrap());
            self.ended = bytes[8] != 0;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
