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
//! the panel or off the Launch Control XL. The bank's two output faders
//! ([`Engine::decks_set_master`]) are the same shape one level up: bank
//! state in the patch, mirrored to the RT thread.

use super::*;
use crate::decks::{
    cycle_beats, led_for, return_jack, tone_jack, DeckArm, DeckSlotState, DeckSlotStatus, DecksCmd,
    DecksState, DecksStatus, MasterBus, SlotControl, EQ_MAX, IN_BPM, LEVEL_MAX, MAX_TAIL_BEATS,
    MOMENTARY_RELEASE_SECS, SLOTS, SURFACE_PARAM,
};
use crate::launch_control::{jack_index, row, BUTTON_GATE_VOLTS};

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
                monitor: s.monitor,
                wet: s.wet,
                insert_monitor: s.insert_monitor,
            },
            // The GRID, not the raw clip: a deck's ratio is applied here,
            // once, so the RT thread only ever sees beats of the bank's
            // own grid and the tempo they are read at.
            DecksCmd::Timing {
                slot: slot as u8,
                beats: s.grid_beats(),
                source_bpm: s.grid_bpm(),
                tail: s.tail,
                phase: s.phase,
            },
        );
        // The surface's lamps show mute and monitor, so any write to a
        // slot leaves them owing an update.
        ctl.leds_dirty[slot] = true;
        ctl.tx
            .push(mix)
            .map_err(|_| anyhow!("too many pending deck edits"))?;
        ctl.tx
            .push(timing)
            .map_err(|_| anyhow!("too many pending deck edits"))?;
        Ok(())
    }

    /// Ship both output faders to the RT thread. They travel together
    /// because they are one command, not because they move together.
    fn push_master(&mut self, node: usize) -> Result<()> {
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        let cmd = DecksCmd::Master {
            live: ctl.state.master_live,
            monitor: ctl.state.master_monitor,
        };
        ctl.tx
            .push(cmd)
            .map_err(|_| anyhow!("too many pending deck edits"))
    }

    /// The fader on one of the bank's two output pairs: everything going
    /// to the room, or everything going to the headphones. Patch state
    /// like the slot mix, and independent of it — a master is the last
    /// thing the pair passes through, so cueing a deck is unaffected by
    /// what the room is being given.
    pub fn decks_set_master(
        &mut self,
        instance_id: &str,
        bus: MasterBus,
        value: f32,
    ) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        let value = value.clamp(0.0, 1.0);
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        match bus {
            MasterBus::Live => ctl.state.master_live = value,
            MasterBus::Monitor => ctl.state.master_monitor = value,
        }
        self.push_master(node)
    }

    /// Which of a slot's three tone-control CV outputs are patched into
    /// the rack, in [`TONES`] order.
    fn tone_patched(&self, node: usize, slot: usize) -> [bool; 3] {
        let mut out = [false; 3];
        for (t, patched) in out.iter_mut().enumerate() {
            let jack = tone_jack(slot, t);
            *patched = self
                .wires
                .iter()
                .any(|w| w.from_node == node && w.from_jack == jack);
        }
        out
    }

    /// Whether a slot's return is wired — the modules feeding it are the
    /// deck's insert, and its wetness knob has something to fade into.
    fn insert_wired(&self, node: usize, slot: usize) -> bool {
        let jack = return_jack(slot);
        self.wires
            .iter()
            .any(|w| w.to_node == node && w.to_jack == jack)
    }

    /// Tell every bank which of its tone controls have left the deck for
    /// the rack. Called after any wire change, because that is the only
    /// thing that can change the answer.
    pub(crate) fn sync_decks_routing(&mut self) {
        let nodes: Vec<usize> = self.clip_decks.keys().copied().collect();
        for node in nodes {
            for slot in 0..SLOTS {
                let patched = self.tone_patched(node, slot);
                let ctl = self.clip_decks.get_mut(&node).unwrap();
                let _ = ctl.tx.push(DecksCmd::Tone {
                    slot: slot as u8,
                    patched,
                });
            }
        }
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

    /// Which of a bank's two output pairs go NOWHERE AT ALL — the live
    /// pair and the cue pair, in that order. A pair wired to anything (an
    /// output module, an effect, one channel of a mixer) is the user's
    /// routing and does not count as loose.
    pub fn decks_loose_outputs(&self, instance_id: &str) -> Result<(bool, bool)> {
        let node = self.decks_node(instance_id)?;
        let loose = |a: &str, b: &str| -> Result<bool> {
            let (a, b) = (self.out_jack_index(node, a)?, self.out_jack_index(node, b)?);
            Ok(!self
                .wires
                .iter()
                .any(|w| w.from_node == node && (w.from_jack == a || w.from_jack == b)))
        };
        Ok((loose("audio_l", "audio_r")?, loose("mon_l", "mon_r")?))
    }

    /// Give a bank somewhere to play: its live pair to an Audio Output and
    /// its cue pair to a Monitor Output, adding whichever of those two the
    /// patch does not have.
    ///
    /// A BANK YOU CANNOT HEAR IS NOT A BANK — the live pair used to be
    /// wired only if the patch already happened to own an Audio Output,
    /// while the cue pair always got a Monitor Output of its own, so a
    /// bank added to a patch without one played through the headphones
    /// and nowhere else. Idempotent, and it only ever touches a pair that
    /// is wired to NOTHING ([`Engine::decks_loose_outputs`]): a bank the
    /// user has routed through the rack is left exactly as they left it.
    pub fn decks_connect_outputs(&mut self, instance_id: &str) -> Result<()> {
        let (live, monitor) = self.decks_loose_outputs(instance_id)?;
        // Outputs live in the bank's own workspace: a decks-tab bank must
        // not reach across into (or borrow) the Rack tab's output modules.
        let workspace = self.module_workspace(instance_id)?;
        for (loose, ext_id, stem, pair) in [
            (
                live,
                crate::builtin::AUDIO_OUT_ID,
                "out",
                ["audio_l", "audio_r"],
            ),
            (
                monitor,
                crate::builtin::MONITOR_OUT_ID,
                "monitor",
                ["mon_l", "mon_r"],
            ),
        ] {
            if !loose {
                continue;
            }
            let existing = self
                .nodes
                .iter()
                .find(|n| n.ext_id == ext_id && n.workspace == workspace)
                .map(|n| n.instance_id.clone());
            let out = match existing {
                Some(existing) => existing,
                None => {
                    let id = self.fresh_instance_id(stem);
                    self.add_module(&id, ext_id)?;
                    self.set_module_workspace(&id, workspace)?;
                    id
                }
            };
            for (jack, channel) in pair.into_iter().zip(["l", "r"]) {
                self.connect(instance_id, jack, &out, channel)?;
            }
        }
        Ok(())
    }

    /// `stem1`, `stem2`, … — the first one no module is called.
    fn fresh_instance_id(&self, stem: &str) -> String {
        (1..)
            .map(|n| format!("{stem}{n}"))
            .find(|id| !self.node_by_id.contains_key(id))
            .unwrap()
    }

    /// Put a clip in a slot: the audio (assembled by the app layer), what
    /// one of its beats means, and the binding a patch will remember.
    ///
    /// The slot lands CUED — unmuted, on the monitor pair — and
    /// un-shifted, so it enters the running bank on the shared grid — an
    /// eight-beat clip and a two-beat clip start together — and it plays
    /// in the headphones, not the live mix, until the user says so.
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
        // The clip a queue or a drop was armed on is the one leaving, and
        // the RT thread drops the arm with it.
        ctl.arm[slot] = DeckArm::None;
        let s = &mut ctl.state.slots[slot];
        s.clip = clip;
        s.beats = beats;
        s.source_bpm = source_bpm;
        if fresh {
            s.tail = 0;
            s.phase = 0;
            // On the bank's own grid: a ratio belonged to the clip that
            // just left, like the shift and the silence after it.
            s.ratio = 1.0;
            // A fresh clip lands cued: audible in the monitor, out of the
            // live mix, so a load never makes an unasked-for noise in the
            // room.
            s.mute = false;
            s.monitor = true;
        }
        ctl.tx
            .push(DecksCmd::Load {
                slot: slot as u8,
                track: Some(audio),
            })
            .map_err(|_| anyhow!("too many pending clip loads"))?;
        self.push_slot(node, slot)
    }

    /// Start or stop the bank's clock — the transport. A bank is created
    /// and restored STOPPED (nothing plays until it is asked to), and
    /// stopping parks it back on beat 0, so a start always comes in from
    /// the top of every clip. Not a patch edit: like an arm, where the
    /// clock is and whether it is moving are not saved state.
    pub fn decks_set_running(&mut self, instance_id: &str, running: bool) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        ctl.running = running;
        ctl.tx
            .push(DecksCmd::Transport { running })
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
        ctl.arm[slot] = DeckArm::None;
        let s = &mut ctl.state.slots[slot];
        s.clip = None;
        s.beats = 0;
        s.tail = 0;
        s.phase = 0;
        s.ratio = 1.0;
        s.mute = true;
        ctl.tx
            .push(DecksCmd::Load {
                slot: slot as u8,
                track: None,
            })
            .map_err(|_| anyhow!("too many pending clip loads"))?;
        self.push_slot(node, slot)
    }

    /// Set one of a slot's controls. Levels, tone controls and the
    /// wetness knob take their value; the buttons take anything at or
    /// above the gate threshold as "on".
    ///
    /// THE MUTE BUTTON OVERRULES THE CLOCK: reaching for it drops whatever
    /// queue or drop was armed, because a mute you press is a mute you
    /// want now.
    pub fn decks_set_control(
        &mut self,
        instance_id: &str,
        slot: usize,
        control: SlotControl,
        value: f32,
    ) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        self.write_slot(node, slot, |s| match control {
            SlotControl::Level => s.level = value.clamp(0.0, LEVEL_MAX),
            SlotControl::High => s.high = value.clamp(0.0, EQ_MAX),
            SlotControl::Mid => s.mid = value.clamp(0.0, EQ_MAX),
            SlotControl::Low => s.low = value.clamp(0.0, EQ_MAX),
            SlotControl::Mute => s.mute = value >= 1.0,
            SlotControl::Monitor => s.monitor = value >= 1.0,
            SlotControl::Wet => s.wet = value.clamp(0.0, 1.0),
            SlotControl::InsertMonitor => s.insert_monitor = value >= 1.0,
        })?;
        if control == SlotControl::Mute {
            self.push_arm(node, slot, DeckArm::None)?;
        }
        Ok(())
    }

    /// Hand one slot's arm to the RT thread — the clock is what decides
    /// when the mute beside it takes effect. Every ask carries a serial,
    /// which comes back on the shared block so the control thread can see
    /// that this arm (rather than an older one) has been fired.
    fn push_arm(&mut self, node: usize, slot: usize, arm: DeckArm) -> Result<()> {
        let ctl = self.clip_decks.get_mut(&node).unwrap();
        ctl.arm[slot] = arm;
        ctl.arm_serial[slot] += 1;
        let serial = ctl.arm_serial[slot];
        ctl.tx
            .push(DecksCmd::Arm {
                slot: slot as u8,
                arm,
                serial,
            })
            .map_err(|_| anyhow!("too many pending deck edits"))
    }

    /// QUEUE or DROP a deck: a mute that happens on the grid instead of
    /// under the finger. The mute is written HERE AND NOW — a queue
    /// unmutes, a drop mutes — and the RT thread holds it: a queued deck
    /// stays silent until its clip's own FIRST beat next comes round (so
    /// it always enters from the top of its loop, in phase like every
    /// other slot), a dropping one plays on until its clip has run out
    /// (so it is never cut mid-phrase).
    /// Nothing extra is persisted: the patch already keeps the mute the
    /// arm is on its way to.
    ///
    /// [`DeckArm::None`] CANCELS, which means putting the mute back the
    /// side it came from — and an arm the bank has already fired is
    /// nothing to cancel, so cancelling it is not an edit at all.
    pub fn decks_arm(&mut self, instance_id: &str, slot: usize, arm: DeckArm) -> Result<()> {
        Self::check_slot(slot)?;
        let node = self.decks_node(instance_id)?;
        let mute = match (arm, self.clip_decks[&node].live_arm(slot)) {
            (DeckArm::Queue, _) => false,
            (DeckArm::Drop, _) => true,
            (DeckArm::None, DeckArm::Queue) => true,
            (DeckArm::None, DeckArm::Drop) => false,
            (DeckArm::None, DeckArm::None) => return Ok(()),
        };
        self.write_slot(node, slot, |s| s.mute = mute)?;
        self.push_arm(node, slot, arm)
    }

    /// Beats of silence played after the clip before it comes round.
    pub fn decks_set_tail(&mut self, instance_id: &str, slot: usize, tail: u32) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        self.write_slot(node, slot, |s| s.tail = tail.min(MAX_TAIL_BEATS))
    }

    /// Run this deck at a RATIO of the bank's grid: 2 is double time, 1/2
    /// half time, 1 the clip on the grid as it was cut. It is the deck's
    /// baseline tempo that moves — the clip's grid is read at
    /// `source_bpm / ratio` — so the bank's one clock still drives it and
    /// the pitch does not move; what changes is that its beats (and its
    /// whole loop) come round `ratio` times as often as everyone else's.
    ///
    /// The loop it sits in just got shorter or longer, so the slot's
    /// shift is folded back inside it, exactly as [`Engine::decks_set_phase`]
    /// keeps it.
    pub fn decks_set_ratio(&mut self, instance_id: &str, slot: usize, ratio: f32) -> Result<()> {
        let node = self.decks_node(instance_id)?;
        self.write_slot(node, slot, |s| {
            s.ratio = crate::decks::clamp_ratio(ratio);
            let len = s.length_beats() as i32;
            s.phase = if len > 0 { s.phase.rem_euclid(len) } else { 0 };
        })
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
                        })
                        .map_err(|_| anyhow!("too many pending clip loads"))?;
                }
            }
            ctl.state = state;
        }
        self.push_master(node)?;
        for slot in 0..SLOTS {
            self.push_slot(node, slot)?;
            // A restored bank comes back UNARMED: the mute in the patch is
            // the whole truth about a slot, and no clock is owed anything.
            self.push_arm(node, slot, DeckArm::None)?;
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
            .map(|(i, s)| DeckSlotStatus {
                slot: i,
                clip: s.clip.clone(),
                loaded: ctl.tracks[i].is_some(),
                // The clip AS THE BANK COUNTS IT: a deck at a ratio takes
                // that share of the grid, and its stretch is against the
                // baseline the ratio put it on.
                beats: s.grid_beats(),
                tail: s.tail,
                phase: s.phase,
                source_bpm: s.source_bpm,
                ratio: s.ratio,
                stretch: bank_bpm / s.grid_bpm() as f64,
                level: s.level,
                low: s.low,
                mid: s.mid,
                high: s.high,
                mute: s.mute,
                monitor: s.monitor,
                wet: s.wet,
                insert_monitor: s.insert_monitor,
                insert: self.insert_wired(node, i),
                tone_patched: self.tone_patched(node, i),
                duration_secs: ctl.tracks[i]
                    .as_ref()
                    .map(|t| t.duration_secs())
                    .unwrap_or(0.0),
                position_secs: ctl.shared.slot_position_secs(i),
                beat: ctl.shared.slot_beat(i),
                sounding: ctl.shared.slot_sounding(i),
                playing: ctl.shared.slot_playing(i),
                output_level: ctl.shared.slot_output_level(i),
                arm: ctl.live_arm(i),
            })
            .collect();
        Ok(DecksStatus {
            bpm: bank_bpm,
            running: ctl.running,
            beat: ctl.shared.beat(),
            cycle_beats: cycle_beats(&lengths),
            surface: self.nodes[node].params.get(SURFACE_PARAM).copied() != Some(0.0),
            surface_connected: self.launchcontrol_connected(),
            master_live: ctl.state.master_live,
            master_monitor: ctl.state.master_monitor,
            slots,
        })
    }

    /// Feed one raw Launch Control XL message to every bank that follows
    /// the surface (the DEVICE feed — the app's hot-plug watcher). Knobs
    /// and faders SET their control; the two buttons TOGGLE mute/monitor,
    /// because a mute you have to keep your finger on is not a mute.
    ///
    /// ONE PRESS IS ONE CHANGE, whichever kind of button the template
    /// gives us. A momentary button sends an on when it goes down and an
    /// off when it comes back up; a factory-template toggle sends the on
    /// on one press and the OFF on the next — so acting on the on alone
    /// meant every second press did nothing (you had to double-tap). Both
    /// edges act now, except an off that lands within
    /// [`MOMENTARY_RELEASE_SECS`] of its own on: that is a finger coming
    /// off, not a second press.
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
        // LEDs go back out on the channel the device is talking on.
        ctl.surface_channel = data[0] & 0x0F;
        ctl.surface
            .feed(data, |jack, volts| hit = Some((jack, volts)));
        let Some((jack, volts)) = hit else {
            return Ok(());
        };
        let Some((slot, control)) = crate::decks::surface_target(jack) else {
            return Ok(());
        };
        if control.is_button() {
            let button = slot * 2 + usize::from(control == SlotControl::Monitor);
            if volts >= BUTTON_GATE_VOLTS {
                ctl.button_down[button] = Some(std::time::Instant::now());
            } else if ctl.button_down[button]
                .is_some_and(|down| down.elapsed().as_secs_f64() <= MOMENTARY_RELEASE_SECS)
            {
                // A finger coming off a momentary button, not a press.
                ctl.button_down[button] = None;
                return Ok(());
            }
            self.write_slot(node, slot, |s| match control {
                SlotControl::Mute => s.mute = !s.mute,
                SlotControl::Monitor => s.monitor = !s.monitor,
                _ => {}
            })?;
            if control == SlotControl::Mute {
                // The hardware mute overrules the clock too.
                self.push_arm(node, slot, DeckArm::None)?;
            }
            return Ok(());
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

    /// Lamp messages the surface is owed: mute lights red, monitor lights
    /// green, on the channel the device last spoke on. Only banks that
    /// follow the surface light it, and only slots whose state has moved
    /// since the last drain — the app pumps this to the device's output
    /// port, exactly like a MIDI module's LED feedback.
    pub fn decks_drain_leds(&mut self) -> Vec<MidiOutEvent> {
        let mut out = Vec::new();
        for (node, ctl) in self.clip_decks.iter_mut() {
            let follows = self
                .nodes
                .get(*node)
                .and_then(|i| i.params.get(SURFACE_PARAM).copied())
                != Some(0.0);
            if !follows {
                // A bank that is not driving the surface must not light it.
                ctl.leds_dirty = [false; SLOTS];
                continue;
            }
            for slot in 0..SLOTS {
                if !std::mem::replace(&mut ctl.leds_dirty[slot], false) {
                    continue;
                }
                let s = &ctl.state.slots[slot];
                let (mute, monitor) = led_for(s.mute, s.monitor);
                let status = 0x90 | ctl.surface_channel;
                for (jack_row, velocity) in [(row::FOCUS, mute), (row::CONTROL, monitor)] {
                    if let Some(note) = crate::launch_control::note_for(jack_index(slot, jack_row))
                    {
                        out.push(MidiOutEvent {
                            frame: 0,
                            data: [status, note, velocity],
                        });
                    }
                }
            }
        }
        out
    }

    /// Say the lamps are owed again — after a surface (re)connect, when
    /// the device has forgotten everything it was showing.
    pub fn decks_relight_surface(&mut self) {
        for ctl in self.clip_decks.values_mut() {
            ctl.leds_dirty = [true; SLOTS];
        }
    }
}
