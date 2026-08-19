//! DAW timeline control plane; methods on [`Engine`] only.
//!
//! The DAW is a singleton, always-present native node (instance id
//! [`DAW_INSTANCE`]) created with the engine — never via `add_module`,
//! never removable. Track/clip edits mutate the canonical [`DawState`] on
//! the node, then recompile and ship the program to the RT module over the
//! SPSC ring (the choreo pattern). Transport commands are plain ring
//! messages — no engine stop for any DAW operation except wire edits,
//! which go through the usual structural path.

use super::*;
use crate::daw::{
    adapt_channels, alloc_jacks, resample_linear, ClipData, DawCmd, DawProgram, DawProgramTrack,
    DawRecordSource, DawState, DawTrack, DawTrackKind, PendingRecord, DAW_INSTANCE,
};

/// Mic capture stream state: a dedicated thread owns the cpal input stream
/// (never Send) and pushes FILE-unit samples into a ring the control side
/// drains in [`Engine::daw_poll`].
pub struct MicCapture {
    pub stop: Arc<AtomicBool>,
    pub join: Option<std::thread::JoinHandle<()>>,
    pub rx: rtrb::Consumer<f32>,
    pub sample_rate: f32,
    pub channels: usize,
}

impl Drop for MicCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Transport + recording status for the UI.
#[derive(Debug, Clone, Serialize)]
pub struct DawStatus {
    /// Transport position in engine frames.
    pub playhead: u64,
    pub playing: bool,
    /// Track index being recorded, if any.
    pub recording: Option<usize>,
    /// Frames accumulated in the pending recording.
    pub record_frames: u64,
    pub sample_rate: f32,
}

impl Engine {
    fn daw_node(&self) -> Result<usize> {
        self.node_idx(DAW_INSTANCE)
    }

    /// Read-only view of the DAW timeline state.
    pub fn daw(&self) -> Result<&DawState> {
        let node = self.daw_node()?;
        Ok(self.nodes[node].daw.as_ref().unwrap())
    }

    /// Compile the current state + loaded clips and ship it to the RT
    /// module. Every clip/track edit funnels through here.
    fn daw_push_program(&mut self) -> Result<()> {
        let node = self.daw_node()?;
        let state = self.nodes[node].daw.as_ref().unwrap();
        let ctl = self.daws.get(&node).unwrap();
        let tracks = state
            .tracks
            .iter()
            .map(|t| DawProgramTrack {
                jack: t.jack as u16,
                channels: t.channels() as u8,
                clip: ctl.clips.get(&t.jack).map(|(_, c)| c.clone()),
            })
            .collect();
        self.daws
            .get_mut(&node)
            .unwrap()
            .send(DawCmd::Program(Arc::new(DawProgram { tracks })))
    }

    /// Add a track ("audio" | "continuous"; `stereo` applies to audio
    /// only). Returns the allocated jack slot (both `i<slot>`/`t<slot>`).
    pub fn daw_add_track(&mut self, name: &str, kind: &str, stereo: bool) -> Result<usize> {
        anyhow::ensure!(!name.trim().is_empty(), "track name must not be empty");
        let kind = match kind {
            "audio" => DawTrackKind::Audio,
            "continuous" => DawTrackKind::Continuous,
            other => anyhow::bail!("unknown track kind {other:?}"),
        };
        let node = self.daw_node()?;
        let budget = self.nodes[node].manifest.outputs.len();
        let state = self.nodes[node].daw.as_mut().unwrap();
        anyhow::ensure!(
            state.tracks.iter().all(|t| t.name != name),
            "duplicate track name {name:?}"
        );
        let track = DawTrack {
            name: name.to_string(),
            jack: 0,
            kind,
            stereo: kind == DawTrackKind::Audio && stereo,
            clip: None,
        };
        let slot = {
            let n = track.channels();
            alloc_jacks(state, budget, n)?
        };
        state.tracks.push(DawTrack {
            jack: slot,
            ..track
        });
        self.daw_push_program()?;
        Ok(slot)
    }

    /// Remove a track. The caller disconnects wires from its jacks first
    /// (the Tauri shell does, like choreo track removal).
    pub fn daw_remove_track(&mut self, index: usize) -> Result<()> {
        let node = self.daw_node()?;
        anyhow::ensure!(
            self.daws
                .get(&node)
                .map(|c| c.pending.as_ref().map(|p| p.track))
                != Some(Some(index)),
            "track {index} is recording; stop first"
        );
        let state = self.nodes[node].daw.as_mut().unwrap();
        anyhow::ensure!(index < state.tracks.len(), "no track {index}");
        let t = state.tracks.remove(index);
        self.daws.get_mut(&node).unwrap().clips.remove(&t.jack);
        self.daw_push_program()
    }

    pub fn daw_rename_track(&mut self, index: usize, name: &str) -> Result<()> {
        anyhow::ensure!(!name.trim().is_empty(), "track name must not be empty");
        let node = self.daw_node()?;
        let state = self.nodes[node].daw.as_mut().unwrap();
        anyhow::ensure!(index < state.tracks.len(), "no track {index}");
        anyhow::ensure!(
            state
                .tracks
                .iter()
                .enumerate()
                .all(|(i, t)| i == index || t.name != name),
            "duplicate track name {name:?}"
        );
        state.tracks[index].name = name.to_string();
        Ok(())
    }

    /// Reorder: display order only — jack slots stay with their tracks, so
    /// wires are unaffected.
    pub fn daw_move_track(&mut self, from: usize, to: usize) -> Result<()> {
        let node = self.daw_node()?;
        let state = self.nodes[node].daw.as_mut().unwrap();
        anyhow::ensure!(from < state.tracks.len(), "no track {from}");
        anyhow::ensure!(to < state.tracks.len(), "no track position {to}");
        let t = state.tracks.remove(from);
        state.tracks.insert(to, t);
        Ok(())
    }

    /// Import an audio file (WAV/anything symphonia decodes — library
    /// tracks included) as a track's clip: decoded, channel-adapted and
    /// resampled to the engine rate control-side.
    pub fn daw_import_clip(&mut self, index: usize, path: &std::path::Path) -> Result<()> {
        let node = self.daw_node()?;
        let want = {
            let state = self.nodes[node].daw.as_ref().unwrap();
            let t = state
                .tracks
                .get(index)
                .ok_or_else(|| anyhow!("no track {index}"))?;
            t.channels()
        };
        let decoded = decode_file(path)?;
        let engine_rate = self.config.sample_rate;
        let channels: Vec<Vec<f32>> = adapt_channels(decoded.channels, want)
            .into_iter()
            .map(|c| resample_linear(&c, decoded.sample_rate, engine_rate))
            .collect();
        let clip = Arc::new(ClipData { channels });
        let state = self.nodes[node].daw.as_mut().unwrap();
        let jack = state.tracks[index].jack;
        let path_str = path.to_string_lossy().to_string();
        state.tracks[index].clip = Some(path_str.clone());
        self.daws
            .get_mut(&node)
            .unwrap()
            .clips
            .insert(jack, (path_str, clip));
        self.daw_push_program()
    }

    /// Clear a track's clip (the file itself is library-managed; untouched).
    pub fn daw_clear_clip(&mut self, index: usize) -> Result<()> {
        let node = self.daw_node()?;
        let state = self.nodes[node].daw.as_mut().unwrap();
        let t = state
            .tracks
            .get_mut(index)
            .ok_or_else(|| anyhow!("no track {index}"))?;
        t.clip = None;
        let jack = t.jack;
        self.daws.get_mut(&node).unwrap().clips.remove(&jack);
        self.daw_push_program()
    }

    /// Replace the whole timeline in one edit (patch load and the
    /// undo/redo diff path). Tracks keep their saved jack slots so wires
    /// stay valid; clips are reloaded from their persisted paths.
    pub fn daw_set_state(&mut self, state: DawState) -> Result<()> {
        let node = self.daw_node()?;
        let budget = self.nodes[node].manifest.outputs.len();
        let mut used = vec![false; budget];
        for t in &state.tracks {
            let end = t.jack + t.channels();
            anyhow::ensure!(end <= budget, "track jack slot {} out of range", t.jack);
            anyhow::ensure!(
                !used[t.jack..end].iter().any(|u| *u),
                "track jack slot {} already in use",
                t.jack
            );
            used[t.jack..end].fill(true);
        }
        // Reload clips (skip ones already loaded from the same path).
        let engine_rate = self.config.sample_rate;
        let mut clips = std::collections::HashMap::new();
        for t in &state.tracks {
            let Some(path) = &t.clip else { continue };
            let existing = self
                .daws
                .get(&node)
                .and_then(|c| c.clips.get(&t.jack))
                .filter(|(p, _)| p == path)
                .cloned();
            let entry = match existing {
                Some(e) => e,
                None => {
                    let decoded = decode_file(std::path::Path::new(path))?;
                    let channels: Vec<Vec<f32>> = adapt_channels(decoded.channels, t.channels())
                        .into_iter()
                        .map(|c| resample_linear(&c, decoded.sample_rate, engine_rate))
                        .collect();
                    (path.clone(), Arc::new(ClipData { channels }))
                }
            };
            clips.insert(t.jack, entry);
        }
        self.daws.get_mut(&node).unwrap().clips = clips;
        *self.nodes[node].daw.as_mut().unwrap() = state;
        self.daw_push_program()
    }

    // ------------------------------------------------------------------
    // Transport
    // ------------------------------------------------------------------

    pub fn daw_play(&mut self) -> Result<()> {
        let node = self.daw_node()?;
        self.daws.get_mut(&node).unwrap().send(DawCmd::Play)
    }

    pub fn daw_stop_transport(&mut self) -> Result<()> {
        let node = self.daw_node()?;
        self.daws.get_mut(&node).unwrap().send(DawCmd::Stop)
    }

    /// Seek the transport to an absolute position in engine frames.
    pub fn daw_seek(&mut self, frames: u64) -> Result<()> {
        let node = self.daw_node()?;
        self.daws.get_mut(&node).unwrap().send(DawCmd::Seek(frames))
    }

    pub fn daw_status(&mut self) -> Result<DawStatus> {
        self.daw_poll()?;
        let node = self.daw_node()?;
        let ctl = &self.daws[&node];
        Ok(DawStatus {
            playhead: ctl.shared.playhead(),
            playing: ctl.shared.playing(),
            recording: ctl.pending.as_ref().map(|p| p.track),
            record_frames: ctl
                .pending
                .as_ref()
                .map(|p| (p.data.len() / p.channels.max(1)) as u64)
                .unwrap_or(0),
            sample_rate: self.config.sample_rate,
        })
    }

    // ------------------------------------------------------------------
    // Recording
    // ------------------------------------------------------------------

    /// Arm a recording on a track. `source` Input captures the track's
    /// input jack(s) sample-accurately on the RT thread; Mic captures the
    /// control-side feed ([`Engine::daw_feed_capture`] / the cpal mic
    /// stream started by [`Engine::daw_mic_start`]).
    pub fn daw_record_start(&mut self, index: usize, source: DawRecordSource) -> Result<()> {
        let node = self.daw_node()?;
        anyhow::ensure!(
            self.daws[&node].pending.is_none(),
            "a recording is already in progress"
        );
        let (jack, channels) = {
            let state = self.nodes[node].daw.as_ref().unwrap();
            let t = state
                .tracks
                .get(index)
                .ok_or_else(|| anyhow!("no track {index}"))?;
            anyhow::ensure!(
                source != DawRecordSource::Mic || t.kind == DawTrackKind::Audio,
                "mic recording requires an audio track"
            );
            (t.jack, t.channels())
        };
        let sample_rate = match source {
            DawRecordSource::Input => self.config.sample_rate,
            DawRecordSource::Mic => self
                .mic
                .as_ref()
                .map(|m| m.sample_rate)
                .unwrap_or(self.config.sample_rate),
        };
        let mic_channels = self.mic.as_ref().map(|m| m.channels);
        let ctl = self.daws.get_mut(&node).unwrap();
        // Drop anything stale in the capture ring from a previous take.
        while ctl.capture_rx.pop().is_ok() {}
        ctl.pending = Some(PendingRecord {
            track: index,
            source,
            channels: match source {
                DawRecordSource::Input => channels,
                DawRecordSource::Mic => mic_channels.unwrap_or(1).min(channels.max(1)),
            },
            data: Vec::new(),
            sample_rate,
        });
        if source == DawRecordSource::Input {
            ctl.send(DawCmd::CaptureStart {
                jack: jack as u16,
                channels: channels as u8,
            })?;
        }
        Ok(())
    }

    /// Drain capture sources into the pending recording. Called by
    /// [`Engine::daw_status`] (UI polls) and [`Engine::daw_record_stop`].
    pub fn daw_poll(&mut self) -> Result<()> {
        let node = self.daw_node()?;
        // Mic ring first (borrow discipline: mic and daws are separate
        // fields, but pending lives in the DawControl).
        let mut mic_samples: Vec<f32> = Vec::new();
        if let Some(mic) = self.mic.as_mut() {
            while let Ok(s) = mic.rx.pop() {
                mic_samples.push(s);
            }
        }
        let ctl = self.daws.get_mut(&node).unwrap();
        match &mut ctl.pending {
            Some(p) if p.source == DawRecordSource::Input => {
                // RT capture is in engine units; clips store FILE units.
                while let Ok(s) = ctl.capture_rx.pop() {
                    p.data.push(s / crate::graph::SIGNAL_MAX);
                }
            }
            Some(p) if p.source == DawRecordSource::Mic => {
                p.data.extend_from_slice(&mic_samples);
            }
            _ => {
                // Not recording: keep the RT ring drained so overruns
                // can't pile up between takes.
                while ctl.capture_rx.pop().is_ok() {}
            }
        }
        Ok(())
    }

    /// Push mic/external samples (frame-interleaved FILE units [-1, 1])
    /// into a pending Mic recording. The cpal mic stream uses the ring in
    /// [`MicCapture`]; tests and alternative feeds call this directly.
    pub fn daw_feed_capture(&mut self, samples: &[f32]) -> Result<()> {
        let node = self.daw_node()?;
        let ctl = self.daws.get_mut(&node).unwrap();
        let p = ctl
            .pending
            .as_mut()
            .ok_or_else(|| anyhow!("no recording in progress"))?;
        anyhow::ensure!(
            p.source == DawRecordSource::Mic,
            "capture feed is only valid for mic recordings"
        );
        p.data.extend_from_slice(samples);
        Ok(())
    }

    /// Stop recording and finalize the take into `<dir>/<file>.wav` at the
    /// engine sample rate (FILE units, 32-bit float). Loads the clip onto
    /// the track and returns the written path (the app imports it into the
    /// library). An empty take aborts cleanly (no file, clip untouched).
    pub fn daw_record_stop(&mut self, dir: &std::path::Path) -> Result<Option<std::path::PathBuf>> {
        let node = self.daw_node()?;
        if self.daws[&node]
            .pending
            .as_ref()
            .is_some_and(|p| p.source == DawRecordSource::Input)
        {
            self.daws
                .get_mut(&node)
                .unwrap()
                .send(DawCmd::CaptureStop)?;
            // One last drain pass picks up what the RT thread pushed
            // before the stop landed (best-effort; the command is applied
            // at the next block boundary, so a final block may be cut).
        }
        self.daw_poll()?;
        let ctl = self.daws.get_mut(&node).unwrap();
        let Some(p) = ctl.pending.take() else {
            anyhow::bail!("no recording in progress");
        };
        let index = p.track;
        if p.data.len() < p.channels.max(1) {
            return Ok(None);
        }
        // Deinterleave, resample to the engine rate, clamp to file range.
        let channels = p.channels.max(1);
        let frames = p.data.len() / channels;
        let engine_rate = self.config.sample_rate;
        let deinterleaved: Vec<Vec<f32>> = (0..channels)
            .map(|ch| {
                let chan: Vec<f32> = (0..frames).map(|f| p.data[f * channels + ch]).collect();
                resample_linear(&chan, p.sample_rate, engine_rate)
                    .into_iter()
                    .map(|s| s.clamp(-1.0, 1.0))
                    .collect()
            })
            .collect();

        std::fs::create_dir_all(dir)?;
        let track_name = {
            let state = self.nodes[node].daw.as_ref().unwrap();
            state
                .tracks
                .get(index)
                .map(|t| t.name.clone())
                .unwrap_or_else(|| format!("track{index}"))
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let safe: String = track_name
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
        let path = dir.join(format!("daw-{safe}-{stamp}.wav"));
        let spec = hound::WavSpec {
            channels: channels as u16,
            sample_rate: engine_rate as u32,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&path, spec)?;
        let out_frames = deinterleaved[0].len();
        for f in 0..out_frames {
            for ch in &deinterleaved {
                writer.write_sample(ch[f])?;
            }
        }
        writer.finalize()?;

        // Load the finished take as the track's clip directly (the data is
        // already engine-rate, channel-correct FILE units).
        let want = {
            let state = self.nodes[node].daw.as_ref().unwrap();
            state.tracks[index].channels()
        };
        let clip = Arc::new(ClipData {
            channels: adapt_channels(deinterleaved, want),
        });
        let path_str = path.to_string_lossy().to_string();
        let state = self.nodes[node].daw.as_mut().unwrap();
        let jack = state.tracks[index].jack;
        state.tracks[index].clip = Some(path_str.clone());
        self.daws
            .get_mut(&node)
            .unwrap()
            .clips
            .insert(jack, (path_str, clip));
        self.daw_push_program()?;
        Ok(Some(path))
    }

    /// Abort a recording, discarding captured data.
    pub fn daw_record_cancel(&mut self) -> Result<()> {
        let node = self.daw_node()?;
        if self.daws[&node]
            .pending
            .as_ref()
            .is_some_and(|p| p.source == DawRecordSource::Input)
        {
            self.daws
                .get_mut(&node)
                .unwrap()
                .send(DawCmd::CaptureStop)?;
        }
        self.daws.get_mut(&node).unwrap().pending = None;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Clip readout (UI graphs)
    // ------------------------------------------------------------------

    /// Min/max peak pairs over `bins` equal slices of a track's clip, in
    /// VOLTS (±10 V rails — audio and CV tracks read the same way). Empty
    /// when the track has no clip.
    pub fn daw_clip_peaks(&self, index: usize, bins: usize) -> Result<Vec<(f32, f32)>> {
        let node = self.daw_node()?;
        let state = self.nodes[node].daw.as_ref().unwrap();
        let t = state
            .tracks
            .get(index)
            .ok_or_else(|| anyhow!("no track {index}"))?;
        let Some((_, clip)) = self.daws[&node].clips.get(&t.jack) else {
            return Ok(Vec::new());
        };
        let frames = clip.frames();
        if frames == 0 || bins == 0 {
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity(bins);
        for b in 0..bins {
            let start = b * frames / bins;
            let end = ((b + 1) * frames / bins).max(start + 1).min(frames);
            let (mut lo, mut hi) = (f32::MAX, f32::MIN);
            for ch in &clip.channels {
                for &s in &ch[start..end] {
                    lo = lo.min(s);
                    hi = hi.max(s);
                }
            }
            out.push((lo * crate::graph::SIGNAL_MAX, hi * crate::graph::SIGNAL_MAX));
        }
        Ok(out)
    }

    /// A track's clip length in engine frames (0 = no clip).
    pub fn daw_clip_frames(&self, index: usize) -> Result<u64> {
        let node = self.daw_node()?;
        let state = self.nodes[node].daw.as_ref().unwrap();
        let t = state
            .tracks
            .get(index)
            .ok_or_else(|| anyhow!("no track {index}"))?;
        Ok(self.daws[&node]
            .clips
            .get(&t.jack)
            .map(|(_, c)| c.frames() as u64)
            .unwrap_or(0))
    }

    // ------------------------------------------------------------------
    // Mic input stream (cpal)
    // ------------------------------------------------------------------

    /// Start the default input device capturing into the mic ring.
    /// Control-side only — the RT graph thread is never involved.
    #[cfg(feature = "cpal-backend")]
    pub fn daw_mic_start(&mut self) -> Result<()> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        if self.mic.is_some() {
            return Ok(());
        }
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| anyhow!("no input device"))?;
        let config = device
            .default_input_config()
            .map_err(|e| anyhow!("no default input config: {e}"))?;
        let sample_rate = config.sample_rate().0 as f32;
        let channels = (config.channels() as usize).min(2);
        let in_channels = config.channels() as usize;
        // ~20 s of stereo headroom; drained every daw_poll.
        let (mut tx, rx) = rtrb::RingBuffer::<f32>::new(1 << 21);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();
        // The stream lives on its own thread (cpal streams are !Send on
        // some hosts — same pattern as start_cpal).
        let join = std::thread::Builder::new()
            .name("dj-mic".into())
            .spawn(move || {
                let data_cb = move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    for frame in data.chunks(in_channels) {
                        for ch in 0..channels {
                            // Ring full = drop (control side stopped
                            // draining); never block the input callback.
                            let _ = tx.push(frame.get(ch).copied().unwrap_or(0.0));
                        }
                    }
                };
                let stream = device.build_input_stream(
                    &config.into(),
                    data_cb,
                    |e| eprintln!("[dj-mic] stream error: {e}"),
                    None,
                );
                let stream = match stream {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("build_input_stream: {e}")));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(format!("stream.play: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                while !stop_thread.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(50));
                }
                drop(stream);
            })?;
        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let _ = join.join();
                return Err(anyhow!(e));
            }
            Err(_) => {
                let _ = join.join();
                return Err(anyhow!("mic thread died during setup"));
            }
        }
        self.mic = Some(MicCapture {
            stop,
            join: Some(join),
            rx,
            sample_rate,
            channels,
        });
        Ok(())
    }

    #[cfg(not(feature = "cpal-backend"))]
    pub fn daw_mic_start(&mut self) -> Result<()> {
        anyhow::bail!("mic capture requires the cpal-backend feature")
    }

    /// Stop and release the mic input stream.
    pub fn daw_mic_stop(&mut self) {
        self.mic = None; // Drop impl stops the thread.
    }

    pub fn daw_mic_running(&self) -> bool {
        self.mic.is_some()
    }
}
