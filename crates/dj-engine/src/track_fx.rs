//! Offline render of a Grid track's effects rack.
//!
//! The Grid page plays its clips in the webview, not through the live
//! engine — so a track's rack is heard by rendering the track's audio
//! THROUGH the rack offline, here, and handing the webview the processed
//! (wet) buffer to crossfade against the dry one (the Wetness knob).
//!
//! The spec is the grid document's own `fx` JSON (`app/src/gridFx.ts`,
//! `TrackFx`): modules with mapped knob VALUES, and wires whose chrome
//! ends name the pseudo-instance `"chrome"`. Rendering builds a fresh
//! headless [`Engine`] — the same registry, the same wasm modules, the
//! same graph semantics as the live rack — around two real nodes standing
//! in for the chrome:
//!
//! - `builtin.track_io` IS the "track → rack" side: it plays the input
//!   buffer verbatim on `out_l`/`out_r` and pulses `clock` at the grid's
//!   tempo (its `bpm` knob).
//! - `builtin.audio_out` is the "rack → track" side: whatever the rack
//!   wires into `chrome.inL/inR` lands on the master bus, which the
//!   offline render collects.
//!
//! MONO is "just L": a mono input feeds `outL` alone, and a rack that
//! wires nothing back to `inR` returns a mono (one-channel) render. A
//! fresh engine per render is what makes renders deterministic — module
//! state (filters, LFO phase) always starts from silence, exactly like
//! the webview starting the dry buffer.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::engine::{Engine, EngineConfig};
use crate::graph::SIGNAL_MAX;
use crate::playback::TrackData;
use crate::registry::ExtensionRegistry;

/// The pseudo-instance the grid document's wires use for the chrome.
pub const CHROME: &str = "chrome";

/// Instance ids of the two real nodes standing in for the chrome. Grid
/// module ids are short alphanumerics (`eq1`, `scope2`), so these cannot
/// collide; a spec that names them anyway is rejected.
const CHROME_IO: &str = "chrome_io";
const CHROME_OUT: &str = "chrome_out";

#[derive(Debug, Clone, Deserialize)]
pub struct FxModuleSpec {
    pub id: String,
    #[serde(rename = "type")]
    pub type_id: String,
    #[serde(default)]
    pub values: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FxWireSpec {
    pub from_instance: String,
    pub from_jack: String,
    pub to_instance: String,
    pub to_jack: String,
}

/// The slice of the grid document's `fx` this render cares about. Level,
/// pan and wetness stay in the webview (they are mix moves, not DSP), and
/// module positions are canvas geometry; serde skips them all.
#[derive(Debug, Clone, Deserialize)]
pub struct TrackFxSpec {
    #[serde(default)]
    pub modules: Vec<FxModuleSpec>,
    #[serde(default)]
    pub wires: Vec<FxWireSpec>,
}

impl TrackFxSpec {
    pub fn from_json(json: &str) -> Result<Self> {
        serde_json::from_str(json).map_err(|e| anyhow!("track fx spec: {e}"))
    }

    /// Whether any wire returns audio to the track. A rack that sends
    /// nothing back renders silence — true modular behaviour, but the
    /// caller may want to know before paying for a render.
    pub fn returns_audio(&self) -> bool {
        self.wires
            .iter()
            .any(|w| w.to_instance == CHROME && (w.to_jack == "inL" || w.to_jack == "inR"))
    }
}

/// A chrome jack name mapped onto the real node that stands in for it.
fn chrome_output(jack: &str) -> Result<(&'static str, &'static str)> {
    match jack {
        "clock" => Ok((CHROME_IO, "clock")),
        "outL" => Ok((CHROME_IO, "out_l")),
        "outR" => Ok((CHROME_IO, "out_r")),
        other => Err(anyhow!("unknown chrome output {other:?}")),
    }
}

fn chrome_input(jack: &str) -> Result<(&'static str, &'static str)> {
    match jack {
        "inL" => Ok((CHROME_OUT, "l")),
        "inR" => Ok((CHROME_OUT, "r")),
        other => Err(anyhow!("unknown chrome input {other:?}")),
    }
}

/// Render `input` (interleaved-by-channel, [-1, 1], `sample_rate`) through
/// the rack in `spec` at the grid's `bpm`. Returns one Vec per channel in
/// [-1, 1], exactly `input`'s length: sample k of the output is what the
/// rack made of sample k of the input, which is what lets the webview
/// crossfade the two. One input channel means a mono track (fed to the
/// chrome's L side); the output is mono when the rack only returns L.
pub fn render_track_fx(
    registry: ExtensionRegistry,
    spec: &TrackFxSpec,
    input: &[Vec<f32>],
    sample_rate: f32,
    bpm: f64,
) -> Result<Vec<Vec<f32>>> {
    let frames = input.first().map(|c| c.len()).unwrap_or(0);
    anyhow::ensure!(frames > 0, "empty input");
    let stereo_out = spec
        .wires
        .iter()
        .any(|w| w.to_instance == CHROME && w.to_jack == "inR");

    let mut engine = Engine::new(
        EngineConfig {
            sample_rate,
            master_channels: 2,
            ..EngineConfig::default()
        },
        registry,
    )?;
    engine.add_module(CHROME_IO, crate::track_io::TRACK_IO_ID)?;
    engine.add_module(CHROME_OUT, crate::builtin::AUDIO_OUT_ID)?;
    engine.set_knob_value(CHROME_IO, "bpm", bpm as f32)?;

    for m in &spec.modules {
        anyhow::ensure!(
            m.id != CHROME && m.id != CHROME_IO && m.id != CHROME_OUT,
            "reserved module id {:?}",
            m.id
        );
        engine.add_module(&m.id, &m.type_id)?;
        for (jack, value) in &m.values {
            engine.set_knob_value(&m.id, jack, *value as f32)?;
        }
    }
    for w in &spec.wires {
        let (from_instance, from_jack) = if w.from_instance == CHROME {
            chrome_output(&w.from_jack)?
        } else {
            (w.from_instance.as_str(), w.from_jack.as_str())
        };
        let (to_instance, to_jack) = if w.to_instance == CHROME {
            chrome_input(&w.to_jack)?
        } else {
            (w.to_instance.as_str(), w.to_jack.as_str())
        };
        engine.connect(from_instance, from_jack, to_instance, to_jack)?;
    }

    let track = Arc::new(TrackData {
        channels: input.to_vec(),
        sample_rate,
    });
    engine.track_io_load(CHROME_IO, track)?;

    let rendered = engine.render_offline(frames)?;
    let channels = if stereo_out { 2 } else { 1 };
    Ok(rendered
        .into_iter()
        .take(channels)
        .map(|ch| ch.iter().map(|s| s / SIGNAL_MAX).collect())
        .collect())
}

/// `render_track_fx` for a caller holding a mono-or-stereo clip: collapses
/// a stereo input to the chrome's mono convention when the rack never taps
/// `outR` (the L jack then carries the WHOLE track, not half of it), so
/// the default rack — EQ across the L path — is neutral for stereo clips
/// instead of quietly dropping their right side.
pub fn render_track_fx_clip(
    registry: ExtensionRegistry,
    spec: &TrackFxSpec,
    channels: &[Vec<f32>],
    sample_rate: f32,
    bpm: f64,
) -> Result<Vec<Vec<f32>>> {
    let taps_right = spec
        .wires
        .iter()
        .any(|w| w.from_instance == CHROME && w.from_jack == "outR");
    if channels.len() >= 2 && !taps_right {
        let mono: Vec<f32> = channels[0]
            .iter()
            .zip(&channels[1])
            .map(|(l, r)| (l + r) * 0.5)
            .collect();
        render_track_fx(registry, spec, &[mono], sample_rate, bpm)
    } else {
        render_track_fx(registry, spec, channels, sample_rate, bpm)
    }
}
