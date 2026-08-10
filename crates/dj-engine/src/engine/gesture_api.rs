//! Gesture control (PRD §7.3) — split out of the old monolithic engine.rs; methods on [`Engine`] only.

use super::*;

impl Engine {
    // ------------------------------------------------------------------
    // Gesture Control (PRD §7.3)
    // ------------------------------------------------------------------

    fn gesture_node(&self, instance_id: &str) -> Result<usize> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.nodes[node].gesture.is_some(),
            "{instance_id:?} is not a Gesture module"
        );
        Ok(node)
    }

    /// Read-only access to a gesture node's pipeline core (mode, wheel
    /// layout, mappings, last detection — drives the UI overlay).
    pub fn gesture(&self, instance_id: &str) -> Result<&dj_gesture::GestureProcessor> {
        let node = self.gesture_node(instance_id)?;
        Ok(self.nodes[node].gesture.as_ref().unwrap())
    }

    /// Active gesture mappings as persisted infos (ordered by jack).
    pub fn gesture_mappings(&self, instance_id: &str) -> Result<Vec<GestureMappingInfo>> {
        let g = self.gesture(instance_id)?;
        Ok(g.mappings()
            .into_iter()
            .map(|(jack, d)| GestureMappingInfo {
                name: d.name.clone(),
                mode: d.mode.clone(),
                config: d.config.clone(),
                jack,
            })
            .collect())
    }

    /// Register an additional interaction mode on a gesture node. New
    /// modes need only this — the module core is untouched (M5 acceptance
    /// criterion). Register before loading patches that reference the
    /// mode... but note [`Engine::from_doc`] builds fresh nodes with the
    /// built-in modes only, so custom-mode mappings don't survive a
    /// document reload unless re-registered by the embedding app first.
    pub fn gesture_register_mode(
        &mut self,
        instance_id: &str,
        mode: Box<dyn dj_gesture::GestureMode>,
    ) -> Result<()> {
        let node = self.gesture_node(instance_id)?;
        self.nodes[node]
            .gesture
            .as_mut()
            .unwrap()
            .register_mode(mode);
        Ok(())
    }

    /// Select the active interaction mode (persisted in the patch).
    pub fn gesture_set_mode(&mut self, instance_id: &str, mode: &str) -> Result<()> {
        let node = self.gesture_node(instance_id)?;
        self.nodes[node]
            .gesture
            .as_mut()
            .unwrap()
            .set_active_mode(mode)
    }

    /// Set the wheel layout (persisted in the patch).
    pub fn gesture_set_wheels(
        &mut self,
        instance_id: &str,
        wheels: dj_gesture::WheelLayout,
    ) -> Result<()> {
        let node = self.gesture_node(instance_id)?;
        self.nodes[node]
            .gesture
            .as_mut()
            .unwrap()
            .set_wheels(wheels);
        Ok(())
    }

    /// Create a gesture mapping; it materializes as output jack `name`.
    pub fn add_gesture_mapping(
        &mut self,
        instance_id: &str,
        name: &str,
        mode: &str,
        config: serde_json::Value,
    ) -> Result<GestureMappingInfo> {
        let node = self.gesture_node(instance_id)?;
        let def = dj_gesture::MappingDef {
            name: name.to_string(),
            mode: mode.to_string(),
            config: config.clone(),
        };
        let jack = self.nodes[node]
            .gesture
            .as_mut()
            .unwrap()
            .add_mapping(def)?;
        Ok(GestureMappingInfo {
            name: name.to_string(),
            mode: mode.to_string(),
            config,
            jack,
        })
    }

    /// Restore a mapping at its saved jack index (patch load).
    pub fn restore_gesture_mapping(
        &mut self,
        instance_id: &str,
        info: &GestureMappingInfo,
    ) -> Result<()> {
        let node = self.gesture_node(instance_id)?;
        self.nodes[node].gesture.as_mut().unwrap().add_mapping_at(
            info.jack,
            dj_gesture::MappingDef {
                name: info.name.clone(),
                mode: info.mode.clone(),
                config: info.config.clone(),
            },
        )
    }

    /// Remove a named gesture mapping, dropping any wires sourced from its
    /// jack (structural edit: the engine must be stopped when the mapping
    /// is still wired, same rule as MIDI).
    pub fn remove_gesture_mapping(&mut self, instance_id: &str, name: &str) -> Result<()> {
        let node = self.gesture_node(instance_id)?;
        let jack = self.nodes[node]
            .gesture
            .as_mut()
            .unwrap()
            .remove_mapping(name)
            .ok_or_else(|| anyhow!("no gesture mapping {name:?} on {instance_id:?}"))?;
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
        // Zero the RT-side value so a reused slot doesn't leak stale state
        // (frame 0 = apply immediately).
        if let Some(tx) = self.gesture_producers.get_mut(&node) {
            let _ = tx.push(GestureEvent {
                frame: 0,
                jack: jack as u16,
                value: 0.0,
            });
        }
        Ok(())
    }

    /// Arm the learn flow: the next detection is offered to the active
    /// mode, which proposes a mapping config.
    pub fn gesture_learn_begin(&mut self, instance_id: &str) -> Result<()> {
        let node = self.gesture_node(instance_id)?;
        self.nodes[node].gesture.as_mut().unwrap().learn_begin();
        Ok(())
    }

    /// Poll for a learned mapping candidate; on success creates the
    /// mapping/jack under `name` (mirrors `midi_learn_poll`).
    pub fn gesture_learn_poll(
        &mut self,
        instance_id: &str,
        name: &str,
    ) -> Result<Option<GestureMappingInfo>> {
        let node = self.gesture_node(instance_id)?;
        let Some(config) = self.nodes[node].gesture.as_mut().unwrap().learn_take() else {
            return Ok(None);
        };
        let mode = self.nodes[node]
            .gesture
            .as_ref()
            .unwrap()
            .active_mode()
            .to_string();
        Ok(Some(self.add_gesture_mapping(
            instance_id,
            name,
            &mode,
            config,
        )?))
    }

    /// Feed one pipeline tick into a gesture node: evaluate all mappings
    /// against `det` (`None` = dropped/failed frame; values hold, gates
    /// decay per their timeout) and ship changed values to the RT graph,
    /// timestamped `frame` on the engine sample clock. Runs on the
    /// capture/control thread — never the RT thread.
    pub fn gesture_feed(
        &mut self,
        instance_id: &str,
        frame: u64,
        det: Option<&dj_gesture::Detection>,
        dt: f32,
    ) -> Result<()> {
        let node = self.gesture_node(instance_id)?;
        let tx = self
            .gesture_producers
            .get_mut(&node)
            .ok_or_else(|| anyhow!("{instance_id:?} has no gesture event ring"))?;
        let mut overflow = false;
        self.nodes[node]
            .gesture
            .as_mut()
            .unwrap()
            .process(det, dt, |jack, value| {
                overflow |= tx
                    .push(GestureEvent {
                        frame,
                        jack: jack as u16,
                        value,
                    })
                    .is_err();
            });
        anyhow::ensure!(!overflow, "gesture event queue full");
        Ok(())
    }

    /// Feed a whole recorded pose trace through the pipeline (frames
    /// rendered + detected via the deterministic mock path) starting at
    /// engine frame `start`. Used by offline renders, tests, and the E2E
    /// golden harness.
    pub fn gesture_feed_trace(
        &mut self,
        instance_id: &str,
        trace: &dj_gesture::PoseTrace,
        start: u64,
    ) -> Result<()> {
        use dj_gesture::HandDetector;
        let mut detector = dj_gesture::MarkerDetector;
        let dt = 1.0 / trace.fps;
        for i in 0..trace.frames.len() {
            let frame = dj_gesture::TraceFrameSource::render(trace, i)
                .ok_or_else(|| anyhow!("trace frame {i} failed to render"))?;
            let det = detector.detect(&frame)?;
            let at = start + (i as f64 * self.config.sample_rate as f64 / trace.fps as f64) as u64;
            self.gesture_feed(instance_id, at, Some(&det), dt)?;
        }
        Ok(())
    }
}
