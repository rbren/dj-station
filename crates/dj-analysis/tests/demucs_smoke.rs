//! `htdemucs_ft` smoke test against the real CLI.
//!
//! Same gating pattern as the SCNet, ONNX and provider smoke tests: it
//! skips itself unless demucs is actually installed, because CI has no
//! venv and no weights (`scripts/install-demucs.sh`). Everything about
//! the plumbing is covered without them in `stem_separation.rs`; this is
//! the one test that proves the argv and the output layout still match
//! the real CLI.
//!
//! Run it with the install in place:
//!
//! ```text
//! DJ_DEMUCS_BIN=custom/demucs/venv/bin/demucs \
//!   cargo test --release -p dj-analysis --test demucs_smoke -- --nocapture
//! ```
//!
//! Minutes, not seconds: `htdemucs_ft` is a bag of four models, each run
//! over the whole (segment-padded) input.

use dj_analysis::demucs::DemucsSeparator;
use dj_analysis::{AudioData, StemSeparator};

#[test]
fn demucs_separator_smoke() {
    let sep = DemucsSeparator::from_env();
    if let Err(why) = sep.probe() {
        eprintln!("skipping: no demucs install here ({why})");
        return;
    }

    let sr = 44_100u32;
    let n = sr as usize; // 1 s
    let tone = |hz: f32| {
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / sr as f32).sin() * 0.5)
            .collect::<Vec<f32>>()
    };
    let audio = AudioData {
        channels: vec![tone(220.0), tone(330.0)],
        sample_rate: sr,
    };

    let stems = sep.separate(&audio).expect("separation failed");
    for (stem, name) in stems.0.iter().zip(dj_analysis::STEM_NAMES) {
        assert_eq!(stem.channels.len(), 2, "{name} lost a channel");
        assert_eq!(stem.frames(), n, "{name} is not on the source's timebase");
        assert_eq!(stem.sample_rate, sr);
    }
}
