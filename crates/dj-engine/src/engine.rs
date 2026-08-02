//! Engine control layer: node bookkeeping, RT command queue, backends,
//! offline rendering, MIDI control (virtual injection + learn), hot reload.

use anyhow::{anyhow, Result};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::builtin::{
    AudioOutModule, MidiEvent, MidiModule, MidiShared, AUDIO_OUT_ID, MAP_KIND_CC, MAP_KIND_NOTE,
    MIDI_ID,
};
use crate::graph::{Graph, GraphNode, WireSpec};
use crate::knob::{position_for_value, JackRt, KnobConfig, KnobState};
use crate::manifest::Manifest;
use crate::module_host::HostModule;
use crate::registry::ExtensionRegistry;
use crate::telemetry::{JackAnalyzer, JackSlot, JackTelemetry};
use crate::wasm_host::WasmRuntime;

pub const DEFAULT_SAMPLE_RATE: f32 = 48_000.0;
pub const DEFAULT_BLOCK_SIZE: usize = 128;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub sample_rate: f32,
    pub block_size: usize,
    pub master_channels: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            sample_rate: DEFAULT_SAMPLE_RATE,
            block_size: DEFAULT_BLOCK_SIZE,
            master_channels: 2,
        }
    }
}

/// Commands applied by the RT thread at block boundaries (fixed-size pops
/// from a pre-allocated SPSC ring; no locks on the RT side).
pub enum Command {
    SetParam {
        node: usize,
        index: u32,
        value: f32,
    },
    SetKnobRt {
        node: usize,
        jack: usize,
        rt: JackRt,
    },
    SwapModule {
        node: usize,
        module: Box<dyn HostModule>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MidiMappingInfo {
    pub name: String,
    /// "cc" | "note"
    pub kind: String,
    pub num: u8,
    /// Output jack index on the MIDI node.
    pub jack: usize,
}

use serde::{Deserialize, Serialize};

/// Control-side metadata for one node.
pub struct NodeInfo {
    pub instance_id: String,
    pub ext_id: String,
    pub manifest: Manifest,
    pub knobs: Vec<KnobState>,
    pub params: BTreeMap<String, f32>,
    pub telemetry: Vec<Arc<JackSlot>>,
    pub midi_shared: Option<Arc<MidiShared>>,
    pub midi_mappings: Vec<MidiMappingInfo>,
}

/// RT-side core: graph + queues + counters. Lives on whichever thread the
/// active backend drives.
pub struct EngineCore {
    pub graph: Graph,
    cmd_rx: rtrb::Consumer<Command>,
    garbage_tx: rtrb::Producer<Box<dyn HostModule>>,
    pub master: Vec<Vec<f32>>,
    blocks: Arc<AtomicU64>,
    master_analyzers: Vec<crate::telemetry::JackAnalyzer>,
}

impl EngineCore {
    fn apply_commands(&mut self) {
        while let Ok(cmd) = self.cmd_rx.pop() {
            match cmd {
                Command::SetParam { node, index, value } => {
                    self.graph.nodes[node].module.on_param(index, value);
                }
                Command::SetKnobRt { node, jack, rt } => {
                    self.graph.set_jack_rt(node, jack, rt);
                }
                Command::SwapModule { node, module } => {
                    let old = self.graph.swap_module(node, module);
                    // Ship the old instance back for off-RT drop; if the ring
                    // is full we must drop here (bounded, reload-only path).
                    let _ = self.garbage_tx.push(old);
                }
            }
        }
    }

    pub fn process_block(&mut self, frames: usize) {
        self.apply_commands();
        self.graph.process_block(frames, &mut self.master);
        for (ch, an) in self.master_analyzers.iter_mut().enumerate() {
            an.update(&self.master[ch][..frames]);
        }
        self.blocks.fetch_add(1, Ordering::Relaxed);
    }
}

enum EngineState {
    Stopped(Box<EngineCore>),
    Running {
        stop: Arc<AtomicBool>,
        join: std::thread::JoinHandle<Box<EngineCore>>,
    },
    #[cfg(feature = "cpal-backend")]
    RunningCpal {
        stream: cpal::Stream,
    },
    Empty,
}

pub struct Engine {
    pub config: EngineConfig,
    pub registry: ExtensionRegistry,
    wasm: WasmRuntime,
    state: EngineState,
    pub nodes: Vec<NodeInfo>,
    node_by_id: HashMap<String, usize>,
    /// Control-side copy of the wire list (graph itself may be on the RT thread).
    wires: Vec<WireSpec>,
    cmd_tx: Arc<Mutex<rtrb::Producer<Command>>>,
    garbage_rx: rtrb::Consumer<Box<dyn HostModule>>,
    midi_producers: HashMap<usize, rtrb::Producer<MidiEvent>>,
    xruns: Arc<AtomicU64>,
    blocks: Arc<AtomicU64>,
    master_slots: Vec<Arc<JackSlot>>,
    /// dsp.wasm mtimes for the polling hot-reload watcher.
    watch_state: Arc<Mutex<HashMap<String, std::time::SystemTime>>>,
    watcher_stop: Option<Arc<AtomicBool>>,
    watcher_join: Option<std::thread::JoinHandle<()>>,
}

const CMD_QUEUE_CAP: usize = 1024;

impl Engine {
    pub fn new(config: EngineConfig, registry: ExtensionRegistry) -> Result<Self> {
        let (cmd_tx, cmd_rx) = rtrb::RingBuffer::new(CMD_QUEUE_CAP);
        let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(CMD_QUEUE_CAP);
        let blocks = Arc::new(AtomicU64::new(0));
        let master_slots: Vec<Arc<JackSlot>> = (0..config.master_channels)
            .map(|_| Arc::new(JackSlot::default()))
            .collect();
        let master_analyzers = master_slots
            .iter()
            .map(|s| JackAnalyzer::new(s.clone(), config.sample_rate, config.block_size))
            .collect();
        let core = EngineCore {
            graph: Graph::new(config.block_size),
            cmd_rx,
            garbage_tx,
            master: vec![vec![0.0; config.block_size]; config.master_channels],
            blocks: blocks.clone(),
            master_analyzers,
        };
        Ok(Engine {
            config,
            registry,
            wasm: WasmRuntime::new()?,
            state: EngineState::Stopped(Box::new(core)),
            nodes: Vec::new(),
            node_by_id: HashMap::new(),
            wires: Vec::new(),
            cmd_tx: Arc::new(Mutex::new(cmd_tx)),
            garbage_rx,
            midi_producers: HashMap::new(),
            xruns: Arc::new(AtomicU64::new(0)),
            blocks,
            master_slots,
            watch_state: Arc::new(Mutex::new(HashMap::new())),
            watcher_stop: None,
            watcher_join: None,
        })
    }

    fn core_mut(&mut self) -> Result<&mut EngineCore> {
        match &mut self.state {
            EngineState::Stopped(core) => Ok(core),
            _ => Err(anyhow!("engine is running; stop it first")),
        }
    }

    pub fn is_running(&self) -> bool {
        !matches!(self.state, EngineState::Stopped(_))
    }

    fn node_idx(&self, instance_id: &str) -> Result<usize> {
        self.node_by_id
            .get(instance_id)
            .copied()
            .ok_or_else(|| anyhow!("no node {instance_id:?}"))
    }

    fn jack_index(&self, node: usize, jack_id: &str) -> Result<usize> {
        self.nodes[node]
            .manifest
            .inputs
            .iter()
            .position(|j| j.id == jack_id)
            .ok_or_else(|| {
                anyhow!(
                    "no input jack {jack_id:?} on {}",
                    self.nodes[node].instance_id
                )
            })
    }

    fn out_jack_index(&self, node: usize, jack_id: &str) -> Result<usize> {
        let info = &self.nodes[node];
        // MIDI nodes expose named mapping jacks.
        if info.ext_id == MIDI_ID {
            if let Some(m) = info.midi_mappings.iter().find(|m| m.name == jack_id) {
                return Ok(m.jack);
            }
        }
        info.manifest
            .outputs
            .iter()
            .position(|j| j.id == jack_id)
            .ok_or_else(|| anyhow!("no output jack {jack_id:?} on {}", info.instance_id))
    }

    /// Instantiate a module for a node (initial add or hot reload).
    fn instantiate(&self, ext_id: &str, manifest: &Manifest) -> Result<Box<dyn HostModule>> {
        match ext_id {
            AUDIO_OUT_ID => Ok(Box::new(AudioOutModule { channel_offset: 0 })),
            MIDI_ID => Err(anyhow!("midi modules are created via add_module")),
            _ => {
                let ext = self
                    .registry
                    .extension(ext_id)
                    .ok_or_else(|| anyhow!("unknown extension {ext_id:?}"))?;
                let compiled = self.wasm.compile_file(&ext.dsp_path)?;
                let host = self.wasm.instantiate(
                    &compiled,
                    self.config.sample_rate,
                    self.config.block_size,
                    manifest.inputs.len(),
                    manifest.outputs.len(),
                )?;
                Ok(Box::new(host))
            }
        }
    }

    /// Add a module instance. Only valid while stopped.
    pub fn add_module(&mut self, instance_id: &str, ext_id: &str) -> Result<()> {
        anyhow::ensure!(
            !self.node_by_id.contains_key(instance_id),
            "duplicate instance id {instance_id:?}"
        );
        let manifest = self
            .registry
            .manifest(ext_id)
            .ok_or_else(|| anyhow!("unknown extension {ext_id:?}"))?;

        let mut midi_shared = None;
        let module: Box<dyn HostModule> = if ext_id == MIDI_ID {
            let (tx, rx) = rtrb::RingBuffer::new(4096);
            let shared = Arc::new(MidiShared::default());
            midi_shared = Some(shared.clone());
            self.midi_producers.insert(self.nodes.len(), tx);
            Box::new(MidiModule::new(rx, shared))
        } else {
            self.instantiate(ext_id, &manifest)?
        };

        // Initialize knobs from manifest defaults.
        let mut knobs = Vec::with_capacity(manifest.inputs.len());
        for input in &manifest.inputs {
            let cfg = input.knob.clone().unwrap_or_default();
            let position = position_for_value(&cfg, input.default);
            knobs.push(KnobState {
                position,
                atten: 1.0,
                offset: 0.0,
                config: None,
            });
        }
        let mut params = BTreeMap::new();
        for p in &manifest.params {
            params.insert(p.id.clone(), p.default_f32());
        }

        let telemetry: Vec<Arc<JackSlot>> = manifest
            .inputs
            .iter()
            .map(|_| Arc::new(JackSlot::default()))
            .collect();
        let analyzers: Vec<JackAnalyzer> = telemetry
            .iter()
            .map(|s| JackAnalyzer::new(s.clone(), self.config.sample_rate, self.config.block_size))
            .collect();
        let jack_rt: Vec<JackRt> = manifest
            .inputs
            .iter()
            .zip(&knobs)
            .map(|(decl, state)| JackRt::from_state(state, decl.knob.as_ref(), decl.default))
            .collect();

        let info = NodeInfo {
            instance_id: instance_id.to_string(),
            ext_id: ext_id.to_string(),
            manifest: manifest.clone(),
            knobs,
            params: params.clone(),
            telemetry,
            midi_shared,
            midi_mappings: Vec::new(),
        };

        let node = GraphNode {
            module,
            n_in: manifest.inputs.len(),
            n_out: manifest.outputs.len(),
            audio_out: ext_id == AUDIO_OUT_ID,
        };
        let core = self.core_mut()?;
        let idx = core.graph.add_node(node, jack_rt, analyzers);
        // Apply default params.
        for (i, p) in manifest.params.iter().enumerate() {
            core.graph.nodes[idx]
                .module
                .on_param(i as u32, params[&p.id]);
        }
        debug_assert_eq!(idx, self.nodes.len());
        self.node_by_id.insert(instance_id.to_string(), idx);
        self.nodes.push(info);
        Ok(())
    }

    pub fn connect(
        &mut self,
        from_id: &str,
        from_jack: &str,
        to_id: &str,
        to_jack: &str,
    ) -> Result<()> {
        let from_node = self.node_idx(from_id)?;
        let to_node = self.node_idx(to_id)?;
        let from_jack = self.out_jack_index(from_node, from_jack)?;
        let to_jack = self.jack_index(to_node, to_jack)?;
        let spec = WireSpec {
            from_node,
            from_jack,
            to_node,
            to_jack,
        };
        self.core_mut()?.graph.add_wire(spec);
        self.wires.push(spec);
        Ok(())
    }

    /// Control-side wire list (valid regardless of run state).
    pub fn wire_specs(&self) -> &[WireSpec] {
        &self.wires
    }

    /// Resolve an output jack index to its persistent name.
    pub fn output_jack_name(&self, node: usize, jack: usize) -> String {
        let info = &self.nodes[node];
        if info.ext_id == MIDI_ID {
            if let Some(m) = info.midi_mappings.iter().find(|m| m.jack == jack) {
                return m.name.clone();
            }
        }
        info.manifest.outputs[jack].id.clone()
    }

    /// Restore a full knob state (used by patch load).
    pub fn restore_knob(
        &mut self,
        instance_id: &str,
        jack_id: &str,
        state: KnobState,
    ) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let jack = self.jack_index(node, jack_id)?;
        self.nodes[node].knobs[jack] = state;
        self.push_knob_rt(node, jack)
    }

    pub fn set_param(&mut self, instance_id: &str, param_id: &str, value: f32) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let index = self.nodes[node]
            .manifest
            .params
            .iter()
            .position(|p| p.id == param_id)
            .ok_or_else(|| anyhow!("no param {param_id:?}"))? as u32;
        self.nodes[node].params.insert(param_id.to_string(), value);
        match &mut self.state {
            EngineState::Stopped(core) => core.graph.nodes[node].module.on_param(index, value),
            _ => self
                .cmd_tx
                .lock()
                .unwrap()
                .push(Command::SetParam { node, index, value })
                .map_err(|_| anyhow!("command queue full"))?,
        }
        Ok(())
    }

    fn push_knob_rt(&mut self, node: usize, jack: usize) -> Result<()> {
        let info = &self.nodes[node];
        let decl = &info.manifest.inputs[jack];
        let rt = JackRt::from_state(&info.knobs[jack], decl.knob.as_ref(), decl.default);
        match &mut self.state {
            EngineState::Stopped(core) => core.graph.set_jack_rt(node, jack, rt),
            _ => self
                .cmd_tx
                .lock()
                .unwrap()
                .push(Command::SetKnobRt { node, jack, rt })
                .map_err(|_| anyhow!("command queue full"))?,
        }
        Ok(())
    }

    pub fn set_knob_position(
        &mut self,
        instance_id: &str,
        jack_id: &str,
        position: f32,
    ) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let jack = self.jack_index(node, jack_id)?;
        self.nodes[node].knobs[jack].position = position.clamp(0.0, 1.0);
        self.push_knob_rt(node, jack)
    }

    pub fn set_knob_atten_offset(
        &mut self,
        instance_id: &str,
        jack_id: &str,
        atten: f32,
        offset: f32,
    ) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let jack = self.jack_index(node, jack_id)?;
        self.nodes[node].knobs[jack].atten = atten.clamp(-1.0, 1.0);
        self.nodes[node].knobs[jack].offset = offset;
        self.push_knob_rt(node, jack)
    }

    /// Right-click knob reconfiguration: style/endpoints/curve, per patch.
    pub fn set_knob_config(
        &mut self,
        instance_id: &str,
        jack_id: &str,
        config: Option<KnobConfig>,
    ) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let jack = self.jack_index(node, jack_id)?;
        self.nodes[node].knobs[jack].config = config;
        self.push_knob_rt(node, jack)
    }

    pub fn knob_state(&self, instance_id: &str, jack_id: &str) -> Result<KnobState> {
        let node = self.node_idx(instance_id)?;
        let jack = self.jack_index(node, jack_id)?;
        Ok(self.nodes[node].knobs[jack].clone())
    }

    /// Read a jack's live telemetry (`graph.tap`) — instantaneous value,
    /// 100 ms RMS, fast flag, and the value the UI should display.
    pub fn tap(&self, instance_id: &str, jack_id: &str) -> Result<JackTelemetry> {
        let node = self.node_idx(instance_id)?;
        let jack = self.jack_index(node, jack_id)?;
        Ok(self.nodes[node].telemetry[jack].read())
    }

    /// Telemetry for a master output channel.
    pub fn tap_master(&self, channel: usize) -> Result<JackTelemetry> {
        self.master_slots
            .get(channel)
            .map(|s| s.read())
            .ok_or_else(|| anyhow!("no master channel {channel}"))
    }

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
        let kind = ((encoded >> 8) & 0xFF) as u8;
        let num = (encoded & 0xFF) as u8;
        Ok(Some(self.add_midi_mapping_raw(node, kind, num, name)?))
    }

    /// Create a mapping directly (used by learn and by patch load).
    pub fn add_midi_mapping(
        &mut self,
        instance_id: &str,
        kind: &str,
        num: u8,
        name: &str,
    ) -> Result<MidiMappingInfo> {
        let node = self.node_idx(instance_id)?;
        let kind = match kind {
            "cc" => MAP_KIND_CC,
            "note" => MAP_KIND_NOTE,
            other => return Err(anyhow!("unknown mapping kind {other:?}")),
        };
        self.add_midi_mapping_raw(node, kind, num, name)
    }

    fn add_midi_mapping_raw(
        &mut self,
        node: usize,
        kind: u8,
        num: u8,
        name: &str,
    ) -> Result<MidiMappingInfo> {
        let shared = self.nodes[node]
            .midi_shared
            .as_ref()
            .ok_or_else(|| anyhow!("not a MIDI module"))?;
        let jack = shared
            .add_mapping(kind, num)
            .ok_or_else(|| anyhow!("mapping table full"))?;
        let info = MidiMappingInfo {
            name: name.to_string(),
            kind: if kind == MAP_KIND_CC { "cc" } else { "note" }.to_string(),
            num,
            jack,
        };
        self.nodes[node].midi_mappings.push(info.clone());
        Ok(info)
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
        let block = self.config.block_size;
        let block_dur = Duration::from_secs_f64(block as f64 / self.config.sample_rate as f64);
        let join = std::thread::Builder::new()
            .name("dj-rt-null".into())
            .spawn(move || {
                let mut core = core;
                let mut deadline = Instant::now() + block_dur;
                while !stop2.load(Ordering::Relaxed) {
                    core.process_block(block);
                    let now = Instant::now();
                    if now > deadline + block_dur {
                        // We missed a whole block period: xrun.
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
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| anyhow!("no audio output device"))?;
        let config = cpal::StreamConfig {
            channels: self.config.master_channels as u16,
            sample_rate: cpal::SampleRate(self.config.sample_rate as u32),
            buffer_size: cpal::BufferSize::Default,
        };
        let block = self.config.block_size;
        let channels = self.config.master_channels;
        let xruns = self.xruns.clone();
        let block_dur = block as f64 / self.config.sample_rate as f64;
        let mut core = core;
        let mut leftover: Vec<f32> = Vec::with_capacity(block * channels);
        let stream = device.build_output_stream(
            &config,
            move |out: &mut [f32], _| {
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
                let budget = block_dur * (out.len() as f64 / (block * channels) as f64);
                if t0.elapsed().as_secs_f64() > budget {
                    xruns.fetch_add(1, Ordering::Relaxed);
                }
            },
            move |err| eprintln!("cpal stream error: {err}"),
            None,
        )?;
        stream.play()?;
        self.state = EngineState::RunningCpal { stream };
        Ok(())
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
            EngineState::RunningCpal { stream } => {
                drop(stream);
                // Graph is consumed by the cpal callback; the engine must be
                // rebuilt (e.g. by reloading the patch) to continue offline.
            }
            other => self.state = other,
        }
        self.drain_garbage();
        Ok(())
    }

    pub fn drain_garbage(&mut self) {
        while self.garbage_rx.pop().is_ok() {}
    }

    pub fn xrun_count(&self) -> u64 {
        self.xruns.load(Ordering::Relaxed)
    }

    pub fn blocks_processed(&self) -> u64 {
        self.blocks.load(Ordering::Relaxed)
    }

    pub fn current_frame(&self) -> u64 {
        self.blocks_processed() * self.config.block_size as u64
    }

    // ------------------------------------------------------------------
    // Hot reload
    // ------------------------------------------------------------------

    /// Recompile an extension's dsp.wasm and swap it into every live node
    /// using it: save_state -> new instance -> load_state -> atomic swap at
    /// a block boundary (PRD §5.4).
    pub fn reload_extension(&mut self, ext_id: &str) -> Result<usize> {
        self.registry.rescan()?;
        let manifest = self
            .registry
            .manifest(ext_id)
            .ok_or_else(|| anyhow!("unknown extension {ext_id:?}"))?;
        let node_idxs: Vec<usize> = self
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.ext_id == ext_id)
            .map(|(i, _)| i)
            .collect();
        let mut swapped = 0;
        for node in node_idxs {
            let mut new_module = self.instantiate(ext_id, &manifest)?;
            // Re-apply persistent params to the fresh instance.
            for (i, p) in manifest.params.iter().enumerate() {
                if let Some(v) = self.nodes[node].params.get(&p.id) {
                    new_module.on_param(i as u32, *v);
                }
            }
            match &mut self.state {
                EngineState::Stopped(core) => {
                    let _old = core.graph.swap_module(node, new_module);
                }
                _ => {
                    self.cmd_tx
                        .lock()
                        .unwrap()
                        .push(Command::SwapModule {
                            node,
                            module: new_module,
                        })
                        .map_err(|_| anyhow!("command queue full"))?;
                }
            }
            swapped += 1;
        }
        Ok(swapped)
    }

    /// Start the extension folder watcher (polling). On dsp.wasm mtime
    /// change, the changed extension is hot reloaded into the running graph.
    ///
    /// Returns immediately; the watcher runs until `stop_watcher` /
    /// engine drop. The closure-based design keeps `Engine` single-owner:
    /// the watcher sends reload requests through a channel serviced by
    /// `pump_watcher`, or reloads directly when `Engine` is shared.
    pub fn start_watcher(&mut self, poll_interval: Duration) -> Result<WatcherHandle> {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let paths: Vec<(String, PathBuf)> = self
            .registry
            .extensions
            .values()
            .map(|e| (e.manifest.id.clone(), e.dsp_path.clone()))
            .collect();
        let watch_state = self.watch_state.clone();
        {
            let mut ws = watch_state.lock().unwrap();
            for (id, p) in &paths {
                if let Ok(meta) = std::fs::metadata(p) {
                    if let Ok(mtime) = meta.modified() {
                        ws.insert(id.clone(), mtime);
                    }
                }
            }
        }
        let join = std::thread::Builder::new()
            .name("dj-ext-watcher".into())
            .spawn(move || {
                while !stop2.load(Ordering::Relaxed) {
                    std::thread::sleep(poll_interval);
                    for (id, p) in &paths {
                        if let Ok(meta) = std::fs::metadata(p) {
                            if let Ok(mtime) = meta.modified() {
                                let mut ws = watch_state.lock().unwrap();
                                let changed = ws.get(id).map(|t| *t != mtime).unwrap_or(true);
                                if changed {
                                    ws.insert(id.clone(), mtime);
                                    drop(ws);
                                    let _ = tx.send(id.clone());
                                }
                            }
                        }
                    }
                }
            })?;
        self.watcher_stop = Some(stop.clone());
        self.watcher_join = Some(join);
        Ok(WatcherHandle { rx, stop })
    }

    /// Service pending watcher notifications: hot-reload each changed
    /// extension. Call this from the control loop.
    pub fn pump_watcher(&mut self, handle: &WatcherHandle) -> Result<usize> {
        let mut total = 0;
        while let Ok(ext_id) = handle.rx.try_recv() {
            total += self.reload_extension(&ext_id)?;
        }
        Ok(total)
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if let Some(stop) = &self.watcher_stop {
            stop.store(true, Ordering::Relaxed);
        }
        if let Some(join) = self.watcher_join.take() {
            let _ = join.join();
        }
        let _ = self.stop();
    }
}

pub struct WatcherHandle {
    rx: std::sync::mpsc::Receiver<String>,
    pub stop: Arc<AtomicBool>,
}
