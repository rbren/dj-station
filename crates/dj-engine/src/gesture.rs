//! Built-in Gesture Control module (PRD §7.3, milestone M5).
//!
//! Architecturally the MIDI module's twin: the capture/detection pipeline
//! (dj-gesture) runs entirely off the RT thread; every mapping
//! materializes as an output jack; values cross into the RT graph as
//! timestamped events over a lock-free SPSC ring, applied
//! sample-accurately by [`GestureRtModule::process`] (zero allocations or
//! locks on the RT side). Frame drops simply produce no events — the RT
//! module holds the last value; gate decay after the configured timeout is
//! computed by the control-side [`dj_gesture::GestureProcessor`], which
//! emits the falling edge as an ordinary event.

use crate::manifest::{categories, Manifest, OutputDecl};
use crate::module_host::HostModule;
use serde::{Deserialize, Serialize};

pub const GESTURE_ID: &str = "builtin.gesture";

/// Fixed output-jack budget (graph buffers are preallocated), matching the
/// processor's mapping table.
pub const MAX_GESTURE_JACKS: usize = dj_gesture::MAX_MAPPINGS;

pub fn gesture_manifest() -> Manifest {
    Manifest {
        id: GESTURE_ID.into(),
        name: "Gesture".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::ANALYSIS.into(),
        inputs: vec![],
        // Output jacks are dynamic (one per mapping); the graph
        // preallocates MAX_GESTURE_JACKS output buffers.
        outputs: (0..MAX_GESTURE_JACKS)
            .map(|i| OutputDecl {
                id: format!("map{i}"),
                name: format!("Mapping {i}"),
            })
            .collect(),
        params: vec![],
        ui: None,
        latency_samples: 0,
    }
}

/// One mapping as persisted in the patch and shown in the UI: the output
/// jack's name, the owning mode, and the mode-specific config.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GestureMappingInfo {
    pub name: String,
    pub mode: String,
    pub config: serde_json::Value,
    /// Output jack index on the gesture node.
    pub jack: usize,
}

/// Gesture module state persisted per instance in the patch directory
/// (PRD §7.3: mappings, mode selection, and wheel layout round-trip).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GestureState {
    pub mode: String,
    pub wheels: dj_gesture::WheelLayout,
    /// Ordered by jack so reloading reproduces jack indices exactly.
    pub mappings: Vec<GestureMappingInfo>,
}

/// A control-thread-produced value for one mapping jack, applied on the RT
/// thread at (or after) `frame` on the engine sample clock.
#[derive(Debug, Clone, Copy)]
pub struct GestureEvent {
    pub frame: u64,
    pub jack: u16,
    pub value: f32,
}

/// The RT-side gesture module: pops mapping-value events from the SPSC
/// ring and renders them as held output signals (last value persists
/// until the next event — dropped frames upstream just mean no events).
pub struct GestureRtModule {
    consumer: rtrb::Consumer<GestureEvent>,
    values: [f32; MAX_GESTURE_JACKS],
    frame: u64,
}

impl GestureRtModule {
    pub fn new(consumer: rtrb::Consumer<GestureEvent>) -> Self {
        GestureRtModule {
            consumer,
            values: [0.0; MAX_GESTURE_JACKS],
            frame: 0,
        }
    }
}

impl HostModule for GestureRtModule {
    fn process(
        &mut self,
        _inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        let block_start = self.frame;
        for s in 0..frames {
            let now = block_start + s as u64;
            // Sample-accurate within the block; late/past events apply
            // immediately (same policy as MIDI).
            loop {
                match self.consumer.peek() {
                    Ok(ev) if ev.frame <= now => {
                        let ev = *ev;
                        let _ = self.consumer.pop();
                        if (ev.jack as usize) < MAX_GESTURE_JACKS {
                            self.values[ev.jack as usize] = ev.value;
                        }
                    }
                    _ => break,
                }
            }
            for (o, out) in outputs.iter_mut().enumerate().take(MAX_GESTURE_JACKS) {
                out[s] = self.values[o];
            }
        }
        self.frame = block_start + frames as u64;
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(MAX_GESTURE_JACKS * 4);
        for v in &self.values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        for (i, chunk) in bytes.chunks_exact(4).enumerate().take(MAX_GESTURE_JACKS) {
            self.values[i] = f32::from_le_bytes(chunk.try_into().unwrap());
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
