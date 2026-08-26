//! Decks module (`builtin.decks`) control: what each of the eight slots
//! plays, how it is mixed, and where it sits on the bank's grid; methods
//! on [`Engine`] only.
//!
//! The BINDING and the AUDIO are separate, exactly as they are for a Beat
//! Clip: a patch keeps [`DecksState`] (which clip, plus level/EQ/mute/
//! solo/tail/phase) and the samples come from the app layer, which
//! re-assembles them after a load — [`Engine::decks_pending`] lists the
//! slots still waiting.
//!
//! Every write goes through [`Engine::write_slot`], so the control-side
//! state and the RT mirror can never disagree, whether the edit came from
//! the panel or off the Launch Control XL.

use super::*;
use crate::decks::{
    align_beats, cycle_beats, slots_align, DeckSlotState, DeckSlotStatus, DecksCmd, DecksState,
    DecksStatus, SlotControl, EQ_MAX, IN_BPM, MAX_TAIL_BEATS, SLOTS, SURFACE_PARAM,
};
use crate::launch_control::BUTTON_GATE_VOLTS;

impl Engine {
    fn decks_node(&self, instance_id: &str) -> Result<usize> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.clip_decks.contains_key(&node),
            "{instance_id:?} is not a Decks module"
        );
        Ok(node)
    }

    fn check_slot(slot: usize) -> Result<()> {
        anyhow::ensure!(slot < SLOTS, "slot {slot} is outside the bank (0..{SLOTS})");
        Ok(())
    }

    /// Ship one slot's control state to the RT thread. Mix and timing are
    /// separate commands because a fader drag streams and a phase shift
    /// does not.
    fn push_slot(&mut self, node: usize, slot: usize) -> Result<()> {
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        let s = &ctl.state.slots[slot];
        let (mix, timing) = (
            DecksCmd::Mix {
                slot: slot as u8,
                level: s.level,
                low: s.low,
                mid: s.mid,
                high: s.high,
                mute: s.mute,
                solo: s.solo,
            },
            DecksCmd::Timing {
                slot: slot as u8,
                tail: s.tail,
                phase: s.phase,
            },
        );
        ctl.tx
            .push(mix)
            .map_err(|_| anyhow!("too many pending deck edits"))?;
        ctl.tx
            .push(timing)
            .map_err(|_| anyhow!("too many pending deck edits"))?;
        Ok(())
    }

    /// Edit one slot's control state and mirror it to the RT thread.
    fn write_slot(
        &mut self,
        node: usize,
        slot: usize,
        edit: impl FnOnce(&mut DeckSlotState),
    ) -> Result<()> {
        Self::check_slot(slot)?;
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        edit(&mut ctl.state.slots[slot]);
        self.push_slot(node, slot)
    }

    /// Every Decks module on the rack, in instance-id order — the tab has
    /// to find the bank it draws.
    pub fn decks_nodes(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .clip_decks
            .keys()
            .filter_map(|n| self.nodes.get(*n).map(|i| i.instance_id.clone()))
            .collect();
        ids.sort();
        ids
    }

    /// Put a clip in a slot: the audio (assembled by the app layer), what
    /// one of its beats means, and the binding a patch will remember.
    ///
    /// The slot lands MUTED and un-shifted, so it enters the running bank
    /// on the shared grid — an eight-beat clip and a two-beat clip start
    /// together — and it makes no sound until the user says so.
    pub fn decks_load(
        &mut self,
        instance_id: &str,
        slot: usize,
        clip: Option<BeatClipRef>,
        audio: TrackData,
        source_bpm: f64,
    ) -> Result<()> {
        self.hand_slot_clip(instance_id, slot, clip, audio, source_bpm, true)
    }

    /// Hand a slot the audio behind a binding it ALREADY has (patch load,
    /// undo, paste — see [`Engine::decks_pending`]). Everything the user
    /// set stays: this is the samples arriving late, not a new clip.
    pub fn decks_supply(
        &mut self,
        instance_id: &str,
        slot: usize,
        clip: Option<BeatClipRef>,
        audio: TrackData,
        source_bpm: f64,
    ) -> Result<()> {
        self.hand_slot_clip(instance_id, slot, clip, audio, source_bpm, false)
    }

    fn hand_slot_clip(
        &mut self,
        instance_id: &str,
        slot: usize,
        clip: Option<BeatClipRef>,
        audio: TrackData,
        source_bpm: f64,
        fresh: bool,
    ) -> Result<()> {
        Self::check_slot(slot)?;
        let node = self.decks_node(instance_id)?;
        let audio = Arc::new(audio);
        let source_bpm = source_bpm.max(1.0) as f32;
        let beats = crate::decks::beats_of(audio.duration_secs(), source_bpm as f64);
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        // Reclaim clips the RT thread replaced earlier.
        while ctl.garbage_rx.pop().is_ok() {}
        ctl.tracks[slot] = Some(audio.clone());
        let s = &mut ctl.state.slots[slot];
        s.clip = clip;
        s.beats = beats;
        s.source_bpm = source_bpm;
        if fresh {
            s.tail = 0;
            s.phase = 0;
            s.mute = true;
        }
        ctl.tx
            .push(DecksCmd::Load {
                slot: slot as u8,
                track: Some(audio),
                beats,
                source_bpm,
            })
            .map_err(|_| anyhow!("too many pending clip loads"))?;
        self.push_slot(node, slot)
    }

    /// Park the whole bank on beat 0 — the transport's one button. Not a
    /// patch edit: where the clock is is not saved state.
    pub fn decks_reset(&mut self, instance_id: &str) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        ctl.tx
            .push(DecksCmd::Reset)
            .map_err(|_| anyhow!("too many pending deck edits"))
    }

    /// Load a rendered clip from a file (tests and E2E cases, where the
    /// Beatify project a binding would name does not exist).
    pub fn decks_load_file(
        &mut self,
        instance_id: &str,
        slot: usize,
        path: &std::path::Path,
        source_bpm: f64,
    ) -> Result<()> {
        let audio = decode_file(path)?;
        self.decks_load(instance_id, slot, None, audio, source_bpm)
    }

    /// Empty a slot: the binding, the audio and the clip's length go; the
    /// mix the user set stays, because the fader is a property of the
    /// slot, not of what was in it.
    pub fn decks_clear(&mut self, instance_id: &str, slot: usize) -> Result<()> {
        Self::check_slot(slot)?;
        let node = self.decks_node(instance_id)?;
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        while ctl.garbage_rx.pop().is_ok() {}
        ctl.tracks[slot] = None;
        let s = &mut ctl.state.slots[slot];
        s.clip = None;
        s.beats = 0;
        s.tail = 0;
        s.phase = 0;
        s.mute = true;
        ctl.tx
            .push(DecksCmd::Load {
                slot: slot as u8,
                track: None,
                beats: 0,
                source_bpm: s.source_bpm,
            })
            .map_err(|_| anyhow!("too many pending clip loads"))?;
        self.push_slot(node, slot)
    }

    /// Set one of a slot's six controls. Levels and tone controls take
    /// their value; the two buttons take anything at or above the gate
    /// threshold as "on".
    pub fn decks_set_control(
        &mut self,
        instance_id: &str,
        slot: usize,
        control: SlotControl,
        value: f32,
    ) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        self.write_slot(node, slot, |s| match control {
            SlotControl::Level => s.level = value.clamp(0.0, 1.0),
            SlotControl::High => s.high = value.clamp(0.0, EQ_MAX),
            SlotControl::Mid => s.mid = value.clamp(0.0, EQ_MAX),
            SlotControl::Low => s.low = value.clamp(0.0, EQ_MAX),
            SlotControl::Mute => s.mute = value >= 1.0,
            SlotControl::Solo => s.solo = value >= 1.0,
        })
    }

    /// Beats of silence played after the clip before it comes round.
    pub fn decks_set_tail(&mut self, instance_id: &str, slot: usize, tail: u32) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        self.write_slot(node, slot, |s| s.tail = tail.min(MAX_TAIL_BEATS))
    }

    /// Shift the whole slot along the bank's grid, in whole beats. The
    /// shift is kept inside one loop length, so "shift right" on the last
    /// beat comes back to zero instead of counting off to infinity.
    pub fn decks_set_phase(&mut self, instance_id: &str, slot: usize, phase: i32) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        self.write_slot(node, slot, |s| {
            let len = s.length_beats() as i32;
            s.phase = if len > 0 { phase.rem_euclid(len) } else { 0 };
        })
    }

    /// The bank's control state, for the patch.
    pub fn decks_state(&self, instance_id: &str) -> Result<DecksState> {
        let node = self.decks_node(instance_id)?;
        Ok(self.clip_decks[&node].state.clone())
    }

    /// Restore a saved bank (patch load, undo). The clips' AUDIO is not
    /// here — `decks_pending` reports the slots the app layer must
    /// re-assemble.
    pub fn decks_set_state(&mut self, instance_id: &str, state: DecksState) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        let state = state.normalized();
        {
            let ctl = self.clip_decks.get_mut(&node).unwrap();
            for (slot, s) in state.slots.iter().enumerate() {
                // A slot whose binding changed loses the audio it held;
                // one that only changed its mix keeps playing.
                if ctl.state.slots[slot].clip != s.clip {
                    ctl.tracks[slot] = None;
                    ctl.tx
                        .push(DecksCmd::Load {
                            slot: slot as u8,
                            track: None,
                            beats: 0,
                            source_bpm: s.source_bpm,
                        })
                        .map_err(|_| anyhow!("too many pending clip loads"))?;
                }
            }
            ctl.state = state;
        }
        for slot in 0..SLOTS {
            self.push_slot(node, slot)?;
        }
        Ok(())
    }

    /// Slots that know which clip they play but have no audio behind it —
    /// after a patch load, an undo that recreated the module, or a paste.
    pub fn decks_pending(&self) -> Vec<(String, usize, BeatClipRef)> {
        let mut out = Vec::new();
        for (node, ctl) in &self.clip_decks {
            let Some(info) = self.nodes.get(*node) else {
                continue;
            };
            for (slot, s) in ctl.state.slots.iter().enumerate() {
                if let Some(clip) = &s.clip {
                    if ctl.tracks[slot].is_none() {
                        out.push((info.instance_id.clone(), slot, clip.clone()));
                    }
                }
            }
        }
        out.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
        out
    }

    /// Bank + slot snapshot for UIs. Tempo, phase and per-slot positions
    /// come from the RT thread's last processed block.
    pub fn decks_status(&self, instance_id: &str) -> Result<DecksStatus> {
        let node = self.decks_node(instance_id)?;
        let ctl = &self.clip_decks[&node];
        let bank_bpm = self.knob_value(node, IN_BPM) as f64;
        let lengths = ctl.state.lengths();
        let slots = ctl
            .state
            .slots
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let len = s.length_beats();
                // Every OTHER loaded slot: a clip is not out of phase
                // with itself.
                let others: Vec<u32> = ctl
                    .state
                    .slots
                    .iter()
                    .enumerate()
                    .filter(|(j, o)| *j != i && o.length_beats() > 0)
                    .map(|(_, o)| o.length_beats())
                    .collect();
                DeckSlotStatus {
                    slot: i,
                    clip: s.clip.clone(),
                    loaded: ctl.tracks[i].is_some(),
                    beats: s.beats,
                    tail: s.tail,
                    phase: s.phase,
                    source_bpm: s.source_bpm,
                    stretch: bank_bpm / s.source_bpm.max(1.0) as f64,
                    level: s.level,
                    low: s.low,
                    mid: s.mid,
                    high: s.high,
                    mute: s.mute,
                    solo: s.solo,
                    align_beats: if len > 0 {
                        align_beats(len, &others)
                    } else {
                        0
                    },
                    aligned: len == 0 || others.iter().all(|o| slots_align(len, *o)),
                    duration_secs: ctl.tracks[i]
                        .as_ref()
                        .map(|t| t.duration_secs())
                        .unwrap_or(0.0),
                    position_secs: ctl.shared.slot_position_secs(i),
                    beat: ctl.shared.slot_beat(i),
                    playing: ctl.shared.slot_playing(i),
                }
            })
            .collect();
        Ok(DecksStatus {
            bpm: bank_bpm,
            beat: ctl.shared.beat(),
            cycle_beats: cycle_beats(&lengths),
            surface: self.nodes[node].params.get(SURFACE_PARAM).copied() != Some(0.0),
            surface_connected: self.launchcontrol_connected(),
            slots,
        })
    }

    /// Feed one raw Launch Control XL message to every bank that follows
    /// the surface (the DEVICE feed — the app's hot-plug watcher). Knobs
    /// and faders SET their control; the two buttons are momentary on the
    /// device and TOGGLE mute/solo on the press, because a mute you have
    /// to keep your finger on is not a mute.
    pub fn decks_feed(&mut self, data: [u8; 3]) -> Result<()> {
        let nodes: Vec<usize> = self
            .clip_decks
            .keys()
            .copied()
            .filter(|n| {
                self.nodes
                    .get(*n)
                    .and_then(|i| i.params.get(SURFACE_PARAM).copied())
                    != Some(0.0)
            })
            .collect();
        for node in nodes {
            self.feed_surface(node, data)?;
        }
        Ok(())
    }

    /// Feed one bank directly, whatever its `surface` param says — the
    /// deterministic seam tests, offline renders and goldens use.
    pub fn decks_inject(&mut self, instance_id: &str, data: [u8; 3]) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        self.feed_surface(node, data)
    }

    fn feed_surface(&mut self, node: usize, data: [u8; 3]) -> Result<()> {
        // Decode + dedup control-side (the device repeats a knob against
        // its end stop), then apply exactly what changed.
        let mut hit = None;
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        ctl.surface
            .feed(data, |jack, volts| hit = Some((jack, volts)));
        let Some((jack, volts)) = hit else {
            return Ok(());
        };
        let Some((slot, control)) = crate::decks::surface_target(jack) else {
            return Ok(());
        };
        if control.is_button() {
            // Only the press acts; the release is what makes the next
            // press a fresh one.
            if volts < BUTTON_GATE_VOLTS {
                return Ok(());
            }
            return self.write_slot(node, slot, |s| match control {
                SlotControl::Mute => s.mute = !s.mute,
                SlotControl::Solo => s.solo = !s.solo,
                _ => {}
            });
        }
        let value = control.value_of_volts(volts);
        self.write_slot(node, slot, |s| match control {
            SlotControl::Level => s.level = value,
            SlotControl::High => s.high = value,
            SlotControl::Mid => s.mid = value,
            SlotControl::Low => s.low = value,
            _ => {}
        })
    }
}
