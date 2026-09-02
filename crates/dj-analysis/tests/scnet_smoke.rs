//! SCNet XL IHF smoke test against the real model.
//!
//! Same gating pattern as the ONNX and provider smoke tests: it skips
//! itself unless the tooling and weights are actually installed, because
//! CI has neither (a venv with MSST + torch and a 214 MB checkpoint —
//! `scripts/install-scnet.sh`). Everything about the plumbing is covered
//! without them in `stem_separation.rs`; this is the one test that proves
//! the argv and the output layout still match the real CLI.
//!
//! Run it with the install in place:
//!
//! ```text
//! DJ_SCNET_PYTHON=custom/scnet/venv/bin/python \
//! DJ_SCNET_CONFIG=custom/scnet/config.yaml \
//! DJ_SCNET_CKPT=custom/scnet/model.ckpt \
//!   cargo test --release -p dj-analysis --test scnet_smoke -- --nocapture
//! ```
//!
//! Minutes, not seconds: the model pads anything shorter than its 11 s
//! chunk, so even this one second of tone is a full chunk of CPU work.

use dj_analysis::scnet::ScnetSeparator;
use dj_analysis::{AudioData, StemSeparator};

#[test]
fn scnet_separator_smoke() {
    let sep = ScnetSeparator::from_env();
    if let Err(why) = sep.probe() {
        eprintln!("skipping: no SCNet install here ({why})");
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
