//! Engine control layer: node bookkeeping, RT command queue, backends,
//! offline rendering, MIDI control (virtual injection + learn), hot reload.

use anyhow::{anyhow, Result};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::builtin::{
    AudioOutModule, BuiltinKind, MidiEvent, MidiMapKind, MidiModule, MidiOutEvent, MidiOutSink,
    MidiShared,
};
use crate::deck::{DeckCmd, DeckControl, DeckModule, DeckStatus, N_CUES};
use crate::gesture::{GestureEvent, GestureMappingInfo, GestureRtModule};
use crate::graph::{Graph, GraphNode, WireSpec};
use crate::knob::{position_for_value, JackRt, KnobConfig, KnobState};
use crate::macros::{MacroDef, MacroInstance, MacroInterface, MacroLibrary};
use crate::manifest::Manifest;
use crate::mixer::CrossfaderModule;
use crate::module_host::HostModule;
use crate::playback::{decode_file, PlaybackModule, TrackData};
use crate::registry::ExtensionRegistry;
use crate::telemetry::{JackAnalyzer, JackSlot, JackTelemetry};
use crate::wasm_host::WasmRuntime;

// Facade modules: additional `impl Engine` blocks grouped by feature area.
// This file keeps construction, graph editing, knobs and telemetry.
mod deck_api;
mod gesture_api;
mod hot_reload;
mod lifecycle;
mod macros_api;
mod midi;

pub const DEFAULT_SAMPLE_RATE: f32 = 48_000.0;
pub const DEFAULT_BLOCK_SIZE: usize = 128;

/// Audio backend driving the RT thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Wall-clock-paced silent backend (tests, headless, cpal fallback).
    Null,
    /// Real audio output via cpal.
    #[cfg(feature = "cpal-backend")]
    Cpal,
}

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
    pub kind: MidiMapKind,
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
    /// LED feedback mappings (input jacks -> note/CC out; PRD §7.1).
    pub midi_led_mappings: Vec<MidiMappingInfo>,
    /// Control-side gesture pipeline core for a Gesture node (PRD §7.3).
    pub gesture: Option<dj_gesture::GestureProcessor>,
    /// Path of the track loaded into a Playback/Deck node (persisted in the
    /// patch).
    pub track_path: Option<String>,
}

impl NodeInfo {
    /// Which built-in this node is, if it isn't an extension module.
    pub fn builtin_kind(&self) -> Option<crate::builtin::BuiltinKind> {
        crate::builtin::BuiltinKind::from_ext_id(&self.ext_id)
    }

    pub fn is_midi(&self) -> bool {
        self.builtin_kind() == Some(crate::builtin::BuiltinKind::Midi)
    }

    pub fn is_deck(&self) -> bool {
        self.builtin_kind() == Some(crate::builtin::BuiltinKind::Deck)
    }
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
    native: crate::native_host::NativeRuntime,
    state: EngineState,
    pub nodes: Vec<NodeInfo>,
    node_by_id: HashMap<String, usize>,
    /// Control-side copy of the wire list (graph itself may be on the RT thread).
    wires: Vec<WireSpec>,
    cmd_tx: Arc<Mutex<rtrb::Producer<Command>>>,
    garbage_rx: rtrb::Consumer<Box<dyn HostModule>>,
    midi_producers: HashMap<usize, rtrb::Producer<MidiEvent>>,
    /// Gesture value events toward the RT thread, per gesture node.
    gesture_producers: HashMap<usize, rtrb::Producer<GestureEvent>>,
    /// LED feedback messages coming back from the RT thread, per MIDI node.
    midi_out_consumers: HashMap<usize, rtrb::Consumer<MidiOutEvent>>,
    /// Registered macro definitions (engine-side view of the library store).
    pub macros: MacroLibrary,
    /// Expanded macro instances, keyed by instance id (nested instances use
    /// the `/`-prefixed id of their position in the tree).
    macro_instances: BTreeMap<String, MacroInstance>,
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
/// Pending gesture value events per Gesture node. Sized for offline
/// renders that pre-inject whole recorded fixtures (like MIDI's ring);
/// live feeds drain it every block.
const GESTURE_QUEUE_CAP: usize = 4096;
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
            native: crate::native_host::NativeRuntime::new(),
            state: EngineState::Stopped(Box::new(core)),
            nodes: Vec::new(),
            node_by_id: HashMap::new(),
            wires: Vec::new(),
            cmd_tx: Arc::new(Mutex::new(cmd_tx)),
            garbage_rx,
            midi_producers: HashMap::new(),
            gesture_producers: HashMap::new(),
            midi_out_consumers: HashMap::new(),
            macros: MacroLibrary::default(),
            macro_instances: BTreeMap::new(),
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

    /// The currently running backend, if any.
    pub fn backend(&self) -> Option<Backend> {
        match self.state {
            EngineState::Running { .. } => Some(Backend::Null),
            #[cfg(feature = "cpal-backend")]
            EngineState::RunningCpal { .. } => Some(Backend::Cpal),
            _ => None,
        }
    }

    /// Start the given backend (used to restore the pre-edit backend after
    /// a stop/mutate/restart cycle).
    pub fn start_backend(&mut self, backend: Backend) -> Result<()> {
        match backend {
            Backend::Null => self.start_null_realtime(),
            #[cfg(feature = "cpal-backend")]
            Backend::Cpal => self.start_cpal(),
        }
    }

    fn node_idx(&self, instance_id: &str) -> Result<usize> {
        self.node_by_id
            .get(instance_id)
            .copied()
            .ok_or_else(|| anyhow!("no node {instance_id:?}"))
    }

    fn jack_index(&self, node: usize, jack_id: &str) -> Result<usize> {
        let info = &self.nodes[node];
        // MIDI nodes expose named LED-feedback jacks.
        if info.is_midi() {
            if let Some(m) = info.midi_led_mappings.iter().find(|m| m.name == jack_id) {
                return Ok(m.jack);
            }
        }
        info.manifest
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

    /// Resolve an (instance, input jack) pair through macro instances to a
    /// concrete engine node: external jacks of a macro instance map to the
    /// promoted internal jack (nesting already flattened at expansion).
    fn resolve_in_jack(&self, id: &str, jack: &str) -> Result<(String, String)> {
        if let Some(mi) = self.macro_instances.get(id) {
            let (_, node, j) = mi
                .inputs
                .iter()
                .find(|(e, _, _)| e == jack)
                .ok_or_else(|| anyhow!("no input jack {jack:?} on macro instance {id:?}"))?;
            return Ok((node.clone(), j.clone()));
        }
        Ok((id.to_string(), jack.to_string()))
    }

    fn resolve_out_jack(&self, id: &str, jack: &str) -> Result<(String, String)> {
        if let Some(mi) = self.macro_instances.get(id) {
            let (_, node, j) = mi
                .outputs
                .iter()
                .find(|(e, _, _)| e == jack)
                .ok_or_else(|| anyhow!("no output jack {jack:?} on macro instance {id:?}"))?;
            return Ok((node.clone(), j.clone()));
        }
        Ok((id.to_string(), jack.to_string()))
    }

    /// (node index, jack index) for an input jack, resolving macro
    /// instance externals.
    fn in_jack_indices(&self, instance_id: &str, jack_id: &str) -> Result<(usize, usize)> {
        let (rid, rjack) = self.resolve_in_jack(instance_id, jack_id)?;
        let node = self.node_idx(&rid)?;
        let jack = self.jack_index(node, &rjack)?;
        Ok((node, jack))
    }

    fn out_jack_index(&self, node: usize, jack_id: &str) -> Result<usize> {
        let info = &self.nodes[node];
        // MIDI nodes expose named mapping jacks.
        if info.is_midi() {
            if let Some(m) = info.midi_mappings.iter().find(|m| m.name == jack_id) {
                return Ok(m.jack);
            }
        }
        // Gesture nodes likewise (PRD §7.3: every mapping is a jack).
        if let Some(g) = &info.gesture {
            if let Some((jack, _)) = g.mappings().iter().find(|(_, d)| d.name == jack_id) {
                return Ok(*jack);
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
        match BuiltinKind::from_ext_id(ext_id) {
            Some(BuiltinKind::AudioOut) => Ok(Box::new(AudioOutModule { channel_offset: 0 })),
            Some(BuiltinKind::Crossfader) => Ok(Box::new(CrossfaderModule)),
            Some(
                BuiltinKind::Midi
                | BuiltinKind::Gesture
                | BuiltinKind::Playback
                | BuiltinKind::Deck,
            ) => Err(anyhow!("{ext_id} modules are created via add_module")),
            None => {
                let ext = self
                    .registry
                    .extension(ext_id)
                    .ok_or_else(|| anyhow!("unknown extension {ext_id:?}"))?;
                if ext.manifest.abi == "native-1" {
                    // Native escape hatch: unsandboxed, trusted code (see
                    // native_host.rs for the trust model).
                    let host = self.native.instantiate(
                        &ext.dsp_path,
                        self.config.sample_rate,
                        self.config.block_size,
                        manifest.inputs.len(),
                        manifest.outputs.len(),
                    )?;
                    return Ok(Box::new(host));
                }
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

    /// Add a module instance. Only valid while stopped. If `ext_id` names a
    /// registered macro, its subgraph is expanded (PRD §6).
    pub fn add_module(&mut self, instance_id: &str, ext_id: &str) -> Result<()> {
        anyhow::ensure!(
            !instance_id.contains('/'),
            "instance ids may not contain '/' (reserved for macro internals)"
        );
        if self.macros.get(ext_id).is_some() {
            return self.instantiate_macro(instance_id, ext_id);
        }
        self.add_plain_module(instance_id, ext_id)
    }

    /// Add a non-macro module instance.
    fn add_plain_module(&mut self, instance_id: &str, ext_id: &str) -> Result<()> {
        anyhow::ensure!(
            !self.node_by_id.contains_key(instance_id),
            "duplicate instance id {instance_id:?}"
        );
        anyhow::ensure!(
            !self.macro_instances.contains_key(instance_id),
            "duplicate instance id {instance_id:?}"
        );
        let manifest = self
            .registry
            .manifest(ext_id)
            .ok_or_else(|| anyhow!("unknown extension {ext_id:?}"))?;

        let mut midi_shared = None;
        let mut gesture = None;
        let module: Box<dyn HostModule> = match BuiltinKind::from_ext_id(ext_id) {
            Some(BuiltinKind::Midi) => {
                let (tx, rx) = rtrb::RingBuffer::new(4096);
                let (out_tx, out_rx) = rtrb::RingBuffer::new(4096);
                let shared = Arc::new(MidiShared::default());
                midi_shared = Some(shared.clone());
                self.midi_producers.insert(self.nodes.len(), tx);
                self.midi_out_consumers.insert(self.nodes.len(), out_rx);
                Box::new(MidiModule::new(rx, shared, out_tx))
            }
            Some(BuiltinKind::Gesture) => {
                let (tx, rx) = rtrb::RingBuffer::new(GESTURE_QUEUE_CAP);
                self.gesture_producers.insert(self.nodes.len(), tx);
                gesture = Some(dj_gesture::GestureProcessor::default());
                Box::new(GestureRtModule::new(rx))
            }
            Some(BuiltinKind::Playback) => {
                let (tx, rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                self.playback_producers.insert(self.nodes.len(), tx);
                self.playback_garbage.insert(self.nodes.len(), garbage_rx);
                Box::new(PlaybackModule::new(rx, garbage_tx, self.config.sample_rate))
            }
            Some(BuiltinKind::Deck) => {
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
            }
            _ => self.instantiate(ext_id, &manifest)?,
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
            midi_led_mappings: Vec::new(),
            gesture,
            track_path: None,
        };

        let node = GraphNode {
            module,
            n_in: manifest.inputs.len(),
            n_out: manifest.outputs.len(),
            audio_out: BuiltinKind::from_ext_id(ext_id) == Some(BuiltinKind::AudioOut),
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
        let (from_id, from_jack) = self.resolve_out_jack(from_id, from_jack)?;
        let (to_id, to_jack) = self.resolve_in_jack(to_id, to_jack)?;
        let from_node = self.node_idx(&from_id)?;
        let to_node = self.node_idx(&to_id)?;
        let from_jack = self.out_jack_index(from_node, &from_jack)?;
        let to_jack = self.jack_index(to_node, &to_jack)?;
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
        let (from_id, from_jack) = self.resolve_out_jack(from_id, from_jack)?;
        let (to_id, to_jack) = self.resolve_in_jack(to_id, to_jack)?;
        let from_node = self.node_idx(&from_id)?;
        let to_node = self.node_idx(&to_id)?;
        let from_jack = self.out_jack_index(from_node, &from_jack)?;
        let to_jack = self.jack_index(to_node, &to_jack)?;
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
        if info.is_midi() {
            if let Some(m) = info.midi_mappings.iter().find(|m| m.jack == jack) {
                return m.name.clone();
            }
        }
        if let Some(g) = &info.gesture {
            if let Some((_, d)) = g.mappings().iter().find(|(j, _)| *j == jack) {
                return d.name.clone();
            }
        }
        info.manifest.outputs[jack].id.clone()
    }

    /// Resolve an input jack index to its persistent name (LED mapping
    /// names on MIDI nodes, manifest ids elsewhere).
    pub fn input_jack_name(&self, node: usize, jack: usize) -> String {
        let info = &self.nodes[node];
        if info.is_midi() {
            if let Some(m) = info.midi_led_mappings.iter().find(|m| m.jack == jack) {
                return m.name.clone();
            }
        }
        info.manifest.inputs[jack].id.clone()
    }

    /// Restore a full knob state (used by patch load).
    pub fn restore_knob(
        &mut self,
        instance_id: &str,
        jack_id: &str,
        state: KnobState,
    ) -> Result<()> {
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        self.nodes[node].knobs[jack] = state;
        self.push_knob_rt(node, jack)
    }

    pub fn set_param(&mut self, instance_id: &str, param_id: &str, value: f32) -> Result<()> {
        let (instance_id, param_id) = self.resolve_param(instance_id, param_id)?;
        let (instance_id, param_id) = (instance_id.as_str(), param_id.as_str());
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
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        self.nodes[node].knobs[jack].position = position.clamp(0.0, 1.0);
        self.push_knob_rt(node, jack)
    }

    /// Set an unwired input's knob by mapped signal value (inverse of the
    /// knob's config mapping) — convenience for tests and APIs that think
    /// in engineering units (seconds, waveform index, …).
    pub fn set_knob_value(&mut self, instance_id: &str, jack_id: &str, value: f32) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let jack = self.jack_index(node, jack_id)?;
        let cfg = self.nodes[node].knobs[jack]
            .config
            .clone()
            .or_else(|| self.nodes[node].manifest.inputs[jack].knob.clone())
            .unwrap_or_default();
        self.nodes[node].knobs[jack].position = position_for_value(&cfg, value);
        self.push_knob_rt(node, jack)
    }

    pub fn set_knob_atten_offset(
        &mut self,
        instance_id: &str,
        jack_id: &str,
        atten: f32,
        offset: f32,
    ) -> Result<()> {
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
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
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        self.nodes[node].knobs[jack].config = config;
        self.push_knob_rt(node, jack)
    }

    pub fn knob_state(&self, instance_id: &str, jack_id: &str) -> Result<KnobState> {
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        Ok(self.nodes[node].knobs[jack].clone())
    }

    /// Read a jack's live telemetry (`graph.tap`) — instantaneous value,
    /// 100 ms RMS, fast flag, and the value the UI should display.
    pub fn tap(&self, instance_id: &str, jack_id: &str) -> Result<JackTelemetry> {
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        Ok(self.nodes[node].telemetry[jack].read())
    }

    /// Telemetry for a master output channel.
    pub fn tap_master(&self, channel: usize) -> Result<JackTelemetry> {
        self.master_slots
            .get(channel)
            .map(|s| s.read())
            .ok_or_else(|| anyhow!("no master channel {channel}"))
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

/// LED feedback sink backed by a hardware MIDI output port.
#[cfg(feature = "midi-hw")]
pub struct HardwareMidiSink {
    conn: midir::MidiOutputConnection,
}

#[cfg(feature = "midi-hw")]
impl MidiOutSink for HardwareMidiSink {
    fn send(&mut self, event: MidiOutEvent) {
        let _ = self.conn.send(&event.data);
    }
}
