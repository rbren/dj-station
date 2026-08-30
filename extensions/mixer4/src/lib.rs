//! 4-channel stereo mixer: four full strips (level, pan, mute, solo) and
//! a master. The DSP lives in `dj_ext_mixer_core`.

use dj_ext_mixer_core::Mixer;
use dj_module_sdk::export_module;

export_module!(Mixer<4, true>);
