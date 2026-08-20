//! Rendering / running: offline render and the null/cpal realtime backends — split out of the old monolithic engine.rs; methods on [`Engine`] only.

use super::*;

impl Engine {
    // ------------------------------------------------------------------
    // Rendering / running
    // ------------------------------------------------------------------

    /// Offline render (faster than realtime): process `total_frames` and
    /// return the master bus as one Vec per channel, in engine units
    /// (nominal [-10, +10], unclipped).
    pub fn render_offline(&mut self, total_frames: usize) -> Result<Vec<Vec<f32>>> {
        let block = self.config.block_size;
        let channels = self.config.master_channels;
        let mut out: Vec<Vec<f32>> = vec![Vec::with_capacity(total_frames); channels];
        let core = self.core_mut()?;
        let mut done = 0;
        while done < total_frames {
            let frames = block.min(total_frames - done);
            core.process_block(frames);
            for (ch, buf) in out.iter_mut().enumerate() {
                buf.extend_from_slice(&core.master[ch][..frames]);
            }
            done += frames;
        }
        Ok(out)
    }

    /// Process blocks offline without collecting audio (stress/tripwire use).
    pub fn process_blocks(&mut self, blocks: usize) -> Result<()> {
        let frames = self.config.block_size;
        let core = self.core_mut()?;
        for _ in 0..blocks {
            core.process_block(frames);
        }
        Ok(())
    }

    /// Offline render straight to a WAV file. Signals are scaled from the
    /// nominal [-10, +10] to [-1, +1] and hard-clipped at the file boundary.
    pub fn render_offline_wav(
        &mut self,
        total_frames: usize,
        path: &std::path::Path,
    ) -> Result<()> {
        let channels = self.config.master_channels;
        let spec = hound::WavSpec {
            channels: channels as u16,
            sample_rate: self.config.sample_rate as u32,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let data = self.render_offline(total_frames)?;
        let mut writer = hound::WavWriter::create(path, spec)?;
        for i in 0..total_frames {
            for ch in &data {
                writer.write_sample((ch[i] / crate::graph::SIGNAL_MAX).clamp(-1.0, 1.0))?;
            }
        }
        writer.finalize()?;
        Ok(())
    }

    /// Start the realtime null backend: a thread paced at wall-clock block
    /// rate (works headless; used for xrun/hot-reload verification).
    pub fn start_null_realtime(&mut self) -> Result<()> {
        let core = match std::mem::replace(&mut self.state, EngineState::Empty) {
            EngineState::Stopped(core) => core,
            other => {
                self.state = other;
                return Err(anyhow!("engine already running"));
            }
        };
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let xruns = self.xruns.clone();
        let proc_misses = self.proc_misses.clone();
        let max_proc = self.max_proc_nanos.clone();
        let block = self.config.block_size;
        let block_dur = Duration::from_secs_f64(block as f64 / self.config.sample_rate as f64);
        let block_nanos = block_dur.as_nanos() as u64;
        let join = std::thread::Builder::new()
            .name("dj-rt-null".into())
            .spawn(move || {
                let mut core = core;
                let mut deadline = Instant::now() + block_dur;
                while !stop2.load(Ordering::Relaxed) {
                    // Thread CPU time, not wall time: excludes preemption by
                    // other processes, so a miss is attributable to the
                    // engine itself even on a loaded, non-RT host.
                    let t0 = thread_cpu_nanos();
                    core.process_block(block);
                    let proc_ns = thread_cpu_nanos().saturating_sub(t0);
                    max_proc.fetch_max(proc_ns, Ordering::Relaxed);
                    if proc_ns > block_nanos {
                        // Processing alone blew the budget: the engine is
                        // the bottleneck. This is the hard failure a real
                        // audio callback would report.
                        proc_misses.fetch_add(1, Ordering::Relaxed);
                    }
                    let now = Instant::now();
                    if now > deadline + block_dur {
                        // Missed a whole block period. On this paced backend
                        // that can also be a late OS wakeup (non-RT kernel,
                        // loaded host), not necessarily slow processing —
                        // see `proc_misses` for the engine-attributable ones.
                        xruns.fetch_add(1, Ordering::Relaxed);
                        deadline = now + block_dur;
                    } else {
                        // Sleep the bulk of the wait but keep a ~1 ms spin
                        // margin: OS sleep can overshoot under load.
                        if deadline > now + Duration::from_micros(1500) {
                            std::thread::sleep(deadline - now - Duration::from_micros(1000));
                        }
                        while Instant::now() < deadline {
                            std::hint::spin_loop();
                        }
                        deadline += block_dur;
                    }
                }
                core
            })?;
        self.state = EngineState::Running { stop, join };
        Ok(())
    }

    /// Start the cpal device backend (requires a working audio device).
    #[cfg(feature = "cpal-backend")]
    pub fn start_cpal(&mut self) -> Result<()> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let core = match std::mem::replace(&mut self.state, EngineState::Empty) {
            EngineState::Stopped(core) => core,
            other => {
                self.state = other;
                return Err(anyhow!("engine already running"));
            }
        };
        let config = cpal::StreamConfig {
            channels: self.config.master_channels as u16,
            sample_rate: cpal::SampleRate(self.config.sample_rate as u32),
            buffer_size: cpal::BufferSize::Default,
        };
        eprintln!(
            "[dj-audio] start_cpal: requesting {} ch @ {} Hz (block {})",
            config.channels, self.config.sample_rate, self.config.block_size
        );
        let block = self.config.block_size;
        let channels = self.config.master_channels;
        let xruns = self.xruns.clone();
        let xruns_report = self.xruns.clone();
        let block_dur = block as f64 / self.config.sample_rate as f64;

        // Debug counters for the periodic level report (updated lock-free
        // from the audio callback, printed by the control loop below).
        let dbg_callbacks = Arc::new(AtomicU64::new(0));
        let dbg_samples = Arc::new(AtomicU64::new(0));
        let dbg_peak_bits = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let dbg_starved = Arc::new(AtomicU64::new(0));
        let (cb_callbacks, cb_samples, cb_peak_bits, cb_starved) = (
            dbg_callbacks.clone(),
            dbg_samples.clone(),
            dbg_peak_bits.clone(),
            dbg_starved.clone(),
        );

        // The core lives in a shared slot for the whole cpal run. The audio
        // callback try_locks it per callback: a single uncontended CAS in
        // steady state (the control thread only touches the slot after the
        // stream is dropped). This keeps the core recoverable both when
        // stream setup fails (fall back to another backend) and at stop()
        // (structural edits like adding modules/wires need the graph back).
        let slot: Arc<Mutex<Option<Box<EngineCore>>>> = Arc::new(Mutex::new(Some(core)));
        let slot_cb = slot.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();

        // The stream is created, driven, and dropped entirely on this
        // thread: cpal::Stream is !Send on CoreAudio, so it must never
        // cross threads (and Engine must stay Send for the Tauri shell).
        let join = std::thread::Builder::new()
            .name("dj-cpal".into())
            .spawn(move || {
                let mut leftover: Vec<f32> = Vec::with_capacity(block * channels);
                let data_cb = move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    cb_callbacks.fetch_add(1, Ordering::Relaxed);
                    cb_samples.fetch_add(out.len() as u64, Ordering::Relaxed);
                    let mut guard = match slot_cb.try_lock() {
                        Ok(g) => g,
                        Err(_) => {
                            cb_starved.fetch_add(1, Ordering::Relaxed);
                            out.fill(0.0);
                            return;
                        }
                    };
                    let Some(core) = guard.as_mut() else {
                        cb_starved.fetch_add(1, Ordering::Relaxed);
                        out.fill(0.0);
                        return;
                    };
                    let t0 = Instant::now();
                    let mut written = 0;
                    while written < out.len() {
                        if leftover.is_empty() {
                            core.process_block(block);
                            for s in 0..block {
                                for ch in 0..channels {
                                    leftover.push(
                                        (core.master[ch][s] / crate::graph::SIGNAL_MAX)
                                            .clamp(-1.0, 1.0),
                                    );
                                }
                            }
                        }
                        let n = (out.len() - written).min(leftover.len());
                        out[written..written + n].copy_from_slice(&leftover[..n]);
                        leftover.drain(..n);
                        written += n;
                    }
                    // Track the peak sample per report interval (racy max is
                    // fine for a debug readout; no locks/allocation).
                    let mut peak = 0.0f32;
                    for &s in out.iter() {
                        peak = peak.max(s.abs());
                    }
                    if peak > f32::from_bits(cb_peak_bits.load(Ordering::Relaxed)) {
                        cb_peak_bits.store(peak.to_bits(), Ordering::Relaxed);
                    }
                    let budget = block_dur * (out.len() as f64 / (block * channels) as f64);
                    if t0.elapsed().as_secs_f64() > budget {
                        xruns.fetch_add(1, Ordering::Relaxed);
                    }
                };
                let result = (|| -> std::result::Result<cpal::Stream, String> {
                    let host = cpal::default_host();
                    eprintln!("[dj-audio] cpal host: {:?}", host.id());
                    let device = host
                        .default_output_device()
                        .ok_or("no audio output device")?;
                    eprintln!(
                        "[dj-audio] default output device: {:?}",
                        device.name().unwrap_or_else(|e| format!("<unknown: {e}>"))
                    );
                    match device.default_output_config() {
                        Ok(def) => eprintln!(
                            "[dj-audio] device default config: {} ch @ {} Hz, {:?}, buffer {:?}",
                            def.channels(),
                            def.sample_rate().0,
                            def.sample_format(),
                            def.buffer_size()
                        ),
                        Err(e) => eprintln!("[dj-audio] default_output_config failed: {e}"),
                    }
                    let stream = device
                        .build_output_stream(
                            &config,
                            data_cb,
                            |err| eprintln!("[dj-audio] cpal stream error: {err}"),
                            None,
                        )
                        .map_err(|e| format!("build_output_stream: {e}"))?;
                    eprintln!("[dj-audio] output stream built, calling play()");
                    stream.play().map_err(|e| format!("play: {e}"))?;
                    eprintln!("[dj-audio] stream playing");
                    Ok(stream)
                })();
                match result {
                    Ok(stream) => {
                        let _ = ready_tx.send(Ok(()));
                        // Periodic debug report: proves whether the device is
                        // pulling audio (callbacks > 0) and whether the graph
                        // is producing signal (peak > 0). A running stream
                        // with peak 0.000 means the patch renders silence
                        // (e.g. the demo patch's VCA gate never opened).
                        let mut last_report = Instant::now();
                        let mut last_callbacks = 0u64;
                        let mut last_samples = 0u64;
                        while !stop_thread.load(Ordering::Relaxed) {
                            std::thread::sleep(Duration::from_millis(50));
                            if last_report.elapsed() >= Duration::from_secs(2) {
                                let cbs = dbg_callbacks.load(Ordering::Relaxed);
                                let samples = dbg_samples.load(Ordering::Relaxed);
                                let peak = f32::from_bits(dbg_peak_bits.swap(0, Ordering::Relaxed));
                                let starved = dbg_starved.load(Ordering::Relaxed);
                                eprintln!(
                                    "[dj-audio] cpal report: callbacks +{} ({} total), \
                                     samples +{}, peak {:.4}, starved {}, xruns {}",
                                    cbs - last_callbacks,
                                    cbs,
                                    samples - last_samples,
                                    peak,
                                    starved,
                                    xruns_report.load(Ordering::Relaxed),
                                );
                                if cbs == last_callbacks {
                                    eprintln!(
                                        "[dj-audio] WARNING: no cpal callbacks in the last 2s — \
                                         the OS is not pulling audio (device/permission issue?)"
                                    );
                                }
                                last_callbacks = cbs;
                                last_samples = samples;
                                last_report = Instant::now();
                            }
                        }
                        eprintln!("[dj-audio] stop requested, dropping cpal stream");
                        drop(stream);
                    }
                    Err(e) => {
                        eprintln!("[dj-audio] cpal setup FAILED: {e}");
                        let _ = ready_tx.send(Err(e));
                    }
                }
            })?;

        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.state = EngineState::RunningCpal { stop, join, slot };
                Ok(())
            }
            Ok(Err(e)) => {
                let _ = join.join();
                self.recover_core_from_slot(&slot);
                Err(anyhow!("cpal start failed: {e}"))
            }
            Err(_) => {
                let _ = join.join();
                self.recover_core_from_slot(&slot);
                Err(anyhow!("cpal thread exited before reporting readiness"))
            }
        }
    }

    #[cfg(feature = "cpal-backend")]
    fn recover_core_from_slot(&mut self, slot: &Arc<Mutex<Option<Box<EngineCore>>>>) {
        if let Some(core) = slot.lock().ok().and_then(|mut g| g.take()) {
            self.state = EngineState::Stopped(core);
        }
    }

    /// Stop a running backend. Returns the graph to the stopped state when
    /// the backend supports handing it back (null backend does; cpal drops).
    pub fn stop(&mut self) -> Result<()> {
        match std::mem::replace(&mut self.state, EngineState::Empty) {
            EngineState::Running { stop, join } => {
                stop.store(true, Ordering::Relaxed);
                let core = join.join().map_err(|_| anyhow!("rt thread panicked"))?;
                self.state = EngineState::Stopped(core);
            }
            #[cfg(feature = "cpal-backend")]
            EngineState::RunningCpal { stop, join, slot } => {
                stop.store(true, Ordering::Relaxed);
                let _ = join.join();
                // The stream is dropped (callbacks finished), so the core
                // is back in the slot: hand the graph back like the null
                // backend does.
                self.recover_core_from_slot(&slot);
            }
            other => self.state = other,
        }
        // Drain commands the RT thread didn't get to before exiting: the
        // ring must be empty whenever the engine is stopped, because
        // stopped-mode edits apply directly and must not be reordered
        // behind queued ones.
        if let EngineState::Stopped(core) = &mut self.state {
            core.apply_commands();
        }
        self.drain_garbage();
        Ok(())
    }

    pub fn drain_garbage(&mut self) {
        while self.garbage_rx.pop().is_ok() {}
        for rx in self.playback_garbage.values_mut() {
            while rx.pop().is_ok() {}
        }
        for ctl in self.decks.values_mut() {
            while ctl.garbage_rx.pop().is_ok() {}
        }
    }
}
