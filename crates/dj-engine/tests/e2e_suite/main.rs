//! Aggregated E2E golden-audio suites (one binary; see `integration/main.rs` for
//! why suites share a target).
//!
//! These stay separate from `integration/main.rs` because they render whole
//! patches and are run with `--test-threads=1`; `scripts/regen-goldens.sh`
//! drives this target with `REGEN_GOLDENS=1`.

#[path = "../common/mod.rs"]
mod common;

mod e2e_alias;
mod e2e_audio;
mod e2e_beat_clip;
mod e2e_bypass;
mod e2e_camera;
mod e2e_choreo;
mod e2e_decks;
mod e2e_effects;
mod e2e_golden;
mod e2e_hands;
mod e2e_launch_control;
mod e2e_quantizer_custom;
mod e2e_qwerty;
mod e2e_sequencing;
mod e2e_shaping;
mod e2e_sources;
mod e2e_utilities;
mod e2e_workspace;
