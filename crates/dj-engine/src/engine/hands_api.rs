//! Hands module control-plane API:
//! per-frame detections from the camera panel land here, derivations run
//! on the calling (control) thread, and changed values ship to the RT
//! graph over the node's SPSC ring.

use super::*;
use crate::hands::{HandsDetection, HandsEvent, HandsTrace, HANDS_ID};

impl Engine {
    fn hands_node(&self, instance_id: &str) -> Result<usize> {
        let node = *self
            .node_by_id
            .get(instance_id)
            .ok_or_else(|| anyhow!("no such module instance: {instance_id}"))?;
        anyhow::ensure!(
            self.nodes[node].ext_id == HANDS_ID,
            "{instance_id:?} is not a Hands module"
        );
        Ok(node)
    }

    /// Feed one tracked camera frame into a Hands node: derive all jack
    /// values and ship the changed ones to the RT graph, timestamped
    /// `frame` on the engine sample clock. `None` = dropped/failed frame
    /// (everything holds). Runs on the control thread — never the RT
    /// thread.
    pub fn hands_feed(
        &mut self,
        instance_id: &str,
        frame: u64,
        det: Option<&HandsDetection>,
    ) -> Result<()> {
        let node = self.hands_node(instance_id)?;
        let decay_frames = (crate::hands::DECAY_SECONDS * self.config.sample_rate).round() as u32;
        let (tx, ctl) = self
            .hands_producers
            .get_mut(&node)
            .ok_or_else(|| anyhow!("{instance_id:?} has no hands event ring"))?;
        let mut overflow = false;
        ctl.feed(det, |jack, value, decay| {
            overflow |= tx
                .push(HandsEvent {
                    frame,
                    jack: jack as u16,
                    ramp_frames: if decay { decay_frames } else { 0 },
                    value,
                })
                .is_err();
        });
        anyhow::ensure!(!overflow, "hands event queue full");
        Ok(())
    }

    /// Feed a whole recorded landmark trace starting at engine frame
    /// `start`. Used by offline renders, tests, and the E2E golden
    /// harness.
    pub fn hands_feed_trace(
        &mut self,
        instance_id: &str,
        trace: &HandsTrace,
        start: u64,
    ) -> Result<()> {
        anyhow::ensure!(trace.fps > 0.0, "hands trace fps must be positive");
        let frames_per_tick = self.config.sample_rate as f64 / trace.fps as f64;
        for (i, det) in trace.frames.iter().enumerate() {
            let frame = start + (i as f64 * frames_per_tick) as u64;
            self.hands_feed(instance_id, frame, Some(det))?;
        }
        Ok(())
    }
}
