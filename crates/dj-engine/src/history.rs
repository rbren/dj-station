//! Undo/redo history over in-memory patch snapshots (`PatchDoc`).
//!
//! The host records the *pre-edit* snapshot before every mutating edit;
//! `undo` swaps the current state for the most recent snapshot (pushing the
//! current state onto the redo stack) and vice versa. Rapid consecutive
//! edits with the same key (e.g. a knob drag streaming position updates)
//! coalesce into a single undo step.

use crate::patch::PatchDoc;
use std::time::{Duration, Instant};

const MAX_DEPTH: usize = 100;
const COALESCE_WINDOW: Duration = Duration::from_millis(1000);

#[derive(Default)]
pub struct UndoHistory {
    undo: Vec<PatchDoc>,
    redo: Vec<PatchDoc>,
    last_key: Option<String>,
    last_at: Option<Instant>,
}

impl UndoHistory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `pre` (the state *before* the edit identified by `key`).
    /// Any new edit invalidates the redo stack.
    pub fn record(&mut self, key: &str, pre: PatchDoc) {
        let now = Instant::now();
        let coalesce = !self.undo.is_empty()
            && self.last_key.as_deref() == Some(key)
            && self
                .last_at
                .is_some_and(|t| now.duration_since(t) < COALESCE_WINDOW);
        self.last_key = Some(key.to_string());
        self.last_at = Some(now);
        self.redo.clear();
        if coalesce {
            return;
        }
        // Skip no-op edits so undo always changes something.
        if self.undo.last() == Some(&pre) {
            return;
        }
        self.undo.push(pre);
        if self.undo.len() > MAX_DEPTH {
            self.undo.remove(0);
        }
    }

    /// Mark the end of an edit gesture (e.g. pointer-up after a knob drag).
    /// The next record starts a fresh undo step even if it re-edits the
    /// same key within the coalescing window — without this, repeatedly
    /// adjusting one knob would collapse into a single undo step.
    pub fn end_gesture(&mut self) {
        self.last_key = None;
        self.last_at = None;
    }

    /// Pop the last snapshot, exchanging it for `current` on the redo stack.
    pub fn undo(&mut self, current: PatchDoc) -> Option<PatchDoc> {
        // A snapshot identical to the current state would be a visible no-op;
        // skip past it (happens when the coalescing window expired between a
        // record and the actual edit failing, or after a restore).
        let mut doc = self.undo.pop()?;
        while doc == current {
            doc = match self.undo.pop() {
                Some(d) => d,
                None => {
                    self.undo.push(doc);
                    return None;
                }
            };
        }
        self.redo.push(current);
        self.last_key = None;
        Some(doc)
    }

    /// Pop the last undone snapshot, exchanging it for `current`.
    pub fn redo(&mut self, current: PatchDoc) -> Option<PatchDoc> {
        let doc = self.redo.pop()?;
        self.undo.push(current);
        self.last_key = None;
        Some(doc)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.last_key = None;
        self.last_at = None;
    }
}
