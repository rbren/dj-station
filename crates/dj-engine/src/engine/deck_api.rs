//! Playback and DJ Deck (M2) control — split out of the old monolithic engine.rs; methods on [`Engine`] only.

use super::*;

impl Engine {
    // ------------------------------------------------------------------
    // Playback
    // ------------------------------------------------------------------

    /// Decode an audio file (control thread) and hand it to a Playback node
    /// (picked up lock-free at the next block boundary). Works stopped or
    /// running.
    pub fn playback_load(&mut self, instance_id: &str, path: &std::path::Path) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.playback_producers.contains_key(&node),
            "{instance_id:?} is not a Playback module"
        );
        let data = Arc::new(decode_file(path)?);
        // Reclaim tracks the RT thread replaced earlier.
        if let Some(rx) = self.playback_garbage.get_mut(&node) {
            while rx.pop().is_ok() {}
        }
        self.playback_producers
            .get_mut(&node)
            .unwrap()
            .push(data)
            .map_err(|_| anyhow!("too many pending track loads"))?;
        self.nodes[node].track_path = Some(path.to_string_lossy().to_string());
        Ok(())
    }

    /// Path of the track currently loaded into a Playback node, if any.
    pub fn playback_track(&self, instance_id: &str) -> Result<Option<String>> {
        let node = self.node_idx(instance_id)?;
        Ok(self.nodes[node].track_path.clone())
    }

    // ------------------------------------------------------------------
    // DJ Deck (M2)
    // ------------------------------------------------------------------

    fn deck_node(&self, instance_id: &str) -> Result<usize> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.decks.contains_key(&node),
            "{instance_id:?} is not a DJ Deck module"
        );
        Ok(node)
    }

    /// Push a command to a deck's RT ring (works stopped or running; the
    /// ring is drained at the next processed block).
    fn deck_push(&mut self, node: usize, cmd: DeckCmd) -> Result<()> {
        // Reclaim tracks the RT thread replaced earlier.
        let ctl = self.decks.get_mut(&node).unwrap();
        while ctl.garbage_rx.pop().is_ok() {}
        ctl.cmd_tx
            .push(cmd)
            .map_err(|_| anyhow!("deck command queue full"))
    }

    /// Decode an audio file (control thread) and load it into a deck.
    /// Clears deck-side grid/cues/loop; callers re-apply track metadata
    /// from the library (the canonical cross-patch store).
    pub fn deck_load(&mut self, instance_id: &str, path: &std::path::Path) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        let data = Arc::new(decode_file(path)?);
        {
            let ctl = self.decks.get_mut(&node).unwrap();
            ctl.track = Some(data.clone());
            ctl.stems = None; // the RT Load handler drops the old stems
            ctl.grid = None;
            ctl.cues = [None; N_CUES];
            ctl.loop_region = None;
            ctl.loop_enabled = false;
            ctl.taps.clear();
        }
        self.deck_push(node, DeckCmd::Load(data))?;
        self.nodes[node].track_path = Some(path.to_string_lossy().to_string());
        Ok(())
    }

    /// Path of the track currently loaded into a deck, if any.
    pub fn deck_track(&self, instance_id: &str) -> Result<Option<String>> {
        let node = self.deck_node(instance_id)?;
        Ok(self.nodes[node].track_path.clone())
    }

    /// Decode four stem files (control thread; [`crate::deck::STEM_IDS`]
    /// order — vocals/drums/bass/other) and load them into a deck. The
    /// stems must match the loaded track's sample rate; shorter/longer
    /// stems are fine (reads past the end are silent).
    pub fn deck_load_stems(
        &mut self,
        instance_id: &str,
        paths: &[std::path::PathBuf; crate::deck::N_STEMS],
    ) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        let track_sr = {
            let ctl = &self.decks[&node];
            ctl.track
                .as_ref()
                .ok_or_else(|| anyhow!("deck {instance_id} has no track loaded"))?
                .sample_rate
        };
        let mut decoded = Vec::with_capacity(crate::deck::N_STEMS);
        for (path, stem) in paths.iter().zip(crate::deck::STEM_IDS) {
            let data = decode_file(path)
                .map_err(|e| anyhow!("decoding {stem} stem {}: {e}", path.display()))?;
            anyhow::ensure!(
                data.sample_rate == track_sr,
                "{stem} stem sample rate {} != track {}",
                data.sample_rate,
                track_sr
            );
            decoded.push(data);
        }
        let stems: [TrackData; crate::deck::N_STEMS] =
            decoded.try_into().map_err(|_| anyhow!("stem count"))?;
        let data = Arc::new(crate::deck::StemData { stems });
        let path_strs: [String; crate::deck::N_STEMS] =
            std::array::from_fn(|i| paths[i].to_string_lossy().to_string());
        self.decks.get_mut(&node).unwrap().stems = Some((data.clone(), path_strs));
        self.deck_push(node, DeckCmd::LoadStems(Some(data)))
    }

    /// Unload stems: the deck reverts to playing the original mix.
    pub fn deck_clear_stems(&mut self, instance_id: &str) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        self.decks.get_mut(&node).unwrap().stems = None;
        self.deck_push(node, DeckCmd::LoadStems(None))
    }

    /// Stem file paths currently loaded into a deck, if any.
    pub fn deck_stems(&self, instance_id: &str) -> Result<Option<[String; crate::deck::N_STEMS]>> {
        let node = self.deck_node(instance_id)?;
        Ok(self.decks[&node].stems.as_ref().map(|(_, p)| p.clone()))
    }

    /// Set (bpm > 0) or clear (bpm <= 0) the manual beatgrid.
    pub fn deck_set_beatgrid(
        &mut self,
        instance_id: &str,
        bpm: f64,
        anchor_secs: f64,
    ) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        self.decks.get_mut(&node).unwrap().grid = (bpm > 0.0).then_some((bpm, anchor_secs));
        self.deck_push(node, DeckCmd::Grid { bpm, anchor_secs })
    }

    /// Current beatgrid as (bpm, anchor_secs).
    pub fn deck_beatgrid(&self, instance_id: &str) -> Result<Option<(f64, f64)>> {
        let node = self.deck_node(instance_id)?;
        Ok(self.decks[&node].grid)
    }

    /// Shift the beatgrid anchor by `delta_secs` (grid nudge).
    pub fn deck_nudge_beatgrid(&mut self, instance_id: &str, delta_secs: f64) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        let (bpm, anchor) = self.decks[&node]
            .grid
            .ok_or_else(|| anyhow!("no beatgrid to nudge on {instance_id:?}"))?;
        self.deck_set_beatgrid(instance_id, bpm, anchor + delta_secs)
    }

    /// Move the beatgrid anchor to the current playhead position.
    pub fn deck_anchor_here(&mut self, instance_id: &str) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        let (bpm, _) = self.decks[&node]
            .grid
            .ok_or_else(|| anyhow!("no beatgrid on {instance_id:?}; tap or set a tempo first"))?;
        let pos = self.decks[&node].shared.position_secs();
        self.deck_set_beatgrid(instance_id, bpm, pos)
    }

    /// Register a tap-tempo tap at an explicit track position (seconds).
    /// With two or more taps in a run, the beatgrid is set from the mean
    /// tap interval, anchored on the first tap. Returns the current grid.
    /// A gap of > 2.5 s (or a tap behind the previous one) starts a new run.
    pub fn deck_tap_tempo_at(
        &mut self,
        instance_id: &str,
        pos_secs: f64,
    ) -> Result<Option<(f64, f64)>> {
        let node = self.deck_node(instance_id)?;
        let ctl = self.decks.get_mut(&node).unwrap();
        if let Some(&last) = ctl.taps.last() {
            if pos_secs <= last || pos_secs - last > 2.5 {
                ctl.taps.clear();
            }
        }
        ctl.taps.push(pos_secs);
        if ctl.taps.len() > 9 {
            let drop_n = ctl.taps.len() - 9;
            ctl.taps.drain(..drop_n);
        }
        if ctl.taps.len() >= 2 {
            let taps = ctl.taps.clone();
            let n = taps.len();
            let mean = (taps[n - 1] - taps[0]) / (n - 1) as f64;
            let bpm = 60.0 / mean;
            let anchor = taps[0];
            self.deck_set_beatgrid(instance_id, bpm, anchor)?;
            return Ok(Some((bpm, anchor)));
        }
        Ok(self.decks[&node].grid)
    }

    /// Tap-tempo tap at the deck's current playhead position.
    pub fn deck_tap_tempo(&mut self, instance_id: &str) -> Result<Option<(f64, f64)>> {
        let node = self.deck_node(instance_id)?;
        let pos = self.decks[&node].shared.position_secs();
        self.deck_tap_tempo_at(instance_id, pos)
    }

    /// Set (`Some(pos)`) or clear (`None`) hot cue `slot` (0..=7).
    pub fn deck_set_cue(
        &mut self,
        instance_id: &str,
        slot: usize,
        pos_secs: Option<f64>,
    ) -> Result<()> {
        anyhow::ensure!(slot < N_CUES, "cue slot must be 0..=7, got {slot}");
        let node = self.deck_node(instance_id)?;
        self.decks.get_mut(&node).unwrap().cues[slot] = pos_secs;
        self.deck_push(
            node,
            DeckCmd::Cue {
                slot,
                pos_secs: pos_secs.unwrap_or(f64::NAN),
            },
        )
    }

    /// Hot cue positions (seconds), slot-indexed.
    pub fn deck_cues(&self, instance_id: &str) -> Result<[Option<f64>; N_CUES]> {
        let node = self.deck_node(instance_id)?;
        Ok(self.decks[&node].cues)
    }

    /// Seek the playhead to `pos_secs` (also used to jump to a cue from
    /// the UI; the `cue_trig` jacks do the same from the patch).
    pub fn deck_seek(&mut self, instance_id: &str, pos_secs: f64) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        self.deck_push(node, DeckCmd::Seek(pos_secs.max(0.0)))
    }

    /// Set the active loop region (loop in/out).
    pub fn deck_set_loop(
        &mut self,
        instance_id: &str,
        start_secs: f64,
        end_secs: f64,
    ) -> Result<()> {
        anyhow::ensure!(end_secs > start_secs, "loop end must be after start");
        let node = self.deck_node(instance_id)?;
        self.decks.get_mut(&node).unwrap().loop_region = Some((start_secs, end_secs));
        self.deck_push(
            node,
            DeckCmd::Loop {
                start_secs,
                end_secs,
            },
        )
    }

    /// Enable/disable the active loop.
    pub fn deck_loop_enable(&mut self, instance_id: &str, enabled: bool) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        if enabled {
            anyhow::ensure!(
                self.decks[&node].loop_region.is_some(),
                "no loop region set on {instance_id:?}"
            );
        }
        self.decks.get_mut(&node).unwrap().loop_enabled = enabled;
        self.deck_push(node, DeckCmd::LoopEnabled(enabled))
    }

    /// Halve the active loop length (keeps the loop start).
    pub fn deck_loop_halve(&mut self, instance_id: &str) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        let (start, end) = self.decks[&node]
            .loop_region
            .ok_or_else(|| anyhow!("no loop region set on {instance_id:?}"))?;
        let len = ((end - start) / 2.0).max(0.005);
        self.deck_set_loop(instance_id, start, start + len)
    }

    /// Double the active loop length (keeps the loop start).
    pub fn deck_loop_double(&mut self, instance_id: &str) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        let (start, end) = self.decks[&node]
            .loop_region
            .ok_or_else(|| anyhow!("no loop region set on {instance_id:?}"))?;
        self.deck_set_loop(instance_id, start, start + (end - start) * 2.0)
    }

    /// Beat/phase-sync this deck to another deck (or clear with `None`).
    /// The follower snaps its beat phase once, then continuously tempo-
    /// matches the master (PRD §7).
    pub fn deck_sync(&mut self, instance_id: &str, master: Option<&str>) -> Result<()> {
        let node = self.deck_node(instance_id)?;
        let target = match master {
            Some(m) => {
                anyhow::ensure!(m != instance_id, "a deck cannot sync to itself");
                let m_node = self.deck_node(m)?;
                Some((m.to_string(), self.decks[&m_node].shared.clone()))
            }
            None => None,
        };
        self.decks.get_mut(&node).unwrap().sync_to = target.as_ref().map(|(m, _)| m.clone());
        self.deck_push(node, DeckCmd::SyncTo(target.map(|(_, s)| s)))
    }

    /// Instance this deck is synced to, if any.
    pub fn deck_sync_to(&self, instance_id: &str) -> Result<Option<String>> {
        let node = self.deck_node(instance_id)?;
        Ok(self.decks[&node].sync_to.clone())
    }

    pub(crate) fn deck_sync_to_by_node(&self, node: usize) -> Option<String> {
        self.decks.get(&node).and_then(|d| d.sync_to.clone())
    }

    /// Transport/DJ-state snapshot for UIs. Position/rate reflect the last
    /// processed block.
    pub fn deck_status(&self, instance_id: &str) -> Result<DeckStatus> {
        let node = self.deck_node(instance_id)?;
        let ctl = &self.decks[&node];
        let rate = ctl.shared.rate();
        let grid = ctl.grid;
        Ok(DeckStatus {
            track: self.nodes[node].track_path.clone(),
            duration_secs: ctl.track.as_ref().map(|t| t.duration_secs()).unwrap_or(0.0),
            position_secs: ctl.shared.position_secs(),
            rate,
            playing: ctl.shared.playing(),
            grid_bpm: grid.map(|(bpm, _)| bpm),
            grid_anchor_secs: grid.map(|(_, a)| a),
            effective_bpm: grid.map(|(bpm, _)| bpm * rate.abs()),
            cues: ctl.cues.to_vec(),
            loop_start_secs: ctl.loop_region.map(|(s, _)| s),
            loop_end_secs: ctl.loop_region.map(|(_, e)| e),
            loop_enabled: ctl.loop_enabled,
            sync_to: ctl.sync_to.clone(),
            stems_loaded: ctl.stems.is_some(),
        })
    }

    /// Waveform overview: peak |sample| per bucket over the mono mix of the
    /// loaded track (0..=1 per bucket). Computed on the control thread.
    pub fn deck_waveform(&self, instance_id: &str, buckets: usize) -> Result<Vec<f32>> {
        let node = self.deck_node(instance_id)?;
        Ok(self.decks[&node]
            .track
            .as_ref()
            .map(|t| t.peaks(buckets))
            .unwrap_or_default())
    }

    pub fn xrun_count(&self) -> u64 {
        self.xruns.load(Ordering::Relaxed)
    }

    /// Blocks whose processing alone (thread CPU time on unix) exceeded the
    /// block period — the engine was the bottleneck. Null backend only;
    /// `xrun_count` additionally counts scheduler-late pacer wakeups there.
    pub fn proc_deadline_miss_count(&self) -> u64 {
        self.proc_misses.load(Ordering::Relaxed)
    }

    /// Worst per-block processing cost observed on the null backend, in
    /// nanoseconds of thread CPU time (headroom metric: compare against the
    /// block period).
    pub fn max_block_proc_nanos(&self) -> u64 {
        self.max_proc_nanos.load(Ordering::Relaxed)
    }

    pub fn blocks_processed(&self) -> u64 {
        self.blocks.load(Ordering::Relaxed)
    }

    pub fn current_frame(&self) -> u64 {
        self.blocks_processed() * self.config.block_size as u64
    }
}
