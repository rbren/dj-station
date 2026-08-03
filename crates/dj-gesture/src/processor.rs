//! The gesture module core: mappings, mode selection, learn flow.
//!
//! [`GestureProcessor`] runs on the control/capture thread. Each pipeline
//! tick ([`GestureProcessor::process`]) evaluates every mapping against the
//! latest detection (or its absence) and emits `(jack, value)` changes; the
//! engine forwards those into the RT graph over a lock-free ring (see
//! `dj-engine/src/gesture.rs`).
//!
//! The core is mode-agnostic: it looks mappings' modes up in the
//! [`ModeRegistry`] and never inspects mode configs itself, so new modes
//! plug in by registration alone.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::detect::Detection;
use crate::mode::{GestureMode, ModeCtx, ModeRegistry};
use crate::wheel::WheelLayout;

/// Fixed output-jack budget, like the MIDI module's mapping slots: the RT
/// graph preallocates this many output buffers per gesture node.
pub const MAX_MAPPINGS: usize = 64;

/// A persisted mapping definition: name (= the output jack's display
/// name), the mode that owns it, and the mode-specific config.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MappingDef {
    pub name: String,
    pub mode: String,
    pub config: serde_json::Value,
}

struct Slot {
    def: MappingDef,
    eval: Box<dyn crate::mode::MappingEval>,
}

pub struct GestureProcessor {
    registry: ModeRegistry,
    active_mode: String,
    wheels: WheelLayout,
    slots: Vec<Option<Slot>>,
    values: Vec<f32>,
    learn_armed: bool,
    learned: Option<serde_json::Value>,
    last_detection: Option<Detection>,
}

impl Default for GestureProcessor {
    fn default() -> Self {
        GestureProcessor::new(ModeRegistry::with_builtin_modes())
    }
}

impl GestureProcessor {
    pub fn new(registry: ModeRegistry) -> GestureProcessor {
        GestureProcessor {
            registry,
            active_mode: "wheel".into(),
            wheels: WheelLayout::default(),
            slots: (0..MAX_MAPPINGS).map(|_| None).collect(),
            values: vec![0.0; MAX_MAPPINGS],
            learn_armed: false,
            learned: None,
            last_detection: None,
        }
    }

    /// Register an additional mode (extensibility hook — new modes need
    /// only this, no core changes).
    pub fn register_mode(&mut self, mode: Box<dyn GestureMode>) {
        self.registry.register(mode);
    }

    pub fn mode_ids(&self) -> Vec<String> {
        self.registry.ids()
    }

    pub fn active_mode(&self) -> &str {
        &self.active_mode
    }

    /// Select the active mode (drives the overlay and the learn flow;
    /// existing mappings of other modes keep evaluating).
    pub fn set_active_mode(&mut self, id: &str) -> Result<()> {
        self.registry.get(id)?;
        self.active_mode = id.to_string();
        Ok(())
    }

    pub fn wheels(&self) -> &WheelLayout {
        &self.wheels
    }

    pub fn set_wheels(&mut self, wheels: WheelLayout) {
        self.wheels = wheels;
    }

    /// Create a mapping; returns the output jack index it materialized as.
    pub fn add_mapping(&mut self, def: MappingDef) -> Result<usize> {
        anyhow::ensure!(
            !self.mappings().iter().any(|(_, d)| d.name == def.name),
            "duplicate gesture mapping name {:?}",
            def.name
        );
        let eval = self.registry.get(&def.mode)?.create(&def.config)?;
        let jack = self
            .slots
            .iter()
            .position(|s| s.is_none())
            .ok_or_else(|| anyhow!("gesture mapping table full"))?;
        self.slots[jack] = Some(Slot { def, eval });
        self.values[jack] = 0.0;
        Ok(jack)
    }

    /// Remove a mapping by name; returns its jack index.
    pub fn remove_mapping(&mut self, name: &str) -> Option<usize> {
        let jack = self
            .slots
            .iter()
            .position(|s| s.as_ref().is_some_and(|s| s.def.name == name))?;
        self.slots[jack] = None;
        self.values[jack] = 0.0;
        Some(jack)
    }

    /// Active mappings as (jack, definition).
    pub fn mappings(&self) -> Vec<(usize, &MappingDef)> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.as_ref().map(|s| (i, &s.def)))
            .collect()
    }

    /// Arm the learn flow: the next detection is offered to the active
    /// mode, which proposes a mapping config.
    pub fn learn_begin(&mut self) {
        self.learned = None;
        self.learn_armed = true;
    }

    /// Take the learned mapping config, if one was captured.
    pub fn learn_take(&mut self) -> Option<serde_json::Value> {
        self.learned.take()
    }

    /// The detection most recently processed (drives the UI overlay).
    pub fn last_detection(&self) -> Option<&Detection> {
        self.last_detection.as_ref()
    }

    /// (wheel, zone) pairs currently containing a hand centroid (overlay
    /// highlighting).
    pub fn active_zones(&self) -> Vec<(usize, usize)> {
        let Some(det) = &self.last_detection else {
            return Vec::new();
        };
        let mut zones: Vec<(usize, usize)> = det
            .hands
            .iter()
            .flat_map(|h| self.wheels.zones_of(h.centroid()))
            .collect();
        zones.sort_unstable();
        zones.dedup();
        zones
    }

    /// One pipeline tick: evaluate all mappings against `det` (`None` =
    /// dropped/failed frame) with `dt` seconds elapsed since the previous
    /// tick. Emits `(jack, value)` for every mapping whose value changed.
    pub fn process(&mut self, det: Option<&Detection>, dt: f32, mut emit: impl FnMut(usize, f32)) {
        if let Some(d) = det {
            if self.learn_armed {
                let ctx = ModeCtx {
                    wheels: &self.wheels,
                };
                if let Ok(mode) = self.registry.get(&self.active_mode) {
                    if let Some(config) = mode.learn(d, &ctx) {
                        self.learned = Some(config);
                        self.learn_armed = false;
                    }
                }
            }
            self.last_detection = Some(d.clone());
        }
        let ctx = ModeCtx {
            wheels: &self.wheels,
        };
        for (jack, slot) in self.slots.iter_mut().enumerate() {
            let Some(slot) = slot else { continue };
            let value = slot.eval.update(det, dt, &ctx);
            if value != self.values[jack] {
                self.values[jack] = value;
                emit(jack, value);
            }
        }
    }

    /// Current output value of a mapping jack.
    pub fn value(&self, jack: usize) -> f32 {
        self.values.get(jack).copied().unwrap_or(0.0)
    }
}
