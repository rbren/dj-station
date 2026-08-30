//! 16-channel stereo summing mixer: sixteen level-only strips and a
//! master. Pan and mute/solo are the price of the width — 16 full strips
//! would need 97 input jacks and the ABI stops at 64. The DSP lives in
//! `dj_ext_mixer_core`.

use dj_ext_mixer_core::Mixer;
use dj_module_sdk::export_module;

export_module!(Mixer<16, false>);
