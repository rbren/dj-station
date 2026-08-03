//! The extensible mode system (PRD §7.3).
//!
//! An interaction mode is a [`GestureMode`]: a factory that turns a
//! per-mapping JSON config into a [`MappingEval`], plus a learn hook that
//! proposes a mapping config from a live detection. Modes register against
//! the module core through [`ModeRegistry`] — adding a new mode requires
//! only registration, zero changes to the module core (an explicit M5
//! acceptance criterion; see the stub third mode in
//! `dj-engine/tests/gesture.rs`).

use anyhow::{anyhow, Result};

use crate::detect::Detection;
use crate::wheel::WheelLayout;

/// Module-level state every evaluation sees (currently the wheel layout;
/// modes that don't care simply ignore it).
pub struct ModeCtx<'a> {
    pub wheels: &'a WheelLayout,
}

/// Per-mapping evaluator: fed once per pipeline tick.
///
/// `det` is `None` when the tick had no usable detection (dropped or
/// failed frame): continuous outputs hold their last value; gate outputs
/// hold, then decay to 0 once their configured timeout elapses.
pub trait MappingEval: Send {
    fn update(&mut self, det: Option<&Detection>, dt: f32, ctx: &ModeCtx) -> f32;
}

/// An interaction mode. Implementations ship in [`crate::modes`]; new
/// modes come from anywhere and just register.
pub trait GestureMode: Send {
    /// Stable id, persisted with every mapping (e.g. "wheel", "landmark").
    fn id(&self) -> &str;

    /// Build an evaluator for one mapping from its JSON config.
    fn create(&self, config: &serde_json::Value) -> Result<Box<dyn MappingEval>>;

    /// Learn-style flow: propose a mapping config from the current
    /// detection (e.g. the zone the hand is in), or `None` if the
    /// detection suggests nothing yet.
    fn learn(&self, det: &Detection, ctx: &ModeCtx) -> Option<serde_json::Value>;
}

/// Registry of available modes. The module core only ever talks to modes
/// through this — that's what makes the system extensible.
#[derive(Default)]
pub struct ModeRegistry {
    modes: Vec<Box<dyn GestureMode>>,
}

impl ModeRegistry {
    pub fn new() -> ModeRegistry {
        ModeRegistry::default()
    }

    /// Registry with the two modes that ship first (PRD §7.3).
    pub fn with_builtin_modes() -> ModeRegistry {
        let mut r = ModeRegistry::new();
        r.register(Box::new(crate::modes::WheelMode));
        r.register(Box::new(crate::modes::LandmarkMode));
        r
    }

    /// Register a mode (replacing any previous registration of the same
    /// id).
    pub fn register(&mut self, mode: Box<dyn GestureMode>) {
        self.modes.retain(|m| m.id() != mode.id());
        self.modes.push(mode);
    }

    pub fn get(&self, id: &str) -> Result<&dyn GestureMode> {
        self.modes
            .iter()
            .find(|m| m.id() == id)
            .map(|m| m.as_ref())
            .ok_or_else(|| anyhow!("unknown gesture mode {id:?}"))
    }

    pub fn ids(&self) -> Vec<String> {
        self.modes.iter().map(|m| m.id().to_string()).collect()
    }
}
