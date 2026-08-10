//! MIDI mappings, learn, LED feedback and hardware I/O — split out of the old monolithic engine.rs; methods on [`Engine`] only.

use super::*;

impl Engine {
    // ------------------------------------------------------------------
    // MIDI
    // ------------------------------------------------------------------

    /// Inject a virtual MIDI event (frame is on the engine sample clock).
    pub fn inject_midi(&mut self, instance_id: &str, frame: u64, data: [u8; 3]) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let tx = self
            .midi_producers
            .get_mut(&node)
            .ok_or_else(|| anyhow!("{instance_id:?} is not a MIDI module"))?;
        tx.push(MidiEvent { frame, data })
            .map_err(|_| anyhow!("midi queue full"))
    }

    /// Arm learn mode: the next incoming CC/note becomes a mapping candidate.
    pub fn midi_learn_begin(&mut self, instance_id: &str) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let shared = self.nodes[node]
            .midi_shared
            .as_ref()
            .ok_or_else(|| anyhow!("not a MIDI module"))?;
        shared.learned.store(0, Ordering::Release);
        shared.learn_armed.store(true, Ordering::Release);
        Ok(())
    }

    /// Poll for a learned control; on success creates the mapping/jack.
    pub fn midi_learn_poll(
        &mut self,
        instance_id: &str,
        name: &str,
    ) -> Result<Option<MidiMappingInfo>> {
        let node = self.node_idx(instance_id)?;
        let shared = self.nodes[node]
            .midi_shared
            .as_ref()
            .ok_or_else(|| anyhow!("not a MIDI module"))?
            .clone();
        let encoded = shared.learned.swap(0, Ordering::AcqRel);
        if encoded == 0 {
            return Ok(None);
        }
        let kind = MidiMapKind::from_u8(((encoded >> 8) & 0xFF) as u8)
            .ok_or_else(|| anyhow!("corrupt learned mapping encoding {encoded:#x}"))?;
        let num = (encoded & 0xFF) as u8;
        Ok(Some(self.add_midi_mapping_raw(node, kind, num, name)?))
    }

    /// Create a mapping directly (used by learn and by patch load).
    pub fn add_midi_mapping(
        &mut self,
        instance_id: &str,
        kind: MidiMapKind,
        num: u8,
        name: &str,
    ) -> Result<MidiMappingInfo> {
        let node = self.node_idx(instance_id)?;
        self.add_midi_mapping_raw(node, kind, num, name)
    }

    fn add_midi_mapping_raw(
        &mut self,
        node: usize,
        kind: MidiMapKind,
        num: u8,
        name: &str,
    ) -> Result<MidiMappingInfo> {
        let shared = self.nodes[node]
            .midi_shared
            .as_ref()
            .ok_or_else(|| anyhow!("not a MIDI module"))?;
        let jack = shared
            .add_mapping(kind.as_u8(), num)
            .ok_or_else(|| anyhow!("mapping table full"))?;
        let info = MidiMappingInfo {
            name: name.to_string(),
            kind,
            num,
            jack,
        };
        self.nodes[node].midi_mappings.push(info.clone());
        Ok(info)
    }

    /// Remove a named MIDI mapping, dropping any wires sourced from its jack.
    /// Wire removal is a structural edit, so the engine must be stopped when
    /// the mapping is still wired.
    pub fn remove_midi_mapping(&mut self, instance_id: &str, name: &str) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let pos = self.nodes[node]
            .midi_mappings
            .iter()
            .position(|m| m.name == name)
            .ok_or_else(|| anyhow!("no MIDI mapping {name:?} on {instance_id:?}"))?;
        let jack = self.nodes[node].midi_mappings[pos].jack;
        let doomed: Vec<WireSpec> = self
            .wires
            .iter()
            .copied()
            .filter(|w| w.from_node == node && w.from_jack == jack)
            .collect();
        if !doomed.is_empty() {
            let core = self.core_mut()?;
            for w in &doomed {
                core.graph.remove_wire(*w);
            }
            self.wires
                .retain(|w| !(w.from_node == node && w.from_jack == jack));
        }
        self.nodes[node].midi_mappings.remove(pos);
        if let Some(shared) = self.nodes[node].midi_shared.as_ref() {
            shared.remove_mapping(jack);
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // MIDI LED feedback (PRD §7.1)
    // ------------------------------------------------------------------

    /// Create an LED feedback mapping: a named input jack on a MIDI node
    /// whose signal drives note/CC out messages toward the controller.
    /// `num` is the controller/note number.
    pub fn add_midi_led_mapping(
        &mut self,
        instance_id: &str,
        kind: MidiMapKind,
        num: u8,
        name: &str,
    ) -> Result<MidiMappingInfo> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            !self.nodes[node]
                .midi_led_mappings
                .iter()
                .any(|m| m.name == name),
            "duplicate LED mapping name {name:?}"
        );
        let shared = self.nodes[node]
            .midi_shared
            .as_ref()
            .ok_or_else(|| anyhow!("not a MIDI module"))?;
        let jack = shared
            .add_led_mapping(kind.as_u8(), num)
            .ok_or_else(|| anyhow!("LED mapping table full"))?;
        let info = MidiMappingInfo {
            name: name.to_string(),
            kind,
            num,
            jack,
        };
        self.nodes[node].midi_led_mappings.push(info.clone());
        Ok(info)
    }

    /// Remove a named LED mapping, dropping any wires targeting its jack.
    pub fn remove_midi_led_mapping(&mut self, instance_id: &str, name: &str) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let pos = self.nodes[node]
            .midi_led_mappings
            .iter()
            .position(|m| m.name == name)
            .ok_or_else(|| anyhow!("no LED mapping {name:?} on {instance_id:?}"))?;
        let jack = self.nodes[node].midi_led_mappings[pos].jack;
        let doomed: Vec<WireSpec> = self
            .wires
            .iter()
            .copied()
            .filter(|w| w.to_node == node && w.to_jack == jack)
            .collect();
        if !doomed.is_empty() {
            let core = self.core_mut()?;
            for w in &doomed {
                core.graph.remove_wire(*w);
            }
            self.wires
                .retain(|w| !(w.to_node == node && w.to_jack == jack));
        }
        self.nodes[node].midi_led_mappings.remove(pos);
        if let Some(shared) = self.nodes[node].midi_shared.as_ref() {
            shared.remove_led_mapping(jack);
        }
        Ok(())
    }

    /// Drain LED feedback messages generated by a MIDI node since the last
    /// call (works stopped or running; lock-free ring on the RT side).
    pub fn drain_midi_out(&mut self, instance_id: &str) -> Result<Vec<MidiOutEvent>> {
        let node = self.node_idx(instance_id)?;
        let rx = self
            .midi_out_consumers
            .get_mut(&node)
            .ok_or_else(|| anyhow!("{instance_id:?} is not a MIDI module"))?;
        let mut out = Vec::new();
        while let Ok(ev) = rx.pop() {
            out.push(ev);
        }
        Ok(out)
    }

    /// Forward pending LED feedback messages to a sink (mock controller in
    /// tests, hardware output port in the app). Returns messages forwarded.
    pub fn pump_midi_out(
        &mut self,
        instance_id: &str,
        sink: &mut dyn MidiOutSink,
    ) -> Result<usize> {
        let events = self.drain_midi_out(instance_id)?;
        let n = events.len();
        for ev in events {
            sink.send(ev);
        }
        Ok(n)
    }

    /// Connect a hardware MIDI output port as the LED feedback sink helper
    /// (feature `midi-hw`): returns a sink that forwards messages to the
    /// port; call `pump_midi_out` with it from the control loop.
    #[cfg(feature = "midi-hw")]
    pub fn open_midi_hardware_sink(port_substring: &str) -> Result<HardwareMidiSink> {
        let midi_out = midir::MidiOutput::new("dj-station")?;
        let ports = midi_out.ports();
        let port = ports
            .iter()
            .find(|p| {
                midi_out
                    .port_name(p)
                    .map(|n| n.contains(port_substring))
                    .unwrap_or(false)
            })
            .ok_or_else(|| anyhow!("no MIDI output port matching {port_substring:?}"))?;
        let conn = midi_out
            .connect(port, "dj-station-out")
            .map_err(|e| anyhow!("midi out connect failed: {e}"))?;
        Ok(HardwareMidiSink { conn })
    }

    /// Connect a hardware MIDI input port to a MIDI node (feature `midi-hw`).
    /// The port's events are pushed into the same ring virtual injection uses,
    /// after which virtual injection on this node is no longer possible.
    #[cfg(feature = "midi-hw")]
    pub fn connect_midi_hardware(
        &mut self,
        instance_id: &str,
        port_substring: &str,
    ) -> Result<midir::MidiInputConnection<()>> {
        let node = self.node_idx(instance_id)?;
        let mut tx = self.midi_producers.remove(&node).ok_or_else(|| {
            anyhow!("{instance_id:?} has no free injection ring (already connected?)")
        })?;
        let midi_in = midir::MidiInput::new("dj-station")?;
        let ports = midi_in.ports();
        let port = ports
            .iter()
            .find(|p| {
                midi_in
                    .port_name(p)
                    .map(|n| n.contains(port_substring))
                    .unwrap_or(false)
            })
            .ok_or_else(|| anyhow!("no MIDI port matching {port_substring:?}"))?;
        let conn = midi_in
            .connect(
                port,
                "dj-station-in",
                move |_ts, msg, _| {
                    if msg.len() >= 2 {
                        let mut data = [0u8; 3];
                        data[..msg.len().min(3)].copy_from_slice(&msg[..msg.len().min(3)]);
                        // Hardware events apply "now" (frame 0 = immediately).
                        let _ = tx.push(MidiEvent { frame: 0, data });
                    }
                },
                (),
            )
            .map_err(|e| anyhow!("midi connect failed: {e}"))?;
        Ok(conn)
    }
}
