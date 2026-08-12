//! Choreography timeline control plane; methods on [`Engine`] only.
//!
//! All edits mutate the node's canonical [`ChoreoState`] and then recompile
//! and push the program to the RT module over the SPSC ring — no engine
//! stop needed for data edits (adding/removing tracks changes the jack set
//! the UI shows, but the graph's output buffers are preallocated, so even
//! that is a data edit; only wires to a removed track's jacks need the
//! usual stopped structural path, handled by the caller).

use super::*;
use crate::choreo::{ChoreoState, ChoreoTrack, ChoreoTrackData, NoteStep, MAX_CHOREO_BEATS};

impl Engine {
    fn choreo_node(&self, instance_id: &str) -> Result<usize> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.nodes[node].choreo.is_some(),
            "{instance_id:?} is not a Choreography module"
        );
        Ok(node)
    }

    /// Read-only view of a choreography node's timeline.
    pub fn choreo(&self, instance_id: &str) -> Result<&ChoreoState> {
        let node = self.choreo_node(instance_id)?;
        Ok(self.nodes[node].choreo.as_ref().unwrap())
    }

    /// Playhead beat index (-1 until the first clock after start/reset).
    pub fn choreo_playhead(&self, instance_id: &str) -> Result<i64> {
        let node = self.choreo_node(instance_id)?;
        Ok(self.choreos[&node].shared.beat())
    }

    /// Mutate the state, then recompile and ship the program to the RT
    /// module. Every public edit funnels through here.
    fn choreo_edit(
        &mut self,
        instance_id: &str,
        f: impl FnOnce(&mut ChoreoState) -> Result<()>,
    ) -> Result<()> {
        let node = self.choreo_node(instance_id)?;
        let state = self.nodes[node].choreo.as_mut().unwrap();
        f(state)?;
        let program = std::sync::Arc::new(state.compile());
        self.choreos.get_mut(&node).unwrap().push(program)
    }

    /// Set the timeline length in beats (1..=MAX_CHOREO_BEATS); every
    /// track's data is truncated or default-extended.
    pub fn choreo_set_beats(&mut self, instance_id: &str, beats: usize) -> Result<()> {
        anyhow::ensure!(
            (1..=MAX_CHOREO_BEATS).contains(&beats),
            "beats must be 1..={MAX_CHOREO_BEATS}"
        );
        self.choreo_edit(instance_id, |st| {
            st.beats = beats;
            for t in &mut st.tracks {
                t.data.resize(beats);
            }
            Ok(())
        })
    }

    /// Add a track of `kind` ("boolean" | "continuous" | "note"),
    /// allocating its output jack slot(s). Returns the first jack slot.
    pub fn choreo_add_track(&mut self, instance_id: &str, name: &str, kind: &str) -> Result<usize> {
        anyhow::ensure!(!name.trim().is_empty(), "track name must not be empty");
        let node = self.choreo_node(instance_id)?;
        let n_jacks = self.nodes[node].manifest.outputs.len();
        let mut jack = None;
        self.choreo_edit(instance_id, |st| {
            anyhow::ensure!(
                st.tracks.iter().all(|t| t.name != name),
                "duplicate track name {name:?}"
            );
            let data = match kind {
                "boolean" => ChoreoTrackData::Boolean {
                    steps: vec![false; st.beats],
                },
                "continuous" => ChoreoTrackData::Continuous {
                    values: vec![0.0; st.beats],
                },
                "note" => ChoreoTrackData::Note {
                    octaves: 1,
                    scale: "major".into(),
                    base_note: 60,
                    steps: vec![None; st.beats],
                },
                other => anyhow::bail!("unknown track kind {other:?}"),
            };
            let slot = alloc_jacks(st, n_jacks, data.jack_count())?;
            jack = Some(slot);
            st.tracks.push(ChoreoTrack {
                name: name.to_string(),
                jack: slot,
                data,
            });
            Ok(())
        })?;
        Ok(jack.unwrap())
    }

    /// Replace the whole timeline in one edit (patch load and the
    /// undo/redo diff path — a single ring push regardless of track
    /// count). Tracks keep their saved jack slots so wires stay valid.
    pub fn choreo_set_state(&mut self, instance_id: &str, state: ChoreoState) -> Result<()> {
        anyhow::ensure!(
            (1..=MAX_CHOREO_BEATS).contains(&state.beats),
            "beats must be 1..={MAX_CHOREO_BEATS}"
        );
        let node = self.choreo_node(instance_id)?;
        let n_jacks = self.nodes[node].manifest.outputs.len();
        let mut used = vec![false; n_jacks];
        for t in &state.tracks {
            let end = t.jack + t.data.jack_count();
            anyhow::ensure!(end <= n_jacks, "track jack slot {} out of range", t.jack);
            anyhow::ensure!(
                !used[t.jack..end].iter().any(|u| *u),
                "track jack slot {} already in use",
                t.jack
            );
            used[t.jack..end].fill(true);
        }
        self.choreo_edit(instance_id, |st| {
            *st = state;
            for t in &mut st.tracks {
                t.data.resize(st.beats);
            }
            Ok(())
        })
    }

    /// Remove a track. The caller disconnects wires from its jacks first
    /// (the Tauri shell does, like gesture mapping removal).
    pub fn choreo_remove_track(&mut self, instance_id: &str, index: usize) -> Result<()> {
        self.choreo_edit(instance_id, |st| {
            anyhow::ensure!(index < st.tracks.len(), "no track {index}");
            st.tracks.remove(index);
            Ok(())
        })
    }

    pub fn choreo_rename_track(
        &mut self,
        instance_id: &str,
        index: usize,
        name: &str,
    ) -> Result<()> {
        anyhow::ensure!(!name.trim().is_empty(), "track name must not be empty");
        self.choreo_edit(instance_id, |st| {
            anyhow::ensure!(index < st.tracks.len(), "no track {index}");
            anyhow::ensure!(
                st.tracks
                    .iter()
                    .enumerate()
                    .all(|(i, t)| i == index || t.name != name),
                "duplicate track name {name:?}"
            );
            st.tracks[index].name = name.to_string();
            Ok(())
        })
    }

    /// Reorder: move the track at `from` to position `to` (display order
    /// only — jack slots stay with their tracks, so wires are unaffected).
    pub fn choreo_move_track(&mut self, instance_id: &str, from: usize, to: usize) -> Result<()> {
        self.choreo_edit(instance_id, |st| {
            anyhow::ensure!(from < st.tracks.len(), "no track {from}");
            anyhow::ensure!(to < st.tracks.len(), "no track position {to}");
            let t = st.tracks.remove(from);
            st.tracks.insert(to, t);
            Ok(())
        })
    }

    /// Toggle a boolean track's cell.
    pub fn choreo_set_bool(
        &mut self,
        instance_id: &str,
        index: usize,
        beat: usize,
        on: bool,
    ) -> Result<()> {
        self.choreo_edit(instance_id, |st| {
            anyhow::ensure!(beat < st.beats, "beat {beat} out of range");
            let t = st
                .tracks
                .get_mut(index)
                .ok_or_else(|| anyhow!("no track {index}"))?;
            match &mut t.data {
                ChoreoTrackData::Boolean { steps } => {
                    steps[beat] = on;
                    Ok(())
                }
                _ => Err(anyhow!("track {index} is not boolean")),
            }
        })
    }

    /// Write a run of continuous values starting at `start` (drag paints
    /// batch into one call). Values clamp to [-10, +10].
    pub fn choreo_set_values(
        &mut self,
        instance_id: &str,
        index: usize,
        start: usize,
        values: &[f32],
    ) -> Result<()> {
        self.choreo_edit(instance_id, |st| {
            anyhow::ensure!(
                start + values.len() <= st.beats,
                "range {start}..{} out of {} beats",
                start + values.len(),
                st.beats
            );
            let t = st
                .tracks
                .get_mut(index)
                .ok_or_else(|| anyhow!("no track {index}"))?;
            match &mut t.data {
                ChoreoTrackData::Continuous { values: v } => {
                    for (i, x) in values.iter().enumerate() {
                        v[start + i] = x.clamp(-10.0, 10.0);
                    }
                    Ok(())
                }
                _ => Err(anyhow!("track {index} is not continuous")),
            }
        })
    }

    /// Set or clear the (single) note at a beat of a note track.
    pub fn choreo_set_note(
        &mut self,
        instance_id: &str,
        index: usize,
        beat: usize,
        note: Option<NoteStep>,
    ) -> Result<()> {
        self.choreo_edit(instance_id, |st| {
            anyhow::ensure!(beat < st.beats, "beat {beat} out of range");
            let t = st
                .tracks
                .get_mut(index)
                .ok_or_else(|| anyhow!("no track {index}"))?;
            match &mut t.data {
                ChoreoTrackData::Note { steps, .. } => {
                    steps[beat] = note.map(|n| NoteStep {
                        degree: n.degree,
                        velocity: n.velocity.clamp(0.0, 1.0),
                    });
                    Ok(())
                }
                _ => Err(anyhow!("track {index} is not a note track")),
            }
        })
    }

    /// Note-track grid settings: octaves (1..=3), scale name, base MIDI
    /// note. Existing notes keep their degrees (clamped at compile time).
    pub fn choreo_set_note_settings(
        &mut self,
        instance_id: &str,
        index: usize,
        octaves: u8,
        scale: &str,
        base_note: u8,
    ) -> Result<()> {
        anyhow::ensure!((1..=3).contains(&octaves), "octaves must be 1..=3");
        anyhow::ensure!(
            crate::choreo::scale_intervals(scale).is_some(),
            "unknown scale {scale:?}"
        );
        anyhow::ensure!(base_note <= 127, "base note must be 0..=127");
        self.choreo_edit(instance_id, |st| {
            let t = st
                .tracks
                .get_mut(index)
                .ok_or_else(|| anyhow!("no track {index}"))?;
            match &mut t.data {
                ChoreoTrackData::Note {
                    octaves: o,
                    scale: sc,
                    base_note: b,
                    ..
                } => {
                    *o = octaves;
                    *sc = scale.to_string();
                    *b = base_note;
                    Ok(())
                }
                _ => Err(anyhow!("track {index} is not a note track")),
            }
        })
    }
}

/// First run of `count` contiguous jack slots not owned by any track.
fn alloc_jacks(st: &ChoreoState, n_jacks: usize, count: usize) -> Result<usize> {
    let mut used = vec![false; n_jacks];
    for t in &st.tracks {
        used[t.jack..(t.jack + t.data.jack_count()).min(n_jacks)].fill(true);
    }
    (0..=n_jacks.saturating_sub(count))
        .find(|&s| (s..s + count).all(|j| !used[j]))
        .ok_or_else(|| anyhow!("no free track slots (max {n_jacks} jacks)"))
}
