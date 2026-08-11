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

use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::sync::Arc;

use crate::graph::SIGNAL_MAX;
use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;

pub const PLAYBACK_ID: &str = "builtin.playback";

pub fn playback_manifest() -> Manifest {
    Manifest {
        id: PLAYBACK_ID.into(),
        name: "Playback".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        inputs: vec![
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
                display: None,
            },
            JackDecl {
                id: "speed".into(),
                name: "Speed".into(),
                default: 0.0,
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
    }
}

/// A fully decoded track, deinterleaved per channel, in [-1, 1].
pub struct TrackData {
    pub channels: Vec<Vec<f32>>,
    pub sample_rate: f32,
}

impl TrackData {
    pub fn frames(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }

    pub fn duration_secs(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }
}

/// Decode an audio file (mp3/flac/wav/aac/...) fully into memory.
pub fn decode_file(path: &Path) -> Result<TrackData> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::errors::Error as SymError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path)
        .with_context(|| format!("opening {} for decoding", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .with_context(|| format!("probing {}", path.display()))?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("no audio track in {}", path.display()))?;
    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("unknown sample rate in {}", path.display()))?
        as f32;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .with_context(|| format!("creating decoder for {}", path.display()))?;

    let mut channels: Vec<Vec<f32>> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // Skip over recoverable per-packet decode errors.
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        };
        let spec = *decoded.spec();
        let n_ch = spec.channels.count().max(1);
        if channels.is_empty() {
            channels = vec![Vec::new(); n_ch];
        }
        let buf = sample_buf
            .get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        buf.copy_interleaved_ref(decoded);
        for (i, s) in buf.samples().iter().enumerate() {
            channels[i % n_ch].push(*s);
        }
    }
    anyhow::ensure!(
        !channels.is_empty() && !channels[0].is_empty(),
        "no audio decoded from {}",
        path.display()
    );
    Ok(TrackData {
        channels,
        sample_rate,
    })
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
