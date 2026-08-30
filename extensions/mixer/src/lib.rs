//! 6-channel stereo mixer — RETIRED in favour of the Mixer 4 / 8 / 16
//! (`com.dj.mixer4`, `com.dj.mixer8`, `com.dj.mixer16`), the same desk at
//! the widths a rack actually reaches for. Its manifest carries
//! `"deprecated": true`, so the picker only offers it under the
//! Deprecated tag; it loads and sounds exactly as it always did, because
//! the patches built on it have to keep working.
//!
//! Six full strips (level, pan, mute, solo) plus a master, straight from
//! the shared family DSP in `dj_ext_mixer_core`.

use dj_ext_mixer_core::Mixer;
use dj_module_sdk::export_module;

export_module!(Mixer<6, true>);
