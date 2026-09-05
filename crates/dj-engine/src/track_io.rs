//! Track I/O (`builtin.track_io`): the engine end of a Grid track's
//! effects-rack CHROME. The Grid page plays its clips in the webview, so a
//! track's rack cannot sit in the live graph — instead the app renders the
//! track's audio THROUGH its rack offline ([`crate::track_fx`]), and this
//! module is where that audio enters the graph: the host hands it a buffer
//! (control thread, lock-free, the Beat Clip handoff pattern) and it plays
//! the samples back VERBATIM — no stretch, no loop — alongside a clock
//! pulsing at the grid's tempo on its `bpm` input. What the rack sends
//! back to the track lands on an ordinary `builtin.audio_out`, so the
//! offline render's master bus IS the returned (wet) signal.
//!
//! Verbatim matters: the dry signal the webview plays and the wet signal
//! this render produces are mixed sample-for-sample by the Wetness knob,
//! so the feed must not re-time or re-synthesize anything. The buffer is
//! already at the grid's tempo (the same WSOLA stretch the dry path gets).
//!
//! Deliberately NOT in [`crate::registry::ExtensionRegistry::all_manifests`]:
//! this is render plumbing, not a module for the picker.

use std::sync::Arc;

use crate::graph::SIGNAL_MAX;
use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, DisplaySpec, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;
use crate::playback::TrackData;

pub const TRACK_IO_ID: &str = "builtin.track_io";

pub(crate) const IN_BPM: usize = 0;

const OUT_CLOCK: usize = 0;
const OUT_L: usize = 1;
const OUT_R: usize = 2;

/// How long the clock output's pulse is held, in seconds — the width the
/// Decks bank's clock uses.
const CLOCK_PULSE_SECS: f32 = 0.001;

pub fn track_io_manifest() -> Manifest {
    Manifest {
        id: TRACK_IO_ID.into(),
        name: "Track I/O".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        deprecated: false,
        inputs: vec![JackDecl {
            id: "bpm".into(),
            name: "BPM".into(),
            alias: None,
            default: 120.0,
            audio: false,
            capture: false,
            knob: Some(KnobConfig {
                style: KnobStyle::Continuous,
                min: 20.0,
                max: 300.0,
                curve: Curve::Linear,
                steps: None,
            }),
            display: Some(DisplaySpec {
                unit: Some("BPM".into()),
                ..DisplaySpec::default()
            }),
        }],
        outputs: vec![
            OutputDecl {
                id: "clock".into(),
                name: "Clock".into(),
                alias: None,
                display: None,
            },
            OutputDecl {
                id: "out_l".into(),
                name: "Out L".into(),
                alias: None,
                display: None,
            },
            OutputDecl {
                id: "out_r".into(),
                name: "Out R".into(),
                alias: None,
                display: None,
            },
        ],
        params: vec![],
        ui: None,
        latency_samples: 0,
        bypass: Default::default(),
        presets: Default::default(),
    }
}

/// Control-thread handle: pushes buffers in, reclaims what the module
/// replaced (an `Arc` must never be dropped on the RT thread).
pub struct TrackIoControl {
    tx: rtrb::Producer<Arc<TrackData>>,
    garbage_rx: rtrb::Consumer<Arc<TrackData>>,
}

impl TrackIoControl {
    pub fn new(
        tx: rtrb::Producer<Arc<TrackData>>,
        garbage_rx: rtrb::Consumer<Arc<TrackData>>,
    ) -> Self {
        Self { tx, garbage_rx }
    }

    pub fn load(&mut self, track: Arc<TrackData>) -> anyhow::Result<()> {
        while self.garbage_rx.pop().is_ok() {}
        self.tx
            .push(track)
            .map_err(|_| anyhow::anyhow!("too many pending track loads"))
    }
}

pub struct TrackIoModule {
    rx: rtrb::Consumer<Arc<TrackData>>,
    garbage_tx: rtrb::Producer<Arc<TrackData>>,
    track: Option<Arc<TrackData>>,
    /// Playhead, in samples from the top of the buffer. A newly handed
    /// buffer starts it over — one buffer is one render.
    pos: usize,
    /// Beat phase in beats; the pulse fires when it crosses an integer
    /// (including 0.0 at the very first sample).
    phase: f64,
    last_beat: i64,
    clock_left: u32,
    clock_len: u32,
    sample_rate: f32,
}

impl TrackIoModule {
    pub fn new(
        rx: rtrb::Consumer<Arc<TrackData>>,
        garbage_tx: rtrb::Producer<Arc<TrackData>>,
        sample_rate: f32,
    ) -> Self {
        Self {
            rx,
            garbage_tx,
            track: None,
            pos: 0,
            phase: 0.0,
            last_beat: -1,
            clock_left: 0,
            clock_len: ((sample_rate * CLOCK_PULSE_SECS) as u32).max(1),
            sample_rate,
        }
    }
}

impl HostModule for TrackIoModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        while let Ok(track) = self.rx.pop() {
            if let Some(old) = self.track.replace(track) {
                let _ = self.garbage_tx.push(old);
            }
            self.pos = 0;
            self.phase = 0.0;
            self.last_beat = -1;
            self.clock_left = 0;
        }
        let bpm = &inputs[IN_BPM];
        for s in 0..frames {
            // One pulse per beat of the grid's clock, phase-accumulated so
            // a modulated tempo still counts beats where they land.
            if self.phase.floor() as i64 != self.last_beat {
                self.last_beat = self.phase.floor() as i64;
                self.clock_left = self.clock_len;
            }
            outputs[OUT_CLOCK][s] = if self.clock_left > 0 {
                self.clock_left -= 1;
                SIGNAL_MAX
            } else {
                0.0
            };
            self.phase += (bpm[s].clamp(20.0, 300.0) as f64) / 60.0 / self.sample_rate as f64;

            let (l, r) = match &self.track {
                Some(t) => {
                    let at = |ch: usize| {
                        t.channels
                            .get(ch)
                            .and_then(|c| c.get(self.pos))
                            .copied()
                            .unwrap_or(0.0)
                    };
                    // A mono buffer feeds L only: the chrome's "just L is
                    // mono" convention, decided by the render host.
                    (at(0), at(1))
                }
                None => (0.0, 0.0),
            };
            outputs[OUT_L][s] = l * SIGNAL_MAX;
            outputs[OUT_R][s] = r * SIGNAL_MAX;
            self.pos += 1;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
