//! Rendering / running: offline render and the null/cpal realtime backends — split out of the old monolithic engine.rs; methods on [`Engine`] only.
//!
//! TWO DEVICES, ONE ENGINE. The graph fills two buses — the live mix and
//! the monitor (cue) one — and the cpal backend opens a stream for each,
//! on whichever hardware output the user picked ([`AudioOutputs`]). Only
//! the live callback ever touches the engine core; the monitor stream is
//! fed from it over a ring, because the two devices run on their own
//! clocks and neither may wait for the other.
//!
//! A DEVICE CAN LEAVE AT ANY MOMENT (the headphones come out mid-set), so
//! the cpal thread is a SUPERVISOR, not a one-shot setup: it watches the
//! streams it opened, and when one stops calling back it drops them and
//! looks for an output again. While there is nowhere to play, it keeps
//! processing blocks at wall-clock pace with the audio going nowhere —
//! that is what keeps the app alive, because a graph nobody processes
//! never drains the RT command ring and every edit behind it blocks.

use super::*;

/// Which hardware output each bus plays out of, by device name. `None` is
/// "the system default" for the live mix and "no monitoring at all" for
/// the monitor. A name the machine no longer has is REPORTED (see
/// [`AudioDeviceStatus::note`]) — the live mix falls back to the default device
/// so the room keeps hearing something, and the cue, which would be a
/// private mix in the room's speakers, does not fall back at all.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AudioOutputs {
    pub live: Option<String>,
    pub monitor: Option<String>,
}

/// What the audio backend is doing RIGHT NOW, as opposed to what it was
/// asked for: the device each bus actually reached, and one line saying
/// why that is not what the user picked. Published by the cpal supervisor
/// thread; read by the app's output picker.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AudioDeviceStatus {
    /// The device the live mix is coming out of. `None` = nothing is
    /// playing: no output could be opened, or no cpal backend is running.
    pub live: Option<String>,
    /// The device the cue is coming out of, when there is one.
    pub monitor: Option<String>,
    /// What the engine had to do differently from what was asked.
    pub note: Option<String>,
}

/// A stream that has gone this long without a callback is playing to a
/// device that is no longer there: CoreAudio just stops pulling when the
/// hardware a stream was opened on is unplugged, with no error to wait for.
#[cfg(feature = "cpal-backend")]
const DEVICE_STALL: Duration = Duration::from_millis(1500);

/// How often a missing output is looked for again — a device coming back
/// (or being plugged in for the first time) is picked up within this.
#[cfg(feature = "cpal-backend")]
const DEVICE_RETRY: Duration = Duration::from_millis(1000);

/// Is the stream we opened still being pulled? The callback counter is the
/// only honest liveness signal a cpal backend gives us, so device loss is
/// "the count stopped moving" (or an explicit device-gone error).
#[cfg(feature = "cpal-backend")]
struct StreamWatch {
    callbacks: u64,
    last_moved: Instant,
}

#[cfg(feature = "cpal-backend")]
impl StreamWatch {
    fn new(callbacks: u64, now: Instant) -> Self {
        Self {
            callbacks,
            last_moved: now,
        }
    }

    /// True once the device is gone for good. `errored` is cpal's own
    /// device-not-available report, which some hosts give and some don't.
    fn lost(&mut self, callbacks: u64, errored: bool, now: Instant) -> bool {
        if errored {
            return true;
        }
        if callbacks != self.callbacks {
            self.callbacks = callbacks;
            self.last_moved = now;
            return false;
        }
        now.duration_since(self.last_moved) >= DEVICE_STALL
    }
}

/// Every hardware audio output this machine can play through, by name —
/// what the app's output pickers list.
#[cfg(feature = "cpal-backend")]
pub fn audio_output_devices() -> Vec<String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let Ok(devices) = host.output_devices() else {
        return Vec::new();
    };
    let mut names: Vec<String> = devices.filter_map(|d| d.name().ok()).collect();
    names.dedup();
    names
}

#[cfg(not(feature = "cpal-backend"))]
pub fn audio_output_devices() -> Vec<String> {
    Vec::new()
}

/// The output device with this name, if the machine still has it.
#[cfg(feature = "cpal-backend")]
fn named_output(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    use cpal::traits::{DeviceTrait, HostTrait};
    host.output_devices()
        .ok()?
        .find(|d| d.name().map(|n| n == name).unwrap_or(false))
}

/// Everything the live audio callback needs, kept beside the streams so
/// they can be BUILT AGAIN after a device is lost — a closure's captures
/// go with the stream that owned them.
#[cfg(feature = "cpal-backend")]
struct LiveDeps {
    slot: Arc<Mutex<Option<Box<EngineCore>>>>,
    callbacks: Arc<AtomicU64>,
    samples: Arc<AtomicU64>,
    peak_bits: Arc<std::sync::atomic::AtomicU32>,
    starved: Arc<AtomicU64>,
    xruns: Arc<AtomicU64>,
    block: usize,
    channels: usize,
    block_secs: f64,
}

/// One open output stream, and what says whether it is still there.
#[cfg(feature = "cpal-backend")]
struct Playing {
    /// Held for its Drop: dropping the stream is what closes the device.
    _stream: cpal::Stream,
    device: String,
    errored: Arc<AtomicBool>,
    callbacks: Arc<AtomicU64>,
    watch: StreamWatch,
}

#[cfg(feature = "cpal-backend")]
impl Playing {
    fn lost(&mut self, now: Instant) -> bool {
        self.watch.lost(
            self.callbacks.load(Ordering::Relaxed),
            self.errored.load(Ordering::Relaxed),
            now,
        )
    }
}

/// The two streams are ONE session: the ring the live callback feeds the
/// cue over is built with them, so a device lost on either side rebuilds
/// both.
#[cfg(feature = "cpal-backend")]
struct Session {
    live: Playing,
    /// Absent when no cue was asked for, or its device is not here.
    monitor: Option<Playing>,
    status: AudioDeviceStatus,
}

#[cfg(feature = "cpal-backend")]
impl Session {
    /// The device that has stopped answering, if one has.
    fn lost(&mut self, now: Instant) -> Option<String> {
        if self.live.lost(now) {
            return Some(self.live.device.clone());
        }
        let mon = self.monitor.as_mut()?;
        mon.lost(now).then(|| mon.device.clone())
    }

    /// True when a cue was asked for, is not open, and its device is on
    /// the machine again (the headphones went back in).
    fn wants_monitor_back(&self, host: &cpal::Host, outputs: &AudioOutputs) -> bool {
        self.monitor.is_none()
            && outputs
                .monitor
                .as_deref()
                .is_some_and(|name| named_output(host, name).is_some())
    }
}

/// A stream's error callback: log everything, and flag the one error that
/// means the hardware is gone, so the supervisor stops waiting for
/// callbacks that are never coming.
#[cfg(feature = "cpal-backend")]
fn on_stream_error(what: &'static str, errored: Arc<AtomicBool>) -> impl FnMut(cpal::StreamError) {
    move |err| {
        eprintln!("[dj-audio] {what} stream error: {err}");
        if matches!(err, cpal::StreamError::DeviceNotAvailable) {
            errored.store(true, Ordering::Relaxed);
        }
    }
}

/// Build the live stream: the one callback that holds the engine core,
/// and (when there is a cue) fills the ring the monitor stream drains.
#[cfg(feature = "cpal-backend")]
fn build_live(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    deps: &LiveDeps,
    mut mon_tx: Option<rtrb::Producer<f32>>,
    errored: Arc<AtomicBool>,
) -> std::result::Result<cpal::Stream, String> {
    use cpal::traits::DeviceTrait;
    let slot = deps.slot.clone();
    let (callbacks, samples, peak_bits, starved, xruns) = (
        deps.callbacks.clone(),
        deps.samples.clone(),
        deps.peak_bits.clone(),
        deps.starved.clone(),
        deps.xruns.clone(),
    );
    let (block, channels, block_secs) = (deps.block, deps.channels, deps.block_secs);
    let mut leftover: Vec<f32> = Vec::with_capacity(block * channels);
    let data_cb = move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
        callbacks.fetch_add(1, Ordering::Relaxed);
        samples.fetch_add(out.len() as u64, Ordering::Relaxed);
        let mut guard = match slot.try_lock() {
            Ok(g) => g,
            Err(_) => {
                starved.fetch_add(1, Ordering::Relaxed);
                out.fill(0.0);
                return;
            }
        };
        let Some(core) = guard.as_mut() else {
            starved.fetch_add(1, Ordering::Relaxed);
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
                        leftover
                            .push((core.master[ch][s] / crate::graph::SIGNAL_MAX).clamp(-1.0, 1.0));
                        if let Some(tx) = mon_tx.as_mut() {
                            // Full ring = the monitor device is behind;
                            // drop rather than block the live callback.
                            let _ = tx.push(
                                (core.monitor[ch][s] / crate::graph::SIGNAL_MAX).clamp(-1.0, 1.0),
                            );
                        }
                    }
                }
            }
            let n = (out.len() - written).min(leftover.len());
            out[written..written + n].copy_from_slice(&leftover[..n]);
            leftover.drain(..n);
            written += n;
        }
        // Track the peak sample per report interval (racy max is fine for
        // a debug readout; no locks/allocation).
        let mut peak = 0.0f32;
        for &s in out.iter() {
            peak = peak.max(s.abs());
        }
        if peak > f32::from_bits(peak_bits.load(Ordering::Relaxed)) {
            peak_bits.store(peak.to_bits(), Ordering::Relaxed);
        }
        let budget = block_secs * (out.len() as f64 / (block * channels) as f64);
        if t0.elapsed().as_secs_f64() > budget {
            xruns.fetch_add(1, Ordering::Relaxed);
        }
    };
    device
        .build_output_stream(config, data_cb, on_stream_error("live", errored), None)
        .map_err(|e| format!("build_output_stream: {e}"))
}

/// Build the cue stream: it never touches the core, only the ring.
#[cfg(feature = "cpal-backend")]
fn build_monitor(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut mon_rx: rtrb::Consumer<f32>,
    callbacks: Arc<AtomicU64>,
    errored: Arc<AtomicBool>,
) -> std::result::Result<cpal::Stream, String> {
    use cpal::traits::DeviceTrait;
    let mon_cb = move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
        callbacks.fetch_add(1, Ordering::Relaxed);
        for s in out.iter_mut() {
            // Nothing queued yet (or the live stream is late): silence is
            // the only honest thing to play.
            *s = mon_rx.pop().unwrap_or(0.0);
        }
    };
    device
        .build_output_stream(config, mon_cb, on_stream_error("monitor", errored), None)
        .map_err(|e| format!("build_output_stream: {e}"))
}

/// Open both streams on the devices the user asked for, or on the nearest
/// thing the machine still has. Errs only when there is no live output at
/// all — a missing cue device costs the cue, never the room.
#[cfg(feature = "cpal-backend")]
fn open_session(
    host: &cpal::Host,
    config: &cpal::StreamConfig,
    deps: &LiveDeps,
    outputs: &AudioOutputs,
    mon_capacity: usize,
) -> std::result::Result<Session, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let mut notes: Vec<String> = Vec::new();
    let device = match &outputs.live {
        Some(name) => match named_output(host, name) {
            Some(device) => device,
            None => {
                notes.push(format!(
                    "{name} is not here — playing on the system default"
                ));
                host.default_output_device()
                    .ok_or_else(|| "no audio output device".to_string())?
            }
        },
        None => host
            .default_output_device()
            .ok_or_else(|| "no audio output device".to_string())?,
    };
    let live_name = device.name().unwrap_or_else(|e| format!("<unknown: {e}>"));
    eprintln!("[dj-audio] live output device: {live_name:?}");
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
    let (mon_tx, mon_rx) = match outputs.monitor {
        Some(_) => {
            let (tx, rx) = rtrb::RingBuffer::<f32>::new(mon_capacity);
            (Some(tx), Some(rx))
        }
        None => (None, None),
    };
    let live_errored = Arc::new(AtomicBool::new(false));
    let stream = build_live(&device, config, deps, mon_tx, live_errored.clone())?;
    stream.play().map_err(|e| format!("play: {e}"))?;
    eprintln!("[dj-audio] stream playing");
    let now = Instant::now();
    let live = Playing {
        _stream: stream,
        device: live_name.clone(),
        errored: live_errored,
        watch: StreamWatch::new(deps.callbacks.load(Ordering::Relaxed), now),
        callbacks: deps.callbacks.clone(),
    };

    // The cue is optional in the strongest sense: if it cannot be opened
    // the live output still plays, and the cue is what is lost. It never
    // falls back to another device — a private mix in the room's speakers
    // is worse than no cue at all.
    let monitor = match (&outputs.monitor, mon_rx) {
        (Some(name), Some(mon_rx)) => {
            let errored = Arc::new(AtomicBool::new(false));
            let callbacks = Arc::new(AtomicU64::new(0));
            let built = named_output(host, name)
                .ok_or_else(|| format!("no output device named {name:?}"))
                .and_then(|dev| {
                    let stream =
                        build_monitor(&dev, config, mon_rx, callbacks.clone(), errored.clone())?;
                    stream.play().map_err(|e| format!("play: {e}"))?;
                    Ok(stream)
                });
            match built {
                Ok(stream) => {
                    eprintln!("[dj-audio] monitor stream playing on {name:?}");
                    Some(Playing {
                        _stream: stream,
                        device: name.clone(),
                        errored,
                        watch: StreamWatch::new(0, now),
                        callbacks,
                    })
                }
                Err(e) => {
                    eprintln!("[dj-audio] monitor stream on {name:?} failed: {e}");
                    notes.push(format!("no cue: {name} is not here"));
                    None
                }
            }
        }
        _ => None,
    };
    let status = AudioDeviceStatus {
        live: Some(live_name),
        monitor: monitor.as_ref().map(|m| m.device.clone()),
        note: (!notes.is_empty()).then(|| notes.join("; ")),
    };
    Ok(Session {
        live,
        monitor,
        status,
    })
}

#[cfg(feature = "cpal-backend")]
fn publish(cell: &Arc<Mutex<AudioDeviceStatus>>, status: AudioDeviceStatus) {
    if let Ok(mut held) = cell.lock() {
        *held = status;
    }
}

/// No device: run the graph anyway, at wall-clock pace, into nothing.
/// The audio of those blocks is lost — but clocks keep time and, above
/// all, the RT command ring KEEPS DRAINING, so the control thread's edits
/// do not pile up behind hardware that is not there. That is the
/// difference between "the headphones came out" and "the app froze".
#[cfg(feature = "cpal-backend")]
fn pace_silent(
    slot: &Arc<Mutex<Option<Box<EngineCore>>>>,
    block: usize,
    block_dur: Duration,
    deadline: &mut Instant,
) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(core) = guard.as_mut() {
            core.process_block(block);
        }
    }
    let now = Instant::now();
    if *deadline <= now {
        // Late (or just back from a device that was pulling): start the
        // pacing again from here rather than sprinting to catch up.
        *deadline = now + block_dur;
    } else {
        std::thread::sleep(*deadline - now);
        *deadline += block_dur;
    }
}

impl Engine {
    // ------------------------------------------------------------------
    // Rendering / running
    // ------------------------------------------------------------------

    /// Offline render (faster than realtime): process `total_frames` and
    /// return the master bus as one Vec per channel, in engine units
    /// (nominal [-10, +10], unclipped).
    pub fn render_offline(&mut self, total_frames: usize) -> Result<Vec<Vec<f32>>> {
        self.render_bus(total_frames, false)
    }

    /// Offline render of the MONITOR (cue) bus instead of the master —
    /// what the headphones would have heard over the same blocks.
    pub fn render_offline_monitor(&mut self, total_frames: usize) -> Result<Vec<Vec<f32>>> {
        self.render_bus(total_frames, true)
    }

    fn render_bus(&mut self, total_frames: usize, monitor: bool) -> Result<Vec<Vec<f32>>> {
        let block = self.config.block_size;
        let channels = self.config.master_channels;
        let mut out: Vec<Vec<f32>> = vec![Vec::with_capacity(total_frames); channels];
        let core = self.core_mut()?;
        let mut done = 0;
        while done < total_frames {
            let frames = block.min(total_frames - done);
            core.process_block(frames);
            let bus = if monitor { &core.monitor } else { &core.master };
            for (ch, buf) in out.iter_mut().enumerate() {
                buf.extend_from_slice(&bus[ch][..frames]);
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

    /// Which hardware outputs the two buses go to. Set by the app from its
    /// own settings — a device name belongs to the MACHINE, not to the
    /// patch, so it is never saved with one.
    pub fn audio_outputs(&self) -> &AudioOutputs {
        &self.audio_outputs
    }

    /// Choose the live and monitor devices. Takes effect at the next
    /// backend start; the caller restarts the backend to hear it.
    pub fn set_audio_outputs(&mut self, outputs: AudioOutputs) {
        self.audio_outputs = outputs;
    }

    /// What the backend is playing through RIGHT NOW — which is not always
    /// what was asked for, because a device can be unplugged mid-set. All
    /// `None` means nothing is playing (stopped, or no output at all).
    pub fn audio_device_status(&self) -> AudioDeviceStatus {
        self.audio_device_status
            .lock()
            .map(|held| held.clone())
            .unwrap_or_default()
    }

    /// Start the cpal device backend (requires a working audio device).
    #[cfg(feature = "cpal-backend")]
    pub fn start_cpal(&mut self) -> Result<()> {
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
        let block_secs = block as f64 / self.config.sample_rate as f64;
        let block_dur = Duration::from_secs_f64(block_secs);

        // The core lives in a shared slot for the whole cpal run. The audio
        // callback try_locks it per callback: a single uncontended CAS in
        // steady state (the control thread only touches the slot after the
        // stream is dropped). This keeps the core recoverable both when
        // stream setup fails (fall back to another backend) and at stop()
        // (structural edits like adding modules/wires need the graph back).
        let slot: Arc<Mutex<Option<Box<EngineCore>>>> = Arc::new(Mutex::new(Some(core)));
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();

        // Debug counters for the periodic level report (updated lock-free
        // from the audio callback, printed by the supervisor loop below).
        let deps = LiveDeps {
            slot: slot.clone(),
            callbacks: Arc::new(AtomicU64::new(0)),
            samples: Arc::new(AtomicU64::new(0)),
            peak_bits: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            starved: Arc::new(AtomicU64::new(0)),
            xruns: self.xruns.clone(),
            block,
            channels,
            block_secs,
        };
        let (dbg_callbacks, dbg_samples, dbg_peak_bits, dbg_starved) = (
            deps.callbacks.clone(),
            deps.samples.clone(),
            deps.peak_bits.clone(),
            deps.starved.clone(),
        );
        let xruns_report = self.xruns.clone();

        // A quarter second of slack on the ring between the two streams
        // absorbs the drift between two devices on their own clocks.
        let outputs = self.audio_outputs.clone();
        let mon_capacity = channels * self.config.sample_rate as usize / 4;
        let status = self.audio_device_status.clone();

        // The streams are created, driven, and dropped entirely on this
        // thread: cpal::Stream is !Send on CoreAudio, so it must never
        // cross threads (and Engine must stay Send for the Tauri shell).
        let join = std::thread::Builder::new()
            .name("dj-cpal".into())
            .spawn(move || {
                let host = cpal::default_host();
                eprintln!("[dj-audio] cpal host: {:?}", host.id());
                let mut open = match open_session(&host, &config, &deps, &outputs, mon_capacity) {
                    Ok(session) => {
                        publish(&status, session.status.clone());
                        let _ = ready_tx.send(Ok(()));
                        Some(session)
                    }
                    Err(e) => {
                        // No output at all at start: the caller falls back
                        // to the null backend, which is this thread's job
                        // done.
                        eprintln!("[dj-audio] cpal setup FAILED: {e}");
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let mut next_try = Instant::now() + DEVICE_RETRY;
                let mut silent_deadline = Instant::now();
                let mut last_report = Instant::now();
                let mut last_callbacks = 0u64;
                let mut last_samples = 0u64;
                while !stop_thread.load(Ordering::Relaxed) {
                    let now = Instant::now();
                    if let Some(session) = open.as_mut() {
                        if let Some(gone) = session.lost(now) {
                            eprintln!(
                                "[dj-audio] {gone:?} stopped answering — dropping the streams \
                                 and looking for an output"
                            );
                            publish(
                                &status,
                                AudioDeviceStatus {
                                    note: Some(format!("{gone} is gone — looking for an output")),
                                    ..AudioDeviceStatus::default()
                                },
                            );
                            open = None;
                            // Give the OS a moment to settle its default
                            // device before asking it for one.
                            next_try = now + DEVICE_RETRY;
                            silent_deadline = now;
                            continue;
                        }
                        // The cue device the user asked for may have come
                        // back. The ring between the two streams is built
                        // with them, so taking it back rebuilds both.
                        if now >= next_try {
                            next_try = now + DEVICE_RETRY;
                            if session.wants_monitor_back(&host, &outputs) {
                                eprintln!("[dj-audio] the cue device is back — reopening");
                                open = None;
                                next_try = now;
                                continue;
                            }
                        }
                    }
                    if open.is_none() && now >= next_try {
                        next_try = now + DEVICE_RETRY;
                        match open_session(&host, &config, &deps, &outputs, mon_capacity) {
                            Ok(session) => {
                                publish(&status, session.status.clone());
                                open = Some(session);
                                last_report = Instant::now();
                            }
                            Err(e) => publish(
                                &status,
                                AudioDeviceStatus {
                                    note: Some(format!("no audio output ({e})")),
                                    ..AudioDeviceStatus::default()
                                },
                            ),
                        }
                    }
                    if open.is_none() {
                        // Nowhere to play, so play nowhere — but KEEP
                        // PROCESSING: a graph nobody runs never drains the
                        // RT command ring, and every control-thread edit
                        // behind it would block. See `pace_silent`.
                        pace_silent(&deps.slot, block, block_dur, &mut silent_deadline);
                        continue;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                    // Periodic debug report: proves whether the device is
                    // pulling audio (callbacks > 0) and whether the graph
                    // is producing signal (peak > 0). A running stream
                    // with peak 0.000 means the patch renders silence
                    // (e.g. the demo patch's VCA gate never opened).
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
                        last_callbacks = cbs;
                        last_samples = samples;
                        last_report = Instant::now();
                    }
                }
                eprintln!("[dj-audio] stop requested, dropping cpal streams");
                drop(open);
                publish(&status, AudioDeviceStatus::default());
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
        if let Ok(mut status) = self.audio_device_status.lock() {
            *status = AudioDeviceStatus::default();
        }
        self.drain_garbage();
        Ok(())
    }

    pub fn drain_garbage(&mut self) {
        while self.garbage_rx.pop().is_ok() {}
        for rx in self.playback_garbage.values_mut() {
            while rx.pop().is_ok() {}
        }
        for ctl in self.audios.values_mut() {
            while ctl.garbage_rx.pop().is_ok() {}
        }
        for ctl in self.decks.values_mut() {
            while ctl.garbage_rx.pop().is_ok() {}
        }
        for ctl in self.clip_decks.values_mut() {
            while ctl.garbage_rx.pop().is_ok() {}
        }
        for ctl in self.beat_clips.values_mut() {
            while ctl.garbage_rx.pop().is_ok() {}
        }
    }
}

/// Device loss is decided by a clock, so the decision is tested on one: a
/// stream whose callback count has stopped moving is a device that has
/// gone, and the engine must not sit waiting for it.
#[cfg(all(test, feature = "cpal-backend"))]
mod tests {
    use super::*;

    #[test]
    fn a_stream_being_pulled_is_never_called_lost() {
        let t0 = Instant::now();
        let mut watch = StreamWatch::new(0, t0);
        for tick in 1..=200u64 {
            let now = t0 + Duration::from_millis(50 * tick);
            assert!(!watch.lost(tick, false, now), "tick {tick}");
        }
    }

    #[test]
    fn a_stream_that_stops_calling_back_is_lost_after_the_stall_window() {
        let t0 = Instant::now();
        let mut watch = StreamWatch::new(0, t0);
        let last_pull = t0 + Duration::from_millis(50);
        assert!(!watch.lost(7, false, last_pull));
        // The count is frozen from here on: the headphones are out.
        assert!(!watch.lost(
            7,
            false,
            last_pull + DEVICE_STALL - Duration::from_millis(1)
        ));
        assert!(watch.lost(7, false, last_pull + DEVICE_STALL));
    }

    #[test]
    fn a_device_gone_error_is_not_waited_out() {
        let t0 = Instant::now();
        let mut watch = StreamWatch::new(0, t0);
        assert!(watch.lost(0, true, t0));
    }

    #[test]
    fn callbacks_resuming_restart_the_stall_window() {
        let t0 = Instant::now();
        let mut watch = StreamWatch::new(0, t0);
        let late = t0 + DEVICE_STALL - Duration::from_millis(1);
        assert!(!watch.lost(1, false, late));
        // A pull that late is still a pull: the window runs again from it.
        assert!(!watch.lost(1, false, late + DEVICE_STALL - Duration::from_millis(1)));
        assert!(watch.lost(1, false, late + DEVICE_STALL));
    }
}
