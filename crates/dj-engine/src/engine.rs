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
use crate::deck::{DeckCmd, DeckControl, DeckModule, DeckStatus, N_CUES};
use crate::graph::{Graph, GraphNode, WireSpec};
use crate::knob::{position_for_value, JackRt, KnobConfig, KnobState};
use crate::manifest::Manifest;
use crate::mixer::CrossfaderModule;
use crate::module_host::HostModule;
use crate::playback::{decode_file, PlaybackModule, TrackData, PLAYBACK_ID};
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
    /// Path of the track loaded into a Playback/Deck node (persisted in the
    /// patch).
    pub track_path: Option<String>,
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
    // The cpal stream itself lives on a dedicated thread (see
    // `start_cpal`): cpal::Stream is !Send on CoreAudio, so storing it
    // here would make Engine !Send on macOS.
    #[cfg(feature = "cpal-backend")]
    RunningCpal {
        stop: Arc<AtomicBool>,
        join: std::thread::JoinHandle<()>,
        /// The engine core, shared with the audio callback (which try_locks
        /// it per callback — uncontended except at stop). Lets stop() hand
        /// the graph back, like the null backend.
        slot: Arc<Mutex<Option<Box<EngineCore>>>>,
    },
    Empty,
}

/// Engine must stay Send: the Tauri shell keeps it in shared state and its
/// commands run on arbitrary threads.
const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<Engine>();
};

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
    playback_producers: HashMap<usize, rtrb::Producer<Arc<TrackData>>>,
    /// Replaced tracks come back from the RT thread for off-RT drop.
    playback_garbage: HashMap<usize, rtrb::Consumer<Arc<TrackData>>>,
    /// Control-side state per DJ Deck node (M2).
    decks: HashMap<usize, DeckControl>,
    xruns: Arc<AtomicU64>,
    /// Blocks whose *processing* alone exceeded the block period — the
    /// engine itself was the bottleneck (as opposed to `xruns`, which on the
    /// null backend also counts pacer wakeups the OS scheduler delivered
    /// late; see `start_null_realtime`).
    proc_misses: Arc<AtomicU64>,
    /// Worst per-block processing time observed (nanoseconds).
    max_proc_nanos: Arc<AtomicU64>,
    blocks: Arc<AtomicU64>,
    master_slots: Vec<Arc<JackSlot>>,
    /// dsp.wasm mtimes for the polling hot-reload watcher.
    watch_state: Arc<Mutex<HashMap<String, std::time::SystemTime>>>,
    watcher_stop: Option<Arc<AtomicBool>>,
    watcher_join: Option<std::thread::JoinHandle<()>>,
}

const CMD_QUEUE_CAP: usize = 1024;
/// Pending track loads per Playback node (drained at the next block).
const PLAYBACK_QUEUE_CAP: usize = 64;
/// Pending control commands per Deck node (drained at the next block).
const DECK_QUEUE_CAP: usize = 256;

/// CPU time consumed by the calling thread, in nanoseconds. Unlike wall
/// time this excludes preemption, so per-block cost measured with it is
/// attributable to the engine even on a loaded host. No allocation/locks.
#[cfg(unix)]
fn thread_cpu_nanos() -> u64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: ts is a valid, writable timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

#[cfg(not(unix))]
fn thread_cpu_nanos() -> u64 {
    // Fallback: wall time (includes preemption; coarser attribution).
    use std::sync::OnceLock;
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

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
            playback_producers: HashMap::new(),
            playback_garbage: HashMap::new(),
            decks: HashMap::new(),
            xruns: Arc::new(AtomicU64::new(0)),
            proc_misses: Arc::new(AtomicU64::new(0)),
            max_proc_nanos: Arc::new(AtomicU64::new(0)),
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

    /// Name of the currently running backend, if any.
    pub fn backend_name(&self) -> Option<&'static str> {
        match self.state {
            EngineState::Running { .. } => Some("null"),
            #[cfg(feature = "cpal-backend")]
            EngineState::RunningCpal { .. } => Some("cpal"),
            _ => None,
        }
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
            crate::mixer::CROSSFADER_ID => Ok(Box::new(CrossfaderModule)),
            MIDI_ID | PLAYBACK_ID | crate::deck::DECK_ID => {
                Err(anyhow!("{ext_id} modules are created via add_module"))
            }
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
        } else if ext_id == PLAYBACK_ID {
            let (tx, rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
            let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
            self.playback_producers.insert(self.nodes.len(), tx);
            self.playback_garbage.insert(self.nodes.len(), garbage_rx);
            Box::new(PlaybackModule::new(rx, garbage_tx, self.config.sample_rate))
        } else if ext_id == crate::deck::DECK_ID {
            let (tx, rx) = rtrb::RingBuffer::new(DECK_QUEUE_CAP);
            let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(DECK_QUEUE_CAP);
            let shared = Arc::new(crate::deck::DeckShared::default());
            self.decks.insert(
                self.nodes.len(),
                DeckControl::new(tx, garbage_rx, shared.clone()),
            );
            Box::new(DeckModule::new(
                rx,
                garbage_tx,
                shared,
                self.config.sample_rate,
            ))
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
            track_path: None,
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

    pub fn disconnect(
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
        anyhow::ensure!(self.wires.contains(&spec), "no such wire");
        self.core_mut()?.graph.remove_wire(spec);
        self.wires.retain(|w| *w != spec);
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

    /// Remove a named MIDI mapping, dropping any wires sourced from its jack.
    /// Wire removal is a structural edit, so the engine must be stopped when
    /// the mapping is still wired.
    pub fn remove_midi_mapping(&mut self, instance_id: &str, name: &str) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let pos = self.nodes[node]
            .midi_mappings
            .iter()
            .position(|m| m.name == name)
            .ok_or_else(|| anyhow!("no MIDI mapping {name:?} on {instance_id:?}"))?;
        let jack = self.nodes[node].midi_mappings[pos].jack;
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
        self.nodes[node].midi_mappings.remove(pos);
        if let Some(shared) = self.nodes[node].midi_shared.as_ref() {
            shared.remove_mapping(jack);
        }
        Ok(())
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
        let Some(track) = self.decks[&node].track.as_ref() else {
            return Ok(Vec::new());
        };
        let frames = track.frames();
        if frames == 0 || buckets == 0 {
            return Ok(Vec::new());
        }
        let buckets = buckets.min(frames);
        let mut out = vec![0.0f32; buckets];
        let per = frames as f64 / buckets as f64;
        for (b, peak) in out.iter_mut().enumerate() {
            let start = (b as f64 * per) as usize;
            let end = (((b + 1) as f64 * per) as usize).min(frames);
            let mut p = 0.0f32;
            for i in start..end {
                let mut s = track.channels[0][i].abs();
                if track.channels.len() > 1 {
                    s = s.max(track.channels[1][i].abs());
                }
                p = p.max(s);
            }
            *peak = p;
        }
        Ok(out)
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
