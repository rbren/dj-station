//! QWERTY module control-plane API: key down/up events from the webview
//! (or tests) land here and ship to the RT graph over the node's SPSC
//! ring, timestamped on the engine sample clock.

use super::*;
use crate::qwerty::{key_index, QwertyEvent, QWERTY_ID};

impl Engine {
    /// Apply one key transition to a QWERTY node at engine frame `frame`
    /// (0 = immediately). `key` is the lowercased `event.key` from the
    /// webview: a digit, a letter, `" "` or `"space"`. Unknown keys are
    /// ignored (the panel forwards everything; only mapped keys exist as
    /// jacks). Runs on the control thread — never the RT thread.
    pub fn qwerty_key(
        &mut self,
        instance_id: &str,
        frame: u64,
        key: &str,
        down: bool,
    ) -> Result<()> {
        let node = *self
            .node_by_id
            .get(instance_id)
            .ok_or_else(|| anyhow!("no such module instance: {instance_id}"))?;
        anyhow::ensure!(
            self.nodes[node].ext_id == QWERTY_ID,
            "{instance_id:?} is not a QWERTY module"
        );
        let Some(jack) = key_index(key) else {
            return Ok(());
        };
        let tx = self
            .qwerty_producers
            .get_mut(&node)
            .ok_or_else(|| anyhow!("{instance_id:?} has no qwerty event ring"))?;
        tx.push(QwertyEvent {
            frame,
            jack: jack as u16,
            down,
        })
        .map_err(|_| anyhow!("qwerty event queue full"))
    }
}
