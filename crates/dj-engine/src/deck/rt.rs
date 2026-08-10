//! RT-side deck module: sample playback, keylock grains, sync, loops,
//! cue triggers and stem mixing — everything that runs on the audio thread.
//! Control-side types stay in the parent module.

use super::*;

/// The RT-side deck module.
pub struct DeckModule {
    cmd_rx: rtrb::Consumer<DeckCmd>,
    garbage_tx: rtrb::Producer<DeckGarbage>,
    shared: Arc<DeckShared>,
    sync: Option<Arc<DeckShared>>,
    /// A beat-phase snap is owed as soon as the sync master goes live.
    snap_pending: bool,

    track: Option<Arc<TrackData>>,
    /// Stems for the current track (M3). When present, the main audio
    /// outs are the gain-weighted stem sum and the stem jacks are live.
    stems: Option<Arc<StemData>>,
    stem_gains: [f32; N_STEMS],
    engine_rate: f64,

    /// Audible position in track frames (fractional).
    pos: f64,
    /// Slip ghost position (track frames): where the deck would be had no
    /// loop/cue interrupted playback.
    ghost: f64,
    ended: bool,

    grid_bpm: f64,       // 0 = no grid
    grid_anchor: f64,    // seconds
    cues: [f64; N_CUES], // seconds; NaN = unset
    loop_start: f64,     // seconds
    loop_end: f64,
    loop_on: bool,

    pitch_range: f64,
    keylock: bool,
    reverse: bool,
    slip: bool,

    prev_gate: bool,
    prev_loop_toggle: bool,
    prev_cue: [bool; N_CUES],
    beat_pulse_left: u32,
    bar_pulse_left: u32,

    // Keylock granular state (two voices, Hann OLA at 50 % hop).
    window: Vec<f32>,
    grain_len: usize,
    hop: usize,
    voice_start: [f64; 2], // track frame at grain start
    voice_off: [usize; 2], // output samples into the grain (== grain_len: idle)
    hop_phase: usize,
    next_voice: usize,
    /// WSOLA scratch: the previous grain's natural continuation (channel 0),
    /// preallocated at construction.
    corr_ref: Vec<f32>,
    search_radius: usize,

    engine_frame: u64,
}

impl DeckModule {
    pub fn new(
        cmd_rx: rtrb::Consumer<DeckCmd>,
        garbage_tx: rtrb::Producer<DeckGarbage>,
        shared: Arc<DeckShared>,
        engine_rate: f32,
    ) -> Self {
        let grain_len = ((engine_rate as f64 * KEYLOCK_GRAIN_SECS) as usize).max(64) & !1;
        let window: Vec<f32> = (0..grain_len)
            .map(|n| {
                let x = n as f64 / grain_len as f64;
                (0.5 - 0.5 * (2.0 * std::f64::consts::PI * x).cos()) as f32
            })
            .collect();
        DeckModule {
            cmd_rx,
            garbage_tx,
            shared,
            sync: None,
            snap_pending: false,
            track: None,
            stems: None,
            stem_gains: [1.0; N_STEMS],
            engine_rate: engine_rate as f64,
            pos: 0.0,
            ghost: 0.0,
            ended: false,
            grid_bpm: 0.0,
            grid_anchor: 0.0,
            cues: [f64::NAN; N_CUES],
            loop_start: 0.0,
            loop_end: 0.0,
            loop_on: false,
            pitch_range: 0.08,
            keylock: false,
            reverse: false,
            slip: false,
            prev_gate: false,
            prev_loop_toggle: false,
            prev_cue: [false; N_CUES],
            beat_pulse_left: 0,
            bar_pulse_left: 0,
            window,
            grain_len,
            hop: grain_len / 2,
            voice_start: [0.0; 2],
            voice_off: [grain_len; 2],
            hop_phase: 0,
            next_voice: 0,
            corr_ref: vec![0.0; (engine_rate as f64 * KEYLOCK_CORR_SECS) as usize],
            search_radius: (engine_rate as f64 * KEYLOCK_SEARCH_SECS) as usize,
            engine_frame: 0,
        }
    }

    /// WSOLA grain alignment: pick the start position within
    /// ±`search_radius` of `target` whose channel-0 content best matches
    /// the natural continuation of the currently playing grain. Bounded
    /// work, no allocation (scratch preallocated).
    fn align_grain_start(&mut self, target: f64, natural: f64, step: f64) -> f64 {
        let Some(track) = self.track.as_ref() else {
            return target;
        };
        let ch0 = &track.channels[0];
        for (k, r) in self.corr_ref.iter_mut().enumerate() {
            *r = Self::sample_at(ch0, natural + k as f64 * step);
        }
        let mut best_d = 0i64;
        let mut best_score = f32::NEG_INFINITY;
        let radius = self.search_radius as i64;
        for d in -radius..=radius {
            let cand = target + d as f64;
            let mut score = 0.0f32;
            for (k, &r) in self.corr_ref.iter().enumerate() {
                score += r * Self::sample_at(ch0, cand + k as f64 * step);
            }
            if score > best_score {
                best_score = score;
                best_d = d;
            }
        }
        target + best_d as f64
    }

    fn apply_cmd(&mut self, cmd: DeckCmd) {
        match cmd {
            DeckCmd::Load(t) => {
                if let Some(old) = self.track.replace(t) {
                    let _ = self.garbage_tx.push(DeckGarbage::Track(old));
                }
                // Stems belong to the previous track.
                if let Some(old) = self.stems.take() {
                    let _ = self.garbage_tx.push(DeckGarbage::Stems(old));
                }
                self.pos = 0.0;
                self.ghost = 0.0;
                self.ended = false;
                self.loop_on = false;
                self.loop_start = 0.0;
                self.loop_end = 0.0;
                self.grid_bpm = 0.0;
                self.grid_anchor = 0.0;
                self.cues = [f64::NAN; N_CUES];
                self.reset_grains();
            }
            DeckCmd::LoadStems(stems) => {
                let old = match stems {
                    Some(s) => self.stems.replace(s),
                    None => self.stems.take(),
                };
                if let Some(old) = old {
                    let _ = self.garbage_tx.push(DeckGarbage::Stems(old));
                }
            }
            DeckCmd::Grid { bpm, anchor_secs } => {
                self.grid_bpm = if bpm > 0.0 { bpm } else { 0.0 };
                self.grid_anchor = anchor_secs;
            }
            DeckCmd::Cue { slot, pos_secs } => {
                if slot < N_CUES {
                    self.cues[slot] = pos_secs;
                }
            }
            DeckCmd::Seek(secs) => {
                if let Some(sr) = self.track_rate() {
                    self.pos = (secs * sr).max(0.0);
                    self.ghost = self.pos;
                    self.ended = false;
                    self.reset_grains();
                }
            }
            DeckCmd::Loop {
                start_secs,
                end_secs,
            } => {
                self.loop_start = start_secs;
                self.loop_end = end_secs;
            }
            DeckCmd::LoopEnabled(on) => {
                let was = self.loop_on;
                self.loop_on = on;
                // Turning the loop off in slip mode returns to the ghost.
                if was && !on && self.slip {
                    self.pos = self.ghost;
                    self.reset_grains();
                }
            }
            DeckCmd::SyncTo(master) => {
                self.sync = master;
                // The snap is deferred until the master is actually
                // publishing (it may process after us in graph order, or
                // start playing later).
                self.snap_pending = self.sync.is_some();
            }
        }
    }

    fn track_rate(&self) -> Option<f64> {
        self.track.as_ref().map(|t| t.sample_rate as f64)
    }

    fn reset_grains(&mut self) {
        self.voice_off = [self.grain_len; 2];
        self.hop_phase = 0;
        self.next_voice = 0;
    }

    /// Master's position extrapolated to this deck's current engine frame.
    fn master_pos_now(&self, m: &DeckShared) -> f64 {
        let stamp = m.stamp.load(Ordering::Relaxed);
        let dt = (self.engine_frame as i64 - stamp as i64) as f64 / self.engine_rate;
        let rate = if m.playing() { m.rate() } else { 0.0 };
        m.position_secs() + dt * rate
    }

    /// One-shot beat-phase snap when sync engages (like pressing SYNC).
    /// Returns false while preconditions (master playing, both grids) are
    /// not met yet; the caller retries each block.
    fn snap_phase_to_master(&mut self) -> bool {
        let (Some(m), Some(sr)) = (self.sync.as_ref(), self.track_rate()) else {
            return false;
        };
        if !m.playing() {
            return false;
        }
        let m_bpm = m.grid_bpm();
        if m_bpm <= 0.0 || self.grid_bpm <= 0.0 {
            return false;
        }
        let m_beat = (self.master_pos_now(m) - m.grid_anchor()) * m_bpm / 60.0;
        let own_pos = self.pos / sr;
        let own_beat = (own_pos - self.grid_anchor) * self.grid_bpm / 60.0;
        let err = wrap_half(m_beat.fract() - own_beat.fract());
        self.pos += err * (60.0 / self.grid_bpm) * sr;
        self.ghost = self.pos;
        true
    }

    /// Per-block sync rate: tempo match to the master plus a small
    /// proportional phase correction. None = not synced / master silent.
    fn sync_rate(&self) -> Option<f64> {
        let m = self.sync.as_ref()?;
        let sr = self.track_rate()?;
        if !m.playing() || self.grid_bpm <= 0.0 {
            return None;
        }
        let m_bpm = m.grid_bpm();
        if m_bpm <= 0.0 {
            return None;
        }
        let base = (m_bpm * m.rate()) / self.grid_bpm;
        let m_beat = (self.master_pos_now(m) - m.grid_anchor()) * m_bpm / 60.0;
        let own_beat = (self.pos / sr - self.grid_anchor) * self.grid_bpm / 60.0;
        let err = wrap_half(m_beat - own_beat);
        Some(base * (1.0 + (err * SYNC_PHASE_GAIN).clamp(-SYNC_CORR_CLAMP, SYNC_CORR_CLAMP)))
    }

    #[inline]
    fn sample_at(chan: &[f32], pos: f64) -> f32 {
        if pos < 0.0 {
            return 0.0;
        }
        let i0 = pos as usize;
        if i0 >= chan.len() {
            return 0.0;
        }
        let frac = (pos - i0 as f64) as f32;
        if frac == 0.0 || i0 + 1 >= chan.len() {
            chan[i0]
        } else {
            chan[i0] * (1.0 - frac) + chan[i0 + 1] * frac
        }
    }

    /// Read the track at `pos` (frames) into (l, r).
    #[inline]
    fn read_track(track: &TrackData, pos: f64) -> (f32, f32) {
        let l = Self::sample_at(&track.channels[0], pos);
        let r = if track.channels.len() > 1 {
            Self::sample_at(&track.channels[1], pos)
        } else {
            l
        };
        (l, r)
    }
}

#[inline]
fn wrap_half(x: f64) -> f64 {
    let mut e = x % 1.0;
    if e > 0.5 {
        e -= 1.0;
    } else if e < -0.5 {
        e += 1.0;
    }
    e
}

impl HostModule for DeckModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        while let Ok(cmd) = self.cmd_rx.pop() {
            self.apply_cmd(cmd);
        }

        // Owed phase snap: engages on the first block where the master is
        // live (it may be processed after this deck, or start later).
        if self.snap_pending && self.snap_phase_to_master() {
            self.snap_pending = false;
        }

        // Sync rate is computed once per block (master state is stable
        // within a block: all decks run on the same RT thread).
        let sync_rate = self.sync_rate();

        let gate = &inputs[IN_PLAY_GATE];
        let speed = &inputs[IN_SPEED];
        let nudge = &inputs[IN_PHASE_NUDGE];
        let loop_toggle = &inputs[IN_LOOP_TOGGLE];

        let track_sr = self.track_rate().unwrap_or(self.engine_rate);
        let n_frames = self.track.as_ref().map(|t| t.frames()).unwrap_or(0);
        let sr_ratio = track_sr / self.engine_rate;
        let pulse_len = (CLOCK_PULSE_SECS * self.engine_rate) as u32;
        let loop_start_f = self.loop_start * track_sr;
        let loop_end_f = self.loop_end * track_sr;
        let has_loop = self.loop_end > self.loop_start;

        let mut last_rate = 0.0f64;

        for s in 0..frames {
            let gate_high = gate[s] >= 1.0;
            if gate_high && !self.prev_gate && self.ended {
                self.pos = 0.0;
                self.ghost = 0.0;
                self.ended = false;
                self.reset_grains();
            }
            self.prev_gate = gate_high;

            // Loop toggle rising edge.
            let lt_high = loop_toggle[s] >= 1.0;
            if lt_high && !self.prev_loop_toggle && has_loop {
                self.loop_on = !self.loop_on;
                if !self.loop_on && self.slip {
                    self.pos = self.ghost;
                    self.reset_grains();
                }
            }
            self.prev_loop_toggle = lt_high;

            // Hot cue triggers: rising edge jumps to the cue; falling edge
            // in slip mode returns to the ghost position.
            for c in 0..N_CUES {
                let high = inputs[IN_CUE_BASE + c][s] >= 1.0;
                if high && !self.prev_cue[c] && self.cues[c].is_finite() {
                    self.pos = (self.cues[c] * track_sr).max(0.0);
                    self.ended = false;
                    self.reset_grains();
                } else if !high && self.prev_cue[c] && self.slip && self.cues[c].is_finite() {
                    self.pos = self.ghost;
                    self.reset_grains();
                }
                self.prev_cue[c] = high;
            }

            let playing = gate_high && !self.ended && n_frames > 0;

            // Effective rate: sync overrides the pitch fader; nudge and
            // reverse apply on top.
            let mut rate = match sync_rate {
                Some(r) => r,
                None => 1.0 + (speed[s] as f64 / 10.0) * self.pitch_range,
            };
            rate *= 1.0 + (nudge[s] as f64 / 10.0) * NUDGE_DEPTH;
            if self.reverse {
                rate = -rate;
            }
            last_rate = rate;

            let (mut l, mut r) = (0.0f32, 0.0f32);
            // Per-stem pre-gain samples for the stem jacks (M3).
            let mut stem_lr = [(0.0f32, 0.0f32); N_STEMS];
            let beat_pos_before = if self.grid_bpm > 0.0 {
                (self.pos / track_sr - self.grid_anchor) * self.grid_bpm / 60.0
            } else {
                f64::NAN
            };

            if playing {
                if self.keylock {
                    // Spawn a grain every hop output samples near the
                    // current virtual position, WSOLA-aligned to the
                    // running grain so joins stay phase-coherent.
                    if self.hop_phase == 0 {
                        let v = self.next_voice;
                        let other = 1 - v;
                        let dir = if rate < 0.0 { -1.0 } else { 1.0 };
                        let step = sr_ratio * dir;
                        let start = if self.voice_off[other] < self.grain_len {
                            let natural =
                                self.voice_start[other] + self.voice_off[other] as f64 * step;
                            self.align_grain_start(self.pos, natural, step)
                        } else {
                            self.pos
                        };
                        self.voice_start[v] = start;
                        self.voice_off[v] = 0;
                        self.next_voice = other;
                    }
                    self.hop_phase += 1;
                    if self.hop_phase >= self.hop {
                        self.hop_phase = 0;
                    }
                    let dir = if rate < 0.0 { -1.0 } else { 1.0 };
                    if let Some(stems) = self.stems.as_ref() {
                        // Same grains, read from the stems; the mix is the
                        // gain-weighted stem sum (WSOLA alignment stays on
                        // the original track, which the grains share).
                        for v in 0..2 {
                            let off = self.voice_off[v];
                            if off < self.grain_len {
                                let read = self.voice_start[v] + off as f64 * sr_ratio * dir;
                                let w = self.window[off];
                                for (k, st) in stems.stems.iter().enumerate() {
                                    let (gl, gr) = Self::read_track(st, read);
                                    stem_lr[k].0 += gl * w;
                                    stem_lr[k].1 += gr * w;
                                }
                                self.voice_off[v] = off + 1;
                            }
                        }
                        for (k, &(sl, sr)) in stem_lr.iter().enumerate() {
                            l += sl * self.stem_gains[k];
                            r += sr * self.stem_gains[k];
                        }
                    } else {
                        let track = self.track.as_ref().unwrap();
                        for v in 0..2 {
                            let off = self.voice_off[v];
                            if off < self.grain_len {
                                let read = self.voice_start[v] + off as f64 * sr_ratio * dir;
                                let w = self.window[off];
                                let (gl, gr) = Self::read_track(track, read);
                                l += gl * w;
                                r += gr * w;
                                self.voice_off[v] = off + 1;
                            }
                        }
                    }
                } else if let Some(stems) = self.stems.as_ref() {
                    for (k, st) in stems.stems.iter().enumerate() {
                        let (gl, gr) = Self::read_track(st, self.pos);
                        stem_lr[k] = (gl, gr);
                        l += gl * self.stem_gains[k];
                        r += gr * self.stem_gains[k];
                    }
                } else {
                    let track = self.track.as_ref().unwrap();
                    let (dl, dr) = Self::read_track(track, self.pos);
                    l = dl;
                    r = dr;
                }

                // Advance audible position (virtual position under keylock).
                self.pos += rate * sr_ratio;
                // Ghost advances identically but ignores loop wraps (and is
                // unaffected by cue jumps, handled above).
                if self.slip {
                    self.ghost += rate * sr_ratio;
                } else {
                    self.ghost = self.pos;
                }

                // Active loop wrap.
                if self.loop_on && has_loop {
                    if rate >= 0.0 && self.pos >= loop_end_f {
                        self.pos = loop_start_f + (self.pos - loop_end_f);
                        self.reset_grains();
                    } else if rate < 0.0 && self.pos < loop_start_f {
                        self.pos = loop_end_f - (loop_start_f - self.pos);
                        self.reset_grains();
                    }
                }

                if self.pos >= n_frames as f64 && rate >= 0.0 {
                    self.ended = true;
                } else if self.pos < 0.0 {
                    self.pos = 0.0;
                }
            }

            // Beat / bar clocks and phase from the beatgrid.
            let mut phase_out = 0.0f32;
            if self.grid_bpm > 0.0 {
                let beat_pos = (self.pos / track_sr - self.grid_anchor) * self.grid_bpm / 60.0;
                if playing && beat_pos_before.is_finite() {
                    // Fire on forward beat crossings only (loop wraps move
                    // backward; the beat re-fires when crossed again).
                    let b0 = beat_pos_before.floor();
                    let b1 = beat_pos.floor();
                    if b1 > b0 {
                        self.beat_pulse_left = pulse_len;
                    }
                    let bar0 = (beat_pos_before / BEATS_PER_BAR).floor();
                    let bar1 = (beat_pos / BEATS_PER_BAR).floor();
                    if bar1 > bar0 {
                        self.bar_pulse_left = pulse_len;
                    }
                }
                let bar_frac = (beat_pos / BEATS_PER_BAR).rem_euclid(1.0);
                phase_out = (bar_frac * SIGNAL_MAX as f64) as f32;
            }

            outputs[OUT_AUDIO_L][s] = l * SIGNAL_MAX;
            outputs[OUT_AUDIO_R][s] = r * SIGNAL_MAX;
            outputs[OUT_BEAT_CLOCK][s] = if self.beat_pulse_left > 0 {
                self.beat_pulse_left -= 1;
                SIGNAL_MAX
            } else {
                0.0
            };
            outputs[OUT_BAR_CLOCK][s] = if self.bar_pulse_left > 0 {
                self.bar_pulse_left -= 1;
                SIGNAL_MAX
            } else {
                0.0
            };
            outputs[OUT_PHASE][s] = phase_out;
            outputs[OUT_BPM][s] = if self.grid_bpm > 0.0 {
                ((self.grid_bpm * last_rate.abs()).max(1e-9) / BPM_REF).log2() as f32
            } else {
                0.0
            };
            // Stem jacks (M3): post-gain mono mix per stem; silent unless
            // stems are loaded and playing.
            for (k, &(sl, sr)) in stem_lr.iter().enumerate() {
                outputs[OUT_STEM_BASE + k][s] = 0.5 * (sl + sr) * self.stem_gains[k] * SIGNAL_MAX;
            }
        }

        self.engine_frame += frames as u64;

        // Publish transport state for sync followers and the control thread.
        let sr = self.track_rate().unwrap_or(self.engine_rate);
        DeckShared::set(&self.shared.pos_secs, self.pos / sr);
        DeckShared::set(&self.shared.rate, last_rate);
        self.shared.playing.store(
            self.prev_gate && !self.ended && self.track.is_some(),
            Ordering::Relaxed,
        );
        DeckShared::set(&self.shared.grid_bpm, self.grid_bpm);
        DeckShared::set(&self.shared.grid_anchor, self.grid_anchor);
        DeckShared::set(
            &self.shared.duration,
            self.track
                .as_ref()
                .map(|t| t.duration_secs())
                .unwrap_or(0.0),
        );
        self.shared
            .stamp
            .store(self.engine_frame, Ordering::Relaxed);
    }

    fn on_param(&mut self, index: u32, value: f32) {
        match index {
            0 => self.pitch_range = value.clamp(0.0, 0.5) as f64,
            1 => self.keylock = value >= 0.5,
            2 => self.reverse = value >= 0.5,
            3 => {
                let was = self.slip;
                self.slip = value >= 0.5;
                if !was && self.slip {
                    self.ghost = self.pos;
                }
            }
            i if (PARAM_STEM_BASE..PARAM_STEM_BASE + N_STEMS as u32).contains(&i) => {
                self.stem_gains[(i - PARAM_STEM_BASE) as usize] = value.clamp(0.0, 1.0);
            }
            _ => {}
        }
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(17);
        bytes.extend_from_slice(&self.pos.to_le_bytes());
        bytes.extend_from_slice(&self.ghost.to_le_bytes());
        bytes.push(self.ended as u8);
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 17 {
            self.pos = f64::from_le_bytes(bytes[..8].try_into().unwrap());
            self.ghost = f64::from_le_bytes(bytes[8..16].try_into().unwrap());
            self.ended = bytes[16] != 0;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
