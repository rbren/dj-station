//! dj-station on-device analysis pipeline (PRD §8.2, milestone M3).
//!
//! - **BPM / auto-beatgrid** ([`tempo`]): onset-strength envelope +
//!   autocorrelation tempo estimation, refined by a least-squares beat fit;
//!   emits a constant-tempo beatgrid `(bpm, anchor_secs)` compatible with
//!   the M2 deck.
//! - **Musical key** ([`key`]): chromagram + Krumhansl-Schmuckler key
//!   profiles over 24 major/minor keys.
//! - **Stems** ([`stems`]): a [`stems::StemSeparator`] trait with two
//!   implementations — a deterministic pure-DSP fallback
//!   ([`stems::BandSeparator`], HPSS + frequency-band/stereo-center masks,
//!   energy-conserving) that always works offline, and an ONNX-Runtime
//!   backend ([`onnx`], `--features onnx`) that loads an htdemucs-class
//!   model from a configurable path (CoreML execution provider on macOS,
//!   CPU elsewhere). Stems are cached as FLAC in app storage, keyed by the
//!   track's content hash.
//! - **Clip editing** ([`clip`]): the Clip page's offline editor —
//!   cut/splice/reverse spans of library tracks, 3-band EQ and level
//!   automation, rendered deterministically into a new audio file.
//! - **Background worker** ([`worker`]): drains the library's analysis
//!   queue off the audio/UI threads; results land in the library DB with
//!   no user action.
//!
//! Everything here runs on background threads — never on the RT audio
//! thread. The engine consumes results (beatgrids via the library DB, stem
//! FLACs via `deck_load_stems`).

pub mod clip;
pub mod decode;
pub mod demucs;
pub mod key;
pub mod stem_jobs;
pub mod stems;
pub mod stft;
pub mod tempo;
pub mod testset;
pub mod worker;

#[cfg(feature = "onnx")]
pub mod onnx;

pub use clip::{render_clip, ClipEq, ClipProgram, ClipRegion, LevelPoint};
pub use decode::{decode_audio, AudioData};
pub use demucs::DemucsSeparator;
pub use stem_jobs::{StemJob, StemJobState, StemJobs};
pub use stems::{
    ensure_stems, ensure_stems_cancellable, stem_paths, stems_cached, stems_dir, stems_dir_for,
    BandSeparator, CancelToken, StemSeparator, Stems, DEFAULT_SEPARATOR_ID, N_STEMS, STEM_NAMES,
};
pub use worker::{start_worker, AnalysisSettings, AnalysisWorker};

use serde::{Deserialize, Serialize};

/// Combined BPM / beatgrid / key result for one track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub bpm: f64,
    /// Beatgrid anchor (a beat position), in track seconds.
    pub anchor_secs: f64,
    /// Musical key, e.g. "Am", "F#", "C".
    pub key: String,
}

/// Analyze decoded audio: BPM + auto-beatgrid + key. Pure DSP, no models,
/// deterministic. Errors if the track is too short/silent to track beats.
pub fn analyze_audio(audio: &AudioData) -> anyhow::Result<AnalysisResult> {
    let mono = audio.mono_mix();
    let t = tempo::detect_tempo(&mono, audio.sample_rate)
        .ok_or_else(|| anyhow::anyhow!("no beats detected"))?;
    let key = key::detect_key(&mono, audio.sample_rate);
    Ok(AnalysisResult {
        bpm: t.bpm,
        anchor_secs: t.anchor_secs,
        key,
    })
}
