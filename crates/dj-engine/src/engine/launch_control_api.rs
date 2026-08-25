//! Launch Control XL control-plane API: raw MIDI from the surface lands
//! here, decoding/dedup runs on the calling (control) thread, and changed
//! jack values ship to the RT graph over the node's SPSC ring.
//!
//! Two entry points, deliberately different:
//!   * [`Engine::launchcontrol_feed`] is the DEVICE feed — it reaches the
//!     module(s) that own the surface (`active`), which is what makes the
//!     Active button mean anything with several modules on the rack.
//!   * [`Engine::launchcontrol_inject`] addresses ONE module regardless of
//!     ownership: the deterministic seam tests, offline renders and the
//!     E2E goldens use, so nothing in CI depends on hardware being present.

use super::*;
use crate::launch_control::{LaunchControlEvent, ACTIVE_PARAM, LAUNCH_CONTROL_ID, PORT_NAME};

impl Engine {
    fn launch_control_node(&self, instance_id: &str) -> Result<usize> {
        let node = *self
            .node_by_id
            .get(instance_id)
            .ok_or_else(|| anyhow!("no such module instance: {instance_id}"))?;
        anyhow::ensure!(
            self.nodes[node].ext_id == LAUNCH_CONTROL_ID,
            "{instance_id:?} is not a Launch Control XL module"
        );
        Ok(node)
    }

    /// Graph slots of every Launch Control node that currently owns the
    /// surface, in slot order.
    fn launch_control_active_nodes(&self) -> Vec<usize> {
        self.nodes
            .iter_slots()
            .filter(|(_, info)| {
                info.ext_id == LAUNCH_CONTROL_ID
                    && info.params.get(ACTIVE_PARAM).copied().unwrap_or(0.0) >= 0.5
            })
            .map(|(slot, _)| slot)
            .collect()
    }

    /// Decode one surface message for `node` and ship the changed jack
    /// value to the RT graph, timestamped `frame` on the engine sample
    /// clock. Messages the device map doesn't cover, and values that
    /// didn't change, cross nothing.
    fn push_launch_control(&mut self, node: usize, frame: u64, data: [u8; 3]) -> Result<()> {
        let (tx, ctl) = self
            .launch_control_producers
            .get_mut(&node)
            .ok_or_else(|| anyhow!("node has no Launch Control event ring"))?;
        let mut overflow = false;
        ctl.feed(data, |jack, value| {
            overflow |= tx
                .push(LaunchControlEvent {
                    frame,
                    jack: jack as u16,
                    value,
                })
                .is_err();
        });
        anyhow::ensure!(!overflow, "launch control event queue full");
        Ok(())
    }

    /// Feed one message from the physical surface: every module that owns
    /// the controller sees it. Returns how many modules did — 0 means the
    /// surface is attached but nothing is listening (no module active).
    pub fn launchcontrol_feed(&mut self, frame: u64, data: [u8; 3]) -> Result<usize> {
        let nodes = self.launch_control_active_nodes();
        for node in &nodes {
            self.push_launch_control(*node, frame, data)?;
        }
        Ok(nodes.len())
    }

    /// Feed one message straight into a named module, ignoring ownership:
    /// the synthetic/offline path (tests, E2E goldens, headless renders),
    /// mirroring `inject_midi` on the MIDI module.
    pub fn launchcontrol_inject(
        &mut self,
        instance_id: &str,
        frame: u64,
        data: [u8; 3],
    ) -> Result<()> {
        let node = self.launch_control_node(instance_id)?;
        self.push_launch_control(node, frame, data)
    }

    /// Whether a Launch Control XL surface is attached (the panel's
    /// indicator light). Pure status: the app's device watcher owns this
    /// flag, so headless runs and CI simply see `false`.
    pub fn launchcontrol_connected(&self) -> bool {
        self.launch_control_connected
    }

    pub fn launchcontrol_set_connected(&mut self, connected: bool) {
        self.launch_control_connected = connected;
    }

    /// The module that currently owns the surface, if any.
    pub fn launchcontrol_active_instance(&self) -> Option<String> {
        self.launch_control_active_nodes()
            .first()
            .map(|slot| self.nodes[*slot].instance_id.clone())
    }

    pub fn launchcontrol_is_active(&self, instance_id: &str) -> Result<bool> {
        let node = self.launch_control_node(instance_id)?;
        Ok(self.nodes[node]
            .params
            .get(ACTIVE_PARAM)
            .copied()
            .unwrap_or(0.0)
            >= 0.5)
    }

    /// Give (or take) this module the surface. Ownership is EXCLUSIVE:
    /// one physical controller, one listening module, so activating one
    /// module deactivates every other. Deactivating leaves the surface
    /// unowned — its messages then reach nothing.
    pub fn launchcontrol_set_active(&mut self, instance_id: &str, active: bool) -> Result<()> {
        let node = self.launch_control_node(instance_id)?;
        if active {
            let others: Vec<String> = self
                .nodes
                .iter_slots()
                .filter(|(slot, info)| *slot != node && info.ext_id == LAUNCH_CONTROL_ID)
                .map(|(_, info)| info.instance_id.clone())
                .collect();
            for id in others {
                self.set_param(&id, ACTIVE_PARAM, 0.0)?;
            }
        }
        self.set_param(instance_id, ACTIVE_PARAM, if active { 1.0 } else { 0.0 })
    }

    /// A freshly added module claims an UNOWNED surface, so the common
    /// case (one module, one controller) needs no ceremony; a second
    /// module never steals ownership from the first. Called by
    /// `add_plain_module`; the patch's saved `active` param is applied
    /// afterwards and wins.
    pub(super) fn launchcontrol_claim_if_unowned(&mut self, node: usize) {
        if !self.launch_control_active_nodes().is_empty() {
            return;
        }
        let id = self.nodes[node].instance_id.clone();
        let _ = self.set_param(&id, ACTIVE_PARAM, 1.0);
    }

    /// Whether a Launch Control XL input port is visible right now
    /// (feature `midi-hw`). Cheap enough for a ~1 Hz watcher poll.
    #[cfg(feature = "midi-hw")]
    pub fn launchcontrol_port_present() -> bool {
        let Ok(midi_in) = midir::MidiInput::new("dj-station") else {
            return false;
        };
        midi_in.ports().iter().any(|p| {
            midi_in
                .port_name(p)
                .map(|n| n.contains(PORT_NAME))
                .unwrap_or(false)
        })
    }

    /// Open the surface's MIDI input port and hand every message to
    /// `on_message` (feature `midi-hw`). The engine is deliberately NOT
    /// captured: the callback runs on midir's thread, so the app forwards
    /// messages to `launchcontrol_feed` from a thread of its own instead
    /// of holding the engine lock inside a device callback.
    #[cfg(feature = "midi-hw")]
    pub fn connect_launchcontrol_hardware(
        mut on_message: impl FnMut([u8; 3]) + Send + 'static,
    ) -> Result<midir::MidiInputConnection<()>> {
        let mut midi_in = midir::MidiInput::new("dj-station")?;
        midi_in.ignore(midir::Ignore::All);
        let ports = midi_in.ports();
        let port = ports
            .iter()
            .find(|p| {
                midi_in
                    .port_name(p)
                    .map(|n| n.contains(PORT_NAME))
                    .unwrap_or(false)
            })
            .ok_or_else(|| anyhow!("no MIDI input port matching {PORT_NAME:?}"))?;
        midi_in
            .connect(
                port,
                "dj-station-launchcontrol",
                move |_ts, msg, _| {
                    if msg.len() >= 3 {
                        on_message([msg[0], msg[1], msg[2]]);
                    }
                },
                (),
            )
            .map_err(|e| anyhow!("launch control connect failed: {e}"))
    }
}
