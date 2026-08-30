//! 8-channel stereo mixer: eight full strips (level, pan, mute, solo) and
//! a master — the widest desk the 64-jack ABI fits a full strip into.
//! The DSP lives in `dj_ext_mixer_core`.

use dj_ext_mixer_core::Mixer;
use dj_module_sdk::export_module;

export_module!(Mixer<8, true>);
