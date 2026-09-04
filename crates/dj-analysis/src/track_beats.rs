//! Persisted full-track beat detections for the Clip editor.
//!
//! The analysis worker writes all tracker seeds once per library track.
//! The Clip UI only reads and chooses among these results; it never makes
//! opening a track wait for another tracker pass.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::beats::{self, detect::BeatTracker};
use crate::decode::AudioData;

const DIR: &str = "beat-grids";

/// All beat detector output saved for one library track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackBeatAnalysis {
    pub tracker: String,
    pub selected_seed: String,
    #[serde(default = "default_downbeat_ratio")]
    pub downbeat_ratio: usize,
    pub seeds: Vec<TrackBeatSeed>,
}

/// One detector seed's full-track beat positions and meter markers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackBeatSeed {
    pub seed: String,
    pub bpm: f64,
    pub times: Vec<f64>,
    /// Explicit anchors placed by the user. Every other downbeat follows
    /// from these and [`TrackBeatAnalysis::downbeat_ratio`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub downbeats: Vec<usize>,
    /// Derived downbeats, retained so the UI can overlay them directly.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ones: Vec<usize>,
}

fn default_downbeat_ratio() -> usize {
    4
}

/// Where a track's analysis cache lives, under the library data root.
pub fn track_beats_path(data_dir: &Path, content_hash: &str) -> PathBuf {
    data_dir.join(DIR).join(format!("{content_hash}.json"))
}

/// Detect every available seed over the whole track and write the result.
pub fn analyze_track_beats(
    data_dir: &Path,
    content_hash: &str,
    audio: &AudioData,
    tracker: &dyn BeatTracker,
) -> Result<TrackBeatAnalysis> {
    let analysis = beats::analyze(audio, tracker, None, Default::default())?;
    let mut seeds = Vec::new();
    for run in analysis.runs {
        let bpm = beats::grid::fit_beats(&run.beats)
            .ok_or_else(|| anyhow!("seed {} found too few beats to fit a grid", run.seed))?
            .bpm();
        let mut seed = TrackBeatSeed {
            seed: run.seed,
            bpm,
            times: run.beats,
            downbeats: Vec::new(),
            ones: Vec::new(),
        };
        refresh_ones(&mut seed, default_downbeat_ratio());
        seeds.push(seed);
    }
    let result = TrackBeatAnalysis {
        tracker: analysis.tracker,
        selected_seed: analysis.seed,
        downbeat_ratio: default_downbeat_ratio(),
        seeds,
    };
    save_track_beats(data_dir, content_hash, &result)?;
    Ok(result)
}

/// Read the cached full-track detections, if analysis has completed them.
pub fn load_track_beats(data_dir: &Path, content_hash: &str) -> Result<Option<TrackBeatAnalysis>> {
    let path = track_beats_path(data_dir, content_hash);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    let mut result: TrackBeatAnalysis =
        serde_json::from_slice(&raw).with_context(|| format!("reading {}", path.display()))?;
    result.downbeat_ratio = result.downbeat_ratio.max(1);
    for seed in &mut result.seeds {
        refresh_ones(seed, result.downbeat_ratio);
    }
    Ok(Some(result))
}

/// Queue historical tracks whose full-track beat cache is absent or unreadable.
///
/// The existing analysis worker processes this queue one track at a time. A
/// shutdown leaves untouched entries as `queued`, so the scan resumes on the
/// next launch without reprocessing caches that were already written.
pub fn queue_missing_track_beats(library: &dj_library::Library) -> Result<usize> {
    let mut queued = 0;
    for track in library.tracks()? {
        if track.analysis_status != "done" {
            continue;
        }
        let missing = !matches!(
            load_track_beats(library.data_dir(), &track.content_hash),
            Ok(Some(analysis)) if !analysis.seeds.is_empty()
        );
        if missing {
            library.requeue_analysis(track.id)?;
            queued += 1;
        }
    }
    Ok(queued)
}

/// Choose a cached seed and persist the choice.
pub fn select_track_seed(
    data_dir: &Path,
    content_hash: &str,
    seed: &str,
) -> Result<TrackBeatAnalysis> {
    let mut result = load_track_beats(data_dir, content_hash)?
        .ok_or_else(|| anyhow!("no full-track beat analysis for this track"))?;
    if !result.seeds.iter().any(|candidate| candidate.seed == seed) {
        return Err(anyhow!("no cached beat seed called {seed}"));
    }
    result.selected_seed = seed.to_string();
    save_track_beats(data_dir, content_hash, &result)?;
    Ok(result)
}

/// Change the bar length; all seeds retain their explicit anchors.
pub fn set_downbeat_ratio(
    data_dir: &Path,
    content_hash: &str,
    ratio: usize,
) -> Result<TrackBeatAnalysis> {
    let mut result = load_track_beats(data_dir, content_hash)?
        .ok_or_else(|| anyhow!("no full-track beat analysis for this track"))?;
    result.downbeat_ratio = ratio.max(1);
    for seed in &mut result.seeds {
        refresh_ones(seed, result.downbeat_ratio);
    }
    save_track_beats(data_dir, content_hash, &result)?;
    Ok(result)
}

/// Toggle an explicit downbeat anchor. A new anchor restarts the count from
/// that beat, while removing one restores the preceding count.
pub fn toggle_track_downbeat(
    data_dir: &Path,
    content_hash: &str,
    seed_name: &str,
    index: usize,
) -> Result<TrackBeatAnalysis> {
    let mut result = load_track_beats(data_dir, content_hash)?
        .ok_or_else(|| anyhow!("no full-track beat analysis for this track"))?;
    let ratio = result.downbeat_ratio;
    let seed = result
        .seeds
        .iter_mut()
        .find(|candidate| candidate.seed == seed_name)
        .ok_or_else(|| anyhow!("no cached beat seed called {seed_name}"))?;
    if index >= seed.times.len() {
        return Err(anyhow!("beat index {index} is outside this seed"));
    }
    if index != 0 {
        if let Some(at) = seed.downbeats.iter().position(|&beat| beat == index) {
            seed.downbeats.remove(at);
        } else {
            seed.downbeats.push(index);
        }
    }
    refresh_ones(seed, ratio);
    save_track_beats(data_dir, content_hash, &result)?;
    Ok(result)
}

fn save_track_beats(data_dir: &Path, content_hash: &str, result: &TrackBeatAnalysis) -> Result<()> {
    let path = track_beats_path(data_dir, content_hash);
    let parent = path.parent().expect("beat cache has a parent");
    std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(result)?;
    std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("saving {}", path.display()))?;
    Ok(())
}

fn refresh_ones(seed: &mut TrackBeatSeed, ratio: usize) {
    let ratio = ratio.max(1);
    seed.downbeats.sort_unstable();
    seed.downbeats.dedup();
    seed.downbeats
        .retain(|&index| index > 0 && index < seed.times.len());
    let mut anchors = vec![0];
    anchors.extend(seed.downbeats.iter().copied());
    let mut ones = Vec::new();
    for (at, start) in anchors.iter().copied().enumerate() {
        let end = anchors.get(at + 1).copied().unwrap_or(seed.times.len());
        for beat in (start..end).step_by(ratio) {
            ones.push(beat);
        }
    }
    seed.ones = ones;
}

#[cfg(test)]
mod tests {
    use super::*;
    use dj_library::{ImportOptions, Library};

    struct TestTracker;

    impl BeatTracker for TestTracker {
        fn id(&self) -> String {
            "test/final0+final1+final2".into()
        }

        fn detect(
            &self,
            _audio: &AudioData,
            _span: Option<(f64, f64)>,
        ) -> Result<Vec<crate::beats::BeatRun>> {
            Ok(["final0", "final1", "final2"]
                .into_iter()
                .map(|seed| crate::beats::BeatRun {
                    seed: seed.into(),
                    beats: (0..12).map(|i| i as f64 * 0.5).collect(),
                })
                .collect())
        }
    }

    fn historical_track(library: &Library, path: &Path, sample: i16) -> dj_library::Track {
        let mut wav = hound::WavWriter::create(
            path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 100,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for _ in 0..600 {
            wav.write_sample(sample).unwrap();
        }
        wav.finalize().unwrap();
        let track = library
            .import_file(path, ImportOptions::default())
            .unwrap()
            .track()
            .clone();
        library.set_analysis_status(track.id, "done").unwrap();
        track
    }

    #[test]
    fn queues_only_historical_tracks_missing_a_beat_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let library = Library::open(tmp.path()).unwrap();
        let cached = historical_track(&library, &tmp.path().join("cached.wav"), 1);
        let missing = historical_track(&library, &tmp.path().join("missing.wav"), 2);
        let queued = historical_track(&library, &tmp.path().join("already-queued.wav"), 3);
        library.requeue_analysis(queued.id).unwrap();
        let audio = AudioData {
            channels: vec![vec![0.0; 600]],
            sample_rate: 100,
        };
        analyze_track_beats(
            library.data_dir(),
            &cached.content_hash,
            &audio,
            &TestTracker,
        )
        .unwrap();

        assert_eq!(queue_missing_track_beats(&library).unwrap(), 1);
        assert_eq!(library.analysis_queue().unwrap()[0].id, missing.id);
        // The missing track remains queued across a restart scan rather than
        // being duplicated, while completed cached tracks stay untouched.
        assert_eq!(queue_missing_track_beats(&library).unwrap(), 0);
        assert_eq!(library.analysis_queue().unwrap()[0].id, missing.id);
    }
    #[test]
    fn saves_all_seeds_and_restarts_downbeats_from_an_anchor() {
        let tmp = tempfile::tempdir().unwrap();
        let audio = AudioData {
            channels: vec![vec![0.0; 600]],
            sample_rate: 100,
        };
        let saved = analyze_track_beats(tmp.path(), "hash", &audio, &TestTracker).unwrap();
        assert_eq!(saved.seeds.len(), 3);
        assert_eq!(saved.seeds[0].ones, [0, 4, 8]);

        let selected = select_track_seed(tmp.path(), "hash", "final2").unwrap();
        assert_eq!(selected.selected_seed, "final2");
        let ratio = set_downbeat_ratio(tmp.path(), "hash", 3).unwrap();
        assert_eq!(ratio.seeds[0].ones, [0, 3, 6, 9]);
        let anchored = toggle_track_downbeat(tmp.path(), "hash", "final2", 5).unwrap();
        let seed = anchored.seeds.iter().find(|s| s.seed == "final2").unwrap();
        assert_eq!(seed.downbeats, [5]);
        assert_eq!(seed.ones, [0, 3, 5, 8, 11]);
        assert_eq!(
            load_track_beats(tmp.path(), "hash").unwrap(),
            Some(anchored)
        );
    }
}
