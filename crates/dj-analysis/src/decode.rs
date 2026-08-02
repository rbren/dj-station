//! Audio decoding for the analysis pipeline (symphonia; same formats as
//! the engine/library: mp3/m4a/aac/flac/wav/aiff).

use anyhow::{anyhow, Context, Result};
use std::path::Path;

/// Decoded audio: deinterleaved per channel, samples in [-1, 1].
#[derive(Debug, Clone, PartialEq)]
pub struct AudioData {
    pub channels: Vec<Vec<f32>>,
    pub sample_rate: u32,
}

impl AudioData {
    pub fn frames(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }

    pub fn duration_secs(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }

    /// Mono mix (mean of channels).
    pub fn mono_mix(&self) -> Vec<f32> {
        let n = self.frames();
        if self.channels.len() == 1 {
            return self.channels[0].clone();
        }
        let scale = 1.0 / self.channels.len() as f32;
        (0..n)
            .map(|i| self.channels.iter().map(|c| c[i]).sum::<f32>() * scale)
            .collect()
    }
}

/// Decode an audio file fully into memory (analysis runs off-line on
/// worker threads, PRD §8.2).
pub fn decode_audio(path: &Path) -> Result<AudioData> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::errors::Error as SymError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path)
        .with_context(|| format!("opening {} for analysis", path.display()))?;
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
        .ok_or_else(|| anyhow!("unknown sample rate in {}", path.display()))?;
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
    Ok(AudioData {
        channels,
        sample_rate,
    })
}
