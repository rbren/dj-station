//! Engine control layer: node bookkeeping, RT command queue, backends,
//! offline rendering, MIDI control (virtual injection + learn), hot reload.

use anyhow::{anyhow, Result};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::audio::{AudioControl, AudioModule, AudioShared};
use crate::beat_clip::{BeatClipControl, BeatClipModule, BeatClipRef, BeatClipShared};
use crate::builtin::{
    AudioOutModule, BuiltinKind, MidiEvent, MidiMapKind, MidiModule, MidiOutEvent, MidiOutSink,
    MidiShared,
};
use crate::capture::{CaptureRing, CaptureWindow};
use crate::deck::{DeckCmd, DeckControl, DeckModule, DeckStatus, N_CUES};
use crate::decks::{DecksControl, DecksRtModule, DecksShared};
use crate::graph::{
    compute_plan, Graph, GraphEdit, GraphNode, GrowStorage, NodeStorage, Plan, WireSpec,
};
use crate::knob::{position_for_value, JackRt, KnobConfig, KnobState};
use crate::macros::{MacroDef, MacroInstance, MacroInterface, MacroLibrary, MacroPreviewNode};
use crate::manifest::Manifest;
use crate::mixer::CrossfaderModule;
use crate::module_host::HostModule;
use crate::playback::{decode_file, PlaybackModule, TrackData};
use crate::registry::ExtensionRegistry;
use crate::telemetry::{JackAnalyzer, JackSlot, JackTelemetry};
use crate::wasm_host::WasmRuntime;

// Facade modules: additional `impl Engine` blocks grouped by feature area.
// This file keeps construction, graph editing, knobs and telemetry.
mod audio_api;
mod beat_clip_api;
mod choreo_api;
mod clock_api;
mod deck_api;
mod decks_api;
mod grid_api;
mod hands_api;
mod hot_reload;
mod launch_control_api;
mod lifecycle;
pub use lifecycle::{audio_output_devices, AudioDeviceStatus, AudioOutputs};
mod macros_api;
mod math_api;
mod midi;
mod qwerty_api;
mod rename;
mod track_io_api;

pub use rename::normalize_module_name;

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

/// Which PAGE of the app the engine is playing for. One page sounds at a
/// time: what you are looking at is what you hear, and switching pages
/// fades the other one out rather than leaving it playing in a room
/// nobody is in.
///
/// The engine never stops for this — a hidden page keeps running, so its
/// clock keeps time, its meters keep moving and coming back to it is
/// instant. Only the last step, a wire entering an Audio or Monitor
/// Output module, is held ([`crate::graph::Plan`]'s focus gates).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFocus {
    /// The Rack: the whole patch sounds, decks bank included. The default,
    /// and what every offline render and test gets.
    #[default]
    Rack,
    /// The Decks page: only what a decks bank feeds reaches the outputs.
    Decks,
    /// A page that makes its own sound (Clip) or none at all (Library):
    /// the engine holds its tongue.
    Silent,
}

/// Which of the app's two rack WORKSPACES a module lives in. The Rack tab
/// and the Decks tab are two different racks sharing one engine: every
/// module belongs to exactly one, each tab shows and edits only its own,
/// and each saves to its own patch. The tag is control-side passthrough
/// (like [`NodeInfo::position`]) except that audio focus reads it: the
/// page you are looking at plays ITS workspace ([`Engine::focus_gates`]).
///
/// Default is Rack, everywhere — tests, offline renders and pre-workspace
/// patches never see the field, so nothing about them changes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Workspace {
    #[default]
    Rack,
    Decks,
}

impl Workspace {
    /// serde skip helper: only Decks tags are ever written.
    pub fn is_rack(&self) -> bool {
        *self == Workspace::Rack
    }
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
    SetBypass {
        node: usize,
        on: bool,
    },
    SwapModule {
        node: usize,
        module: Box<dyn HostModule>,
    },
    /// Structural graph edit (module add/remove, wire changes), fully
    /// pre-allocated on the control thread. Applied at a block boundary —
    /// audio never stops — and the same box travels back over the garbage
    /// ring carrying the replaced allocations.
    Edit(Box<GraphEdit>),
}

/// Replaced state shipped from the RT thread back to the control thread
/// for dropping (module hot-swap and structural edits).
pub enum RtGarbage {
    Module(Box<dyn HostModule>),
    Edit(Box<GraphEdit>),
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
    /// User-facing name as typed (caps/spaces preserved). `None` means the
    /// module was never renamed (or was renamed to exactly its normalized
    /// form) and displays as its instance id. Invariant when set:
    /// `normalize_module_name(display_name) == instance_id`.
    pub display_name: Option<String>,
    pub ext_id: String,
    pub manifest: Manifest,
    pub knobs: Vec<KnobState>,
    pub params: BTreeMap<String, f32>,
    pub telemetry: Vec<Arc<JackSlot>>,
    /// Output-jack telemetry, one slot per manifest output.
    pub out_telemetry: Vec<Arc<JackSlot>>,
    /// Raw sample rings, one per manifest input, `Some` only for jacks the
    /// manifest marks `capture` (the Scope's `in`; see `capture.rs`).
    pub capture: Vec<Option<Arc<CaptureRing>>>,
    pub midi_shared: Option<Arc<MidiShared>>,
    pub midi_mappings: Vec<MidiMappingInfo>,
    /// LED feedback mappings (input jacks -> note/CC out; PRD §7.1).
    pub midi_led_mappings: Vec<MidiMappingInfo>,
    /// Canonical timeline state for a Choreography node (persisted in the
    /// patch; the RT side plays a compiled copy).
    pub choreo: Option<crate::choreo::ChoreoState>,
    /// The expression a Math node evaluates, exactly as typed (persisted
    /// in the patch; the RT side runs a compiled copy).
    pub math: Option<crate::math::MathState>,
    /// Path of the track loaded into a Playback/Deck node (persisted in the
    /// patch).
    pub track_path: Option<String>,
    /// Which saved beat clip a Beat Clip node plays (persisted in the
    /// patch; the audio itself is re-loaded by the app layer after a load,
    /// the way deck metadata is re-applied).
    pub clip: Option<BeatClipRef>,
    /// Whether the module is bypassed: its declared bypass routes copy
    /// input to output and its DSP does not run. Persisted in the patch
    /// like any other per-module state; only ever true for a module whose
    /// manifest declares routes.
    pub bypassed: bool,
    /// Rack position (unzoomed rack coordinates) — pure UI passthrough,
    /// control-side only, never touches the RT thread. Persisted in the
    /// patch's `layout` map so undo/redo restores module moves and puts
    /// deleted modules (and macro members) back where they were. `None`
    /// means "never placed via the engine" (the frontend keeps a local
    /// fallback layout).
    pub position: Option<(f32, f32)>,
    /// Which rack workspace (Rack tab or Decks tab) the module lives in.
    /// Control-side; the RT thread sees it only through the focus gates a
    /// plan carries. Macro members carry their instance's tag.
    pub workspace: Workspace,
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

    pub fn is_beat_clip(&self) -> bool {
        self.builtin_kind() == Some(crate::builtin::BuiltinKind::BeatClip)
    }

    /// Whether the module offers a bypass toggle (its manifest declares
    /// in -> out routes).
    pub fn is_bypassable(&self) -> bool {
        self.manifest.is_bypassable()
    }
}

/// Control-side node metadata in STABLE slots, mirroring the graph's slot
/// space one-to-one: `nodes[i]` and the RT graph's slot `i` are the same
/// node, and neither index ever shifts (removal tombstones the slot; the
/// next add reuses it). Indexing a dead slot panics — a stale index is an
/// engine bookkeeping bug. Iteration yields live nodes only.
#[derive(Default)]
pub struct NodeSlots {
    slots: Vec<Option<NodeInfo>>,
}

impl NodeSlots {
    /// Live nodes, in slot order.
    pub fn iter(&self) -> impl Iterator<Item = &NodeInfo> {
        self.slots.iter().flatten()
    }

    /// Live nodes, in slot order, mutably (control-side edits only).
    pub(crate) fn iter_mut(&mut self) -> impl Iterator<Item = &mut NodeInfo> {
        self.slots.iter_mut().flatten()
    }

    /// Live nodes with their slot indices (the indices used by
    /// [`WireSpec`] and the RT graph).
    pub fn iter_slots(&self) -> impl Iterator<Item = (usize, &NodeInfo)> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(i, n)| n.as_ref().map(|n| (i, n)))
    }

    pub fn get(&self, slot: usize) -> Option<&NodeInfo> {
        self.slots.get(slot).and_then(|n| n.as_ref())
    }

    /// True when no live nodes exist.
    pub fn is_empty(&self) -> bool {
        self.iter().next().is_none()
    }

    fn insert(&mut self, slot: usize, info: NodeInfo) {
        if slot >= self.slots.len() {
            self.slots.resize_with(slot + 1, || None);
        }
        debug_assert!(self.slots[slot].is_none(), "slot {slot} already live");
        self.slots[slot] = Some(info);
    }

    fn remove(&mut self, slot: usize) -> NodeInfo {
        self.slots[slot].take().expect("dead node slot")
    }
}

impl std::ops::Index<usize> for NodeSlots {
    type Output = NodeInfo;
    fn index(&self, slot: usize) -> &NodeInfo {
        self.slots[slot].as_ref().expect("dead node slot")
    }
}

impl std::ops::IndexMut<usize> for NodeSlots {
    fn index_mut(&mut self, slot: usize) -> &mut NodeInfo {
        self.slots[slot].as_mut().expect("dead node slot")
    }
}

impl<'a> IntoIterator for &'a NodeSlots {
    type Item = &'a NodeInfo;
    type IntoIter = std::iter::Flatten<std::slice::Iter<'a, Option<NodeInfo>>>;
    fn into_iter(self) -> Self::IntoIter {
        self.slots.iter().flatten()
    }
}

/// RT-side core: graph + queues + counters. Lives on whichever thread the
/// active backend drives.
pub struct EngineCore {
    pub graph: Graph,
    cmd_rx: rtrb::Consumer<Command>,
    garbage_tx: rtrb::Producer<RtGarbage>,
    pub master: Vec<Vec<f32>>,
    /// The cue bus: what the Monitor Output modules mixed, for the
    /// second device the app opens.
    pub monitor: Vec<Vec<f32>>,
    blocks: Arc<AtomicU64>,
    master_analyzers: Vec<crate::telemetry::JackAnalyzer>,
}

impl EngineCore {
    fn apply_commands(&mut self) {
        while let Ok(cmd) = self.cmd_rx.pop() {
            match cmd {
                Command::SetParam { node, index, value } => {
                    self.graph.module_mut(node).on_param(index, value);
                }
                Command::SetKnobRt { node, jack, rt } => {
                    self.graph.set_jack_rt(node, jack, rt);
                }
                Command::SetBypass { node, on } => self.graph.set_bypassed(node, on),
                Command::SwapModule { node, module } => {
                    let old = self.graph.swap_module(node, module);
                    // Ship the old instance back for off-RT drop; if the ring
                    // is full we must drop here (bounded, reload-only path).
                    let _ = self.garbage_tx.push(RtGarbage::Module(old));
                }
                Command::Edit(mut edit) => {
                    // Live structural edit: swap the new state in; the box
                    // comes back out carrying the replaced allocations and
                    // ships back for the control-side drop (if the ring is
                    // full we must drop here — bounded, edit-only path).
                    self.graph.apply_edit(&mut edit);
                    let _ = self.garbage_tx.push(RtGarbage::Edit(edit));
                }
            }
        }
    }

    pub fn process_block(&mut self, frames: usize) {
        self.apply_commands();
        self.graph
            .process_block(frames, &mut self.master, &mut self.monitor);
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
    /// Control-side node metadata, slot-for-slot with the RT graph.
    pub nodes: NodeSlots,
    node_by_id: HashMap<String, usize>,
    /// Control-side copy of the wire list (graph itself may be on the RT thread).
    wires: Vec<WireSpec>,
    /// Mirror of the RT graph's slot-vector length. Grows when an add
    /// can't reuse a recycled slot (the growth ships with the edit).
    graph_slots: usize,
    /// Recycled graph slots, LIFO — the control thread owns slot
    /// allocation so structural edits can be planned without the graph.
    free_slots: Vec<usize>,
    cmd_tx: Arc<Mutex<rtrb::Producer<Command>>>,
    garbage_rx: rtrb::Consumer<RtGarbage>,
    midi_producers: HashMap<usize, rtrb::Producer<MidiEvent>>,
    /// Hands CV events toward the RT thread plus the dedup control state,
    /// per Hands node.
    hands_producers: HashMap<
        usize,
        (
            rtrb::Producer<crate::hands::HandsEvent>,
            crate::hands::HandsControl,
        ),
    >,
    /// Key gate events toward the RT thread, per QWERTY node.
    qwerty_producers: HashMap<usize, rtrb::Producer<crate::qwerty::QwertyEvent>>,
    /// Launch Control XL jack values toward the RT thread plus the decode/
    /// dedup control state, per Launch Control node.
    launch_control_producers: HashMap<
        usize,
        (
            rtrb::Producer<crate::launch_control::LaunchControlEvent>,
            crate::launch_control::LaunchControlControl,
        ),
    >,
    /// Whether a Launch Control XL surface is currently attached. Set by the
    /// app's device watcher (or tests); purely control-side status — module
    /// ownership of the surface is the `active` param.
    launch_control_connected: bool,
    /// Compiled-program handoff + playhead per Choreography node.
    choreos: HashMap<usize, crate::choreo::ChoreoControl>,
    /// Compiled-expression handoff + last compile error per Math node.
    maths: HashMap<usize, crate::math::MathControl>,
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
    /// Control-side state per Audio node (track handoff + decoded track).
    audios: HashMap<usize, AudioControl>,
    /// Control-side state per Beat Clip node (clip handoff + the binding
    /// the loaded audio came from).
    beat_clips: HashMap<usize, BeatClipControl>,
    /// Control-side state per Clock node (tempo lane + transport).
    clocks: HashMap<usize, crate::clock::ClockControl>,
    /// Control-side state per Grid Track node (program + clip handoff).
    grid_tracks: HashMap<usize, crate::grid_track::GridTrackControl>,
    /// Control-side state per Track I/O node (buffer handoff for the
    /// track-rack offline render).
    track_ios: HashMap<usize, crate::track_io::TrackIoControl>,
    /// Control-side state per DJ Deck node (M2).
    decks: HashMap<usize, DeckControl>,
    /// Control-side state per Decks BANK node (the Decks tab's eight clip
    /// slots) — a different module from the DJ deck above.
    clip_decks: HashMap<usize, DecksControl>,
    /// Which PAGE the engine is currently playing for. Ephemeral session
    /// state (which tab is open is not the patch's business), and the
    /// reason a hidden page's audio stops at the output modules.
    audio_focus: AudioFocus,
    /// Which hardware outputs the live and monitor buses play out of.
    /// The machine's business, not the patch's — the app persists it
    /// beside its own settings and hands it back at startup.
    audio_outputs: AudioOutputs,
    /// What the running backend actually reached, published by the cpal
    /// supervisor thread: a device can leave while the app is playing, and
    /// the picker in the chrome has to be able to say so.
    audio_device_status: Arc<Mutex<AudioDeviceStatus>>,
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
    /// Non-fatal problems from the last patch load (`from_doc*`): wires the
    /// saved patch referenced but a newer module manifest no longer supports
    /// were dropped instead of failing the whole load. Surface these to the
    /// user; an empty vec means the patch loaded exactly as saved.
    pub load_warnings: Vec<String>,
}

const CMD_QUEUE_CAP: usize = 1024;
/// Pending hands CV events per Hands node. Sized for offline renders
/// that pre-inject whole recorded traces (like MIDI's ring); live feeds
/// drain it every block.
const HANDS_QUEUE_CAP: usize = 4096;
/// Pending key events per QWERTY node (same sizing rationale).
const QWERTY_QUEUE_CAP: usize = 4096;
/// Pending control-surface values per Launch Control node (same sizing
/// rationale; one full sweep of the surface is 48 values).
const LAUNCH_CONTROL_QUEUE_CAP: usize = 4096;
/// Pending compiled choreography programs per Choreo node (drained at the
/// next block; edits are UI-rate).
const CHOREO_QUEUE_CAP: usize = 64;
/// Pending compiled expressions per Math node (same rationale as
/// choreography programs: edits are UI-rate).
const MATH_QUEUE_CAP: usize = 64;
/// Pending track loads per Playback node (drained at the next block).
const PLAYBACK_QUEUE_CAP: usize = 64;
/// Pending control commands per Deck node (drained at the next block).
const DECK_QUEUE_CAP: usize = 256;
/// Pending commands per Decks bank node: a surface sweep is 48 values and
/// each one ships a mix plus a timing command.
const DECKS_QUEUE_CAP: usize = 256;

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
            monitor: vec![vec![0.0; config.block_size]; config.master_channels],
            blocks: blocks.clone(),
            master_analyzers,
        };
        Ok(Engine {
            config,
            registry,
            wasm: WasmRuntime::new()?,
            native: crate::native_host::NativeRuntime::new(),
            state: EngineState::Stopped(Box::new(core)),
            nodes: NodeSlots::default(),
            node_by_id: HashMap::new(),
            wires: Vec::new(),
            graph_slots: 0,
            free_slots: Vec::new(),
            cmd_tx: Arc::new(Mutex::new(cmd_tx)),
            garbage_rx,
            midi_producers: HashMap::new(),
            hands_producers: HashMap::new(),
            qwerty_producers: HashMap::new(),
            launch_control_producers: HashMap::new(),
            launch_control_connected: false,
            choreos: HashMap::new(),
            maths: HashMap::new(),
            midi_out_consumers: HashMap::new(),
            macros: MacroLibrary::default(),
            macro_instances: BTreeMap::new(),
            playback_producers: HashMap::new(),
            playback_garbage: HashMap::new(),
            audios: HashMap::new(),
            beat_clips: HashMap::new(),
            clocks: HashMap::new(),
            grid_tracks: HashMap::new(),
            track_ios: HashMap::new(),
            decks: HashMap::new(),
            clip_decks: HashMap::new(),
            audio_focus: AudioFocus::default(),
            audio_outputs: AudioOutputs::default(),
            audio_device_status: Arc::new(Mutex::new(AudioDeviceStatus::default())),
            xruns: Arc::new(AtomicU64::new(0)),
            proc_misses: Arc::new(AtomicU64::new(0)),
            max_proc_nanos: Arc::new(AtomicU64::new(0)),
            blocks,
            master_slots,
            watch_state: Arc::new(Mutex::new(HashMap::new())),
            watcher_stop: None,
            watcher_join: None,
            load_warnings: Vec::new(),
        })
    }

    pub(crate) fn core_mut(&mut self) -> Result<&mut EngineCore> {
        match &mut self.state {
            EngineState::Stopped(core) => Ok(core),
            _ => Err(anyhow!("engine is running; stop it first")),
        }
    }

    /// Input-jack count per graph slot (`None` = tombstone) — the shape
    /// [`compute_plan`] needs, taken from the control-side mirror.
    fn n_inputs_by_slot(&self) -> Vec<Option<usize>> {
        let mut v = vec![None; self.graph_slots];
        for (slot, info) in self.nodes.iter_slots() {
            v[slot] = Some(info.manifest.inputs.len());
        }
        v
    }

    /// The plan for a graph shape, carrying the focus the open page asked
    /// for. EVERY plan goes through here: the gates travel with the plan,
    /// so a wire edit or a module add can never quietly reopen a page the
    /// user is not looking at.
    fn plan_for(&self, n_inputs: &[Option<usize>], wires: &[WireSpec]) -> Plan {
        let mut plan = compute_plan(n_inputs, wires);
        plan.set_focus(self.focus_gates(n_inputs.len(), wires));
        plan
    }

    /// Per-slot focus gate: 1.0 for a node whose signal the open page lets
    /// through to the outputs, 0.0 for one it holds back.
    ///
    /// Each page plays ITS OWN WORKSPACE ([`Workspace`]): the Rack tab the
    /// rack-workspace modules (the default tag, so tests, offline renders
    /// and pre-workspace patches all stay wide open), the Decks tab the
    /// decks-workspace modules. On the Decks page everything DOWNSTREAM OF
    /// A BANK opens too, whatever its tag — a bank is often played through
    /// modules (a compressor on the way out is still the decks you are
    /// looking at), and a pre-workspace session keeps sounding until its
    /// modules are re-tagged.
    ///
    /// Reachability is per NODE, so a rack source that meets the bank
    /// inside a shared module — both into one mixer, mixer into the
    /// output — rides out with it. Cutting that would mean gating every
    /// wire, and a wire carries clocks and CV as readily as audio.
    fn focus_gates(&self, slots: usize, wires: &[WireSpec]) -> Vec<f32> {
        match self.audio_focus {
            AudioFocus::Rack => {
                let mut open = vec![1.0; slots];
                for (slot, info) in self.nodes.iter_slots() {
                    if info.workspace == Workspace::Decks {
                        open[slot] = 0.0;
                    }
                }
                open
            }
            AudioFocus::Silent => vec![0.0; slots],
            AudioFocus::Decks => {
                let mut open = vec![0.0; slots];
                let mut queue: Vec<usize> = self
                    .nodes
                    .iter_slots()
                    .filter(|(_, info)| {
                        info.workspace == Workspace::Decks
                            || BuiltinKind::from_ext_id(&info.ext_id) == Some(BuiltinKind::Decks)
                    })
                    .map(|(slot, _)| slot)
                    .collect();
                for &slot in &queue {
                    open[slot] = 1.0;
                }
                while let Some(node) = queue.pop() {
                    for w in wires.iter().filter(|w| w.from_node == node) {
                        if open[w.to_node] == 0.0 {
                            open[w.to_node] = 1.0;
                            queue.push(w.to_node);
                        }
                    }
                }
                open
            }
        }
    }

    /// Move a top-level module (macro members follow their instance) to a
    /// workspace. Control-side bookkeeping plus one replan: the focus
    /// gates read the tag, so a module changing rooms changes what the
    /// open page plays.
    pub fn set_module_workspace(&mut self, instance_id: &str, workspace: Workspace) -> Result<()> {
        let prefix = format!("{instance_id}/");
        let mut hit = false;
        let mut changed = false;
        for info in self.nodes.iter_mut() {
            if info.instance_id == instance_id || info.instance_id.starts_with(&prefix) {
                hit = true;
                changed |= info.workspace != workspace;
                info.workspace = workspace;
            }
        }
        // A macro instance with zero members cannot exist; a bare miss is
        // a caller bug.
        anyhow::ensure!(hit, "no module named {instance_id:?}");
        if changed {
            let plan = self.plan_for(&self.n_inputs_by_slot(), &self.wires);
            self.dispatch_edit(GraphEdit::Replan { plan })?;
        }
        Ok(())
    }

    /// The workspace of a top-level module (a macro instance answers via
    /// its members — they all carry the same tag).
    pub fn module_workspace(&self, instance_id: &str) -> Result<Workspace> {
        let prefix = format!("{instance_id}/");
        self.nodes
            .iter()
            .find(|n| n.instance_id == instance_id || n.instance_id.starts_with(&prefix))
            .map(|n| n.workspace)
            .ok_or_else(|| anyhow::anyhow!("no module named {instance_id:?}"))
    }

    /// Which page the engine is playing for.
    pub fn audio_focus(&self) -> AudioFocus {
        self.audio_focus
    }

    /// Play for this page. Takes effect at the next block, over one
    /// block's fade — the graph itself is untouched, so nothing about the
    /// patch, the transports or the meters changes with it.
    pub fn set_audio_focus(&mut self, focus: AudioFocus) -> Result<()> {
        if self.audio_focus == focus {
            return Ok(());
        }
        self.audio_focus = focus;
        let plan = self.plan_for(&self.n_inputs_by_slot(), &self.wires);
        self.dispatch_edit(GraphEdit::Replan { plan })
    }

    /// Apply a structural edit: directly when stopped, over the RT command
    /// ring when running (applied at the next block boundary — audio never
    /// stops). The ring is drained every block, so a full ring only means
    /// the RT thread is severely behind; bounded retry, then error.
    fn dispatch_edit(&mut self, mut edit: GraphEdit) -> Result<()> {
        match &mut self.state {
            EngineState::Stopped(core) => {
                core.graph.apply_edit(&mut edit);
                // The replaced allocations inside `edit` drop here, on the
                // control thread.
                Ok(())
            }
            _ => {
                let mut cmd = Command::Edit(Box::new(edit));
                let tx = self.cmd_tx.clone();
                let mut tx = tx.lock().unwrap();
                let deadline = Instant::now() + Duration::from_millis(500);
                loop {
                    match tx.push(cmd) {
                        Ok(()) => return Ok(()),
                        Err(rtrb::PushError::Full(c)) => {
                            anyhow::ensure!(
                                Instant::now() < deadline,
                                "RT command queue full (edit dropped)"
                            );
                            cmd = c;
                            std::thread::sleep(Duration::from_micros(200));
                        }
                    }
                }
            }
        }
    }

    /// Remove every wire matching `pred`: one plan swap on the RT thread,
    /// control mirror updated on success. No-op when nothing matches.
    pub(crate) fn remove_wires_where(&mut self, pred: impl Fn(&WireSpec) -> bool) -> Result<()> {
        let wires: Vec<WireSpec> = self.wires.iter().copied().filter(|w| !pred(w)).collect();
        if wires.len() == self.wires.len() {
            return Ok(());
        }
        let plan = self.plan_for(&self.n_inputs_by_slot(), &wires);
        self.dispatch_edit(GraphEdit::Replan { plan })?;
        self.wires = wires;
        self.sync_decks_routing();
        Ok(())
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

    pub(crate) fn node_idx(&self, instance_id: &str) -> Result<usize> {
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
        info.manifest
            .outputs
            .iter()
            .position(|j| j.id == jack_id)
            .ok_or_else(|| anyhow!("no output jack {jack_id:?} on {}", info.instance_id))
    }

    /// Instantiate a module for a node (initial add or hot reload).
    fn instantiate(&self, ext_id: &str, manifest: &Manifest) -> Result<Box<dyn HostModule>> {
        match BuiltinKind::from_ext_id(ext_id) {
            Some(BuiltinKind::AudioOut) | Some(BuiltinKind::MonitorOut) => {
                Ok(Box::new(AudioOutModule {
                    channel_offset: 0,
                    muted: false,
                }))
            }
            Some(BuiltinKind::Crossfader) => Ok(Box::new(CrossfaderModule)),
            Some(
                BuiltinKind::Midi
                | BuiltinKind::Choreo
                | BuiltinKind::Clock
                | BuiltinKind::GridTrack
                | BuiltinKind::Qwerty
                | BuiltinKind::LaunchControl
                | BuiltinKind::Hands
                | BuiltinKind::Playback
                | BuiltinKind::Audio
                | BuiltinKind::BeatClip
                | BuiltinKind::Decks
                | BuiltinKind::Deck
                | BuiltinKind::Math
                | BuiltinKind::TrackIo,
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

    /// Add a module instance. Works while running (the edit lands at a
    /// block boundary; audio never stops) or stopped. If `ext_id` names a
    /// registered macro, its subgraph is expanded (PRD §6).
    pub fn add_module(&mut self, instance_id: &str, ext_id: &str) -> Result<()> {
        // Opportunistic drop point for state prior live edits shipped back.
        self.drain_garbage();
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

        // Side-table entries are keyed by the graph SLOT, which is only
        // known after add_node (slots are recycled); build now, file later.
        let mut midi_shared = None;
        let mut midi_plumbing = None;
        let mut hands_plumbing = None;
        let mut qwerty_plumbing = None;
        let mut launch_control_plumbing = None;
        let mut choreo_ctl = None;
        let mut clock_ctl = None;
        let mut grid_track_ctl = None;
        let mut math_ctl = None;
        let mut playback_plumbing = None;
        let mut audio_ctl = None;
        let mut beat_clip_ctl = None;
        let mut track_io_ctl = None;
        let mut deck_ctl = None;
        let mut decks_ctl = None;
        let module: Box<dyn HostModule> = match BuiltinKind::from_ext_id(ext_id) {
            Some(BuiltinKind::Midi) => {
                let (tx, rx) = rtrb::RingBuffer::new(4096);
                let (out_tx, out_rx) = rtrb::RingBuffer::new(4096);
                let shared = Arc::new(MidiShared::default());
                midi_shared = Some(shared.clone());
                midi_plumbing = Some((tx, out_rx));
                Box::new(MidiModule::new(rx, shared, out_tx))
            }
            Some(BuiltinKind::Hands) => {
                let (tx, rx) = rtrb::RingBuffer::new(HANDS_QUEUE_CAP);
                hands_plumbing = Some(tx);
                Box::new(crate::hands::HandsRtModule::new(rx, self.current_frame()))
            }
            Some(BuiltinKind::Qwerty) => {
                let (tx, rx) = rtrb::RingBuffer::new(QWERTY_QUEUE_CAP);
                qwerty_plumbing = Some(tx);
                Box::new(crate::qwerty::QwertyRtModule::new(rx, self.current_frame()))
            }
            Some(BuiltinKind::LaunchControl) => {
                let (tx, rx) = rtrb::RingBuffer::new(LAUNCH_CONTROL_QUEUE_CAP);
                launch_control_plumbing = Some(tx);
                Box::new(crate::launch_control::LaunchControlRtModule::new(
                    rx,
                    self.current_frame(),
                ))
            }
            Some(BuiltinKind::Choreo) => {
                let (tx, rx) = rtrb::RingBuffer::new(CHOREO_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(CHOREO_QUEUE_CAP);
                let shared = Arc::new(crate::choreo::ChoreoShared::default());
                choreo_ctl = Some(crate::choreo::ChoreoControl::new(
                    tx,
                    garbage_rx,
                    shared.clone(),
                ));
                Box::new(crate::choreo::ChoreoRtModule::new(
                    rx,
                    garbage_tx,
                    shared,
                    self.config.sample_rate,
                ))
            }
            Some(BuiltinKind::Clock) => {
                let (tx, rx) = rtrb::RingBuffer::new(crate::clock::CLOCK_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(crate::clock::CLOCK_QUEUE_CAP);
                let shared = Arc::new(crate::clock::ClockShared::default());
                clock_ctl = Some(crate::clock::ClockControl::new(
                    tx,
                    garbage_rx,
                    shared.clone(),
                ));
                Box::new(crate::clock::ClockRtModule::new(
                    rx,
                    garbage_tx,
                    self.config.sample_rate,
                    shared,
                ))
            }
            Some(BuiltinKind::GridTrack) => {
                let cap = crate::grid_track::GRID_TRACK_QUEUE_CAP;
                let (tx, rx) = rtrb::RingBuffer::new(cap);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(cap);
                let shared = Arc::new(crate::grid_track::GridTrackShared::default());
                grid_track_ctl = Some(crate::grid_track::GridTrackControl::new(
                    tx,
                    garbage_rx,
                    shared.clone(),
                ));
                Box::new(crate::grid_track::GridTrackRtModule::new(
                    rx,
                    garbage_tx,
                    self.config.sample_rate,
                    shared,
                ))
            }
            Some(BuiltinKind::Math) => {
                let (tx, rx) = rtrb::RingBuffer::new(MATH_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(MATH_QUEUE_CAP);
                math_ctl = Some(crate::math::MathControl::new(tx, garbage_rx));
                // A fresh module already computes: its default expression
                // is compiled here and handed over at construction, so the
                // first block is the one the panel shows.
                let program = crate::math::MathState::default()
                    .compile()
                    .ok()
                    .map(std::sync::Arc::new);
                Box::new(crate::math::MathRtModule::new(rx, garbage_tx, program))
            }
            Some(BuiltinKind::Playback) => {
                let (tx, rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                playback_plumbing = Some((tx, garbage_rx));
                Box::new(PlaybackModule::new(rx, garbage_tx, self.config.sample_rate))
            }
            Some(BuiltinKind::Audio) => {
                let (tx, rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                let shared = Arc::new(AudioShared::default());
                audio_ctl = Some(AudioControl {
                    tx,
                    garbage_rx,
                    track: None,
                    shared: shared.clone(),
                });
                Box::new(AudioModule::new(
                    rx,
                    garbage_tx,
                    self.config.sample_rate,
                    shared,
                ))
            }
            Some(BuiltinKind::BeatClip) => {
                let (tx, rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                let shared = Arc::new(BeatClipShared::default());
                beat_clip_ctl = Some(BeatClipControl {
                    tx,
                    garbage_rx,
                    track: None,
                    loaded: None,
                    shared: shared.clone(),
                });
                Box::new(BeatClipModule::new(
                    rx,
                    garbage_tx,
                    self.config.sample_rate,
                    shared,
                ))
            }
            Some(BuiltinKind::TrackIo) => {
                let (tx, rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(PLAYBACK_QUEUE_CAP);
                track_io_ctl = Some(crate::track_io::TrackIoControl::new(tx, garbage_rx));
                Box::new(crate::track_io::TrackIoModule::new(
                    rx,
                    garbage_tx,
                    self.config.sample_rate,
                ))
            }
            Some(BuiltinKind::Decks) => {
                let (tx, rx) = rtrb::RingBuffer::new(DECKS_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(DECKS_QUEUE_CAP);
                let shared = Arc::new(DecksShared::default());
                decks_ctl = Some(DecksControl::new(tx, garbage_rx, shared.clone()));
                Box::new(DecksRtModule::new(
                    rx,
                    garbage_tx,
                    self.config.sample_rate,
                    shared,
                ))
            }
            Some(BuiltinKind::Deck) => {
                let (tx, rx) = rtrb::RingBuffer::new(DECK_QUEUE_CAP);
                let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(DECK_QUEUE_CAP);
                let shared = Arc::new(crate::deck::DeckShared::default());
                deck_ctl = Some(DeckControl::new(tx, garbage_rx, shared.clone()));
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
                ..KnobState::default()
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
        // Jacks a UI DRAWS (the Scope's `in`) also get a raw sample ring.
        let capture: Vec<Option<Arc<CaptureRing>>> = manifest
            .inputs
            .iter()
            .map(|decl| {
                decl.capture
                    .then(|| Arc::new(CaptureRing::new(self.config.sample_rate)))
            })
            .collect();
        let analyzers: Vec<JackAnalyzer> = telemetry
            .iter()
            .zip(&capture)
            .map(|(s, ring)| {
                let a =
                    JackAnalyzer::new(s.clone(), self.config.sample_rate, self.config.block_size);
                match ring {
                    Some(r) => a.with_capture(r.clone()),
                    None => a,
                }
            })
            .collect();
        let out_telemetry: Vec<Arc<JackSlot>> = manifest
            .outputs
            .iter()
            .map(|_| Arc::new(JackSlot::default()))
            .collect();
        let out_analyzers: Vec<JackAnalyzer> = out_telemetry
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
            display_name: None,
            ext_id: ext_id.to_string(),
            manifest: manifest.clone(),
            knobs,
            params: params.clone(),
            telemetry,
            out_telemetry,
            capture,
            midi_shared,
            midi_mappings: Vec::new(),
            midi_led_mappings: Vec::new(),
            choreo: if BuiltinKind::from_ext_id(ext_id) == Some(BuiltinKind::Choreo) {
                Some(crate::choreo::ChoreoState::default())
            } else {
                None
            },
            math: if BuiltinKind::from_ext_id(ext_id) == Some(BuiltinKind::Math) {
                Some(crate::math::MathState::default())
            } else {
                None
            },
            track_path: None,
            clip: None,
            bypassed: false,
            position: None,
            workspace: Workspace::default(),
        };

        // Apply default params before the module ships to the RT thread.
        let mut module = module;
        for (i, p) in manifest.params.iter().enumerate() {
            module.on_param(i as u32, params[&p.id]);
        }
        let n_in = manifest.inputs.len();
        let n_out = manifest.outputs.len();
        let node = GraphNode {
            module,
            n_in,
            n_out,
            audio_out: BuiltinKind::from_ext_id(ext_id) == Some(BuiltinKind::AudioOut),
            monitor_out: BuiltinKind::from_ext_id(ext_id) == Some(BuiltinKind::MonitorOut),
            bypass_routes: manifest.bypass_routes(),
            bypassed: false,
            // A fresh node is audible; the plan shipped with this add
            // carries the gate the open page actually asked for, so one
            // block later it agrees with the rest of its page.
            focus_gain: 1.0,
        };
        // Allocate the graph slot control-side: recycle a tombstone (LIFO,
        // like the old in-graph free list) or grow the storage by one.
        let recycled = !self.free_slots.is_empty();
        let idx = self.free_slots.pop().unwrap_or(self.graph_slots);
        let grow = (!recycled).then(|| Box::new(GrowStorage::with_len(idx + 1)));
        let storage = NodeStorage::for_node(
            n_in,
            n_out,
            self.config.block_size,
            jack_rt,
            analyzers,
            out_analyzers,
        );
        let mut n_inputs = self.n_inputs_by_slot();
        if idx >= n_inputs.len() {
            n_inputs.resize(idx + 1, None);
        }
        n_inputs[idx] = Some(n_in);
        let plan = self.plan_for(&n_inputs, &self.wires);
        if let Err(e) = self.dispatch_edit(GraphEdit::AddNode {
            slot: idx,
            node: Some(node),
            storage,
            grow,
            plan,
        }) {
            if recycled {
                self.free_slots.push(idx);
            }
            return Err(e);
        }
        self.graph_slots = self.graph_slots.max(idx + 1);
        if let Some((tx, out_rx)) = midi_plumbing {
            self.midi_producers.insert(idx, tx);
            self.midi_out_consumers.insert(idx, out_rx);
        }
        if let Some(tx) = hands_plumbing {
            self.hands_producers
                .insert(idx, (tx, crate::hands::HandsControl::default()));
        }
        if let Some(tx) = qwerty_plumbing {
            self.qwerty_producers.insert(idx, tx);
        }
        if let Some(tx) = launch_control_plumbing {
            self.launch_control_producers.insert(
                idx,
                (tx, crate::launch_control::LaunchControlControl::default()),
            );
        }
        if let Some(ctl) = choreo_ctl {
            self.choreos.insert(idx, ctl);
        }
        if let Some(ctl) = math_ctl {
            self.maths.insert(idx, ctl);
        }
        if let Some(ctl) = clock_ctl {
            self.clocks.insert(idx, ctl);
        }
        if let Some(ctl) = grid_track_ctl {
            self.grid_tracks.insert(idx, ctl);
        }
        if let Some((tx, garbage_rx)) = playback_plumbing {
            self.playback_producers.insert(idx, tx);
            self.playback_garbage.insert(idx, garbage_rx);
        }
        if let Some(ctl) = audio_ctl {
            self.audios.insert(idx, ctl);
        }
        if let Some(ctl) = beat_clip_ctl {
            self.beat_clips.insert(idx, ctl);
        }
        if let Some(ctl) = track_io_ctl {
            self.track_ios.insert(idx, ctl);
        }
        if let Some(ctl) = deck_ctl {
            self.decks.insert(idx, ctl);
        }
        if let Some(ctl) = decks_ctl {
            self.clip_decks.insert(idx, ctl);
        }
        self.node_by_id.insert(instance_id.to_string(), idx);
        self.nodes.insert(idx, info);
        if BuiltinKind::from_ext_id(ext_id) == Some(BuiltinKind::LaunchControl) {
            self.launchcontrol_claim_if_unowned(idx);
        }
        Ok(())
    }

    /// Remove a module instance incrementally: its wires, side-table
    /// entries and graph slot go; every OTHER node keeps its module state,
    /// telemetry windows and slot index — nothing else resets. Accepts a
    /// top-level plain module or a macro instance (whose expanded internal
    /// nodes are all removed). Works while running (the edit lands at a
    /// block boundary; audio never stops) or stopped.
    pub fn remove_module(&mut self, instance_id: &str) -> Result<()> {
        // Opportunistic drop point for state prior live edits shipped back.
        self.drain_garbage();
        anyhow::ensure!(
            !instance_id.contains('/'),
            "cannot remove macro-internal node {instance_id:?}"
        );
        if self.macro_instances.contains_key(instance_id) {
            return self.remove_macro_instance(instance_id);
        }
        anyhow::ensure!(
            self.node_by_id.contains_key(instance_id),
            "no such module instance: {instance_id}"
        );
        self.remove_node(instance_id)
    }

    /// Remove one concrete engine node (plain module or macro internal).
    pub(super) fn remove_node(&mut self, instance_id: &str) -> Result<()> {
        // Stopped: drain pending RT commands before the slot can be
        // recycled, so a stale knob/param command can't land on the slot's
        // next occupant. (Running: the command ring is FIFO, so an earlier
        // command always applies before this remove.)
        if let EngineState::Stopped(core) = &mut self.state {
            core.apply_commands();
        }
        let slot = *self
            .node_by_id
            .get(instance_id)
            .ok_or_else(|| anyhow!("no such module instance: {instance_id}"))?;

        // Plan the post-removal graph and ship the edit first — the
        // control mirrors are only updated once it is accepted.
        let mut n_inputs = self.n_inputs_by_slot();
        n_inputs[slot] = None;
        let wires: Vec<WireSpec> = self
            .wires
            .iter()
            .copied()
            .filter(|w| w.from_node != slot && w.to_node != slot)
            .collect();
        let plan = self.plan_for(&n_inputs, &wires);
        self.dispatch_edit(GraphEdit::RemoveNode {
            slot,
            plan,
            module: None,
            storage: NodeStorage::default(),
        })?;
        // While running, the module (which may own wasm stores or track
        // data) comes back over the garbage ring and drops on the control
        // thread at the next drain; while stopped it dropped just now.

        self.wires = wires;
        self.midi_producers.remove(&slot);
        self.midi_out_consumers.remove(&slot);
        self.hands_producers.remove(&slot);
        self.qwerty_producers.remove(&slot);
        self.launch_control_producers.remove(&slot);
        self.choreos.remove(&slot);
        self.clocks.remove(&slot);
        self.grid_tracks.remove(&slot);
        self.maths.remove(&slot);
        self.playback_producers.remove(&slot);
        self.playback_garbage.remove(&slot);
        self.audios.remove(&slot);
        self.beat_clips.remove(&slot);
        self.track_ios.remove(&slot);
        self.decks.remove(&slot);
        self.clip_decks.remove(&slot);
        // Other decks sync-locked to this one lose their master.
        for ctl in self.decks.values_mut() {
            if ctl.sync_to.as_deref() == Some(instance_id) {
                ctl.sync_to = None;
            }
        }
        self.node_by_id.remove(instance_id);
        self.nodes.remove(slot);
        self.free_slots.push(slot);
        Ok(())
    }

    /// Remove a macro instance: all of its expanded internal nodes (and
    /// nested instances) plus the instance record.
    fn remove_macro_instance(&mut self, instance_id: &str) -> Result<()> {
        let prefix = format!("{instance_id}/");
        let internal_nodes: Vec<String> = self
            .node_by_id
            .keys()
            .filter(|id| id.starts_with(&prefix))
            .cloned()
            .collect();
        for id in internal_nodes {
            self.remove_node(&id)?;
        }
        self.macro_instances
            .retain(|id, _| id != instance_id && !id.starts_with(&prefix));
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
        let mut wires = self.wires.clone();
        wires.push(spec);
        let plan = self.plan_for(&self.n_inputs_by_slot(), &wires);
        self.dispatch_edit(GraphEdit::Replan { plan })?;
        self.wires = wires;
        self.sync_decks_routing();
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
        self.remove_wires_where(|w| *w == spec)
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

    /// Rack position of a module node (UI passthrough; see
    /// [`NodeInfo::position`]).
    pub fn module_position(&self, instance_id: &str) -> Option<(f32, f32)> {
        self.nodes
            .iter()
            .find(|n| n.instance_id == instance_id)
            .and_then(|n| n.position)
    }

    /// Set a module node's rack position. Control-side only — the RT
    /// thread is never involved. Positions ride along in patch snapshots
    /// (`PatchDoc::layout`), which is what makes module moves and deletes
    /// undoable with layout intact.
    pub fn set_module_position(&mut self, instance_id: &str, pos: (f32, f32)) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        self.nodes[node].position = Some(pos);
        Ok(())
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
            EngineState::Stopped(core) => core.graph.module_mut(node).on_param(index, value),
            _ => self
                .cmd_tx
                .lock()
                .unwrap()
                .push(Command::SetParam { node, index, value })
                .map_err(|_| anyhow!("command queue full"))?,
        }
        Ok(())
    }

    /// Bypass a module (or take it out of bypass): while bypassed its
    /// declared routes copy input jacks straight to output jacks and its
    /// DSP never runs. Per-module state like a knob — it rides in the
    /// patch and survives a save/load. Rejects modules whose manifest
    /// declares no routes.
    pub fn set_bypass(&mut self, instance_id: &str, on: bool) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.nodes[node].is_bypassable(),
            "{instance_id} cannot be bypassed"
        );
        self.nodes[node].bypassed = on;
        match &mut self.state {
            EngineState::Stopped(core) => core.graph.set_bypassed(node, on),
            _ => self
                .cmd_tx
                .lock()
                .unwrap()
                .push(Command::SetBypass { node, on })
                .map_err(|_| anyhow!("command queue full"))?,
        }
        Ok(())
    }

    /// Whether a module is currently bypassed.
    pub fn is_bypassed(&self, instance_id: &str) -> Result<bool> {
        Ok(self.nodes[self.node_idx(instance_id)?].bypassed)
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
        let link = self.tempo_link(node, jack);
        self.nodes[node].knobs[jack].position = position.clamp(0.0, 1.0);
        self.push_knob_rt(node, jack)?;
        self.apply_tempo_link(link)
    }

    /// Set an unwired input's knob by mapped signal value (inverse of the
    /// knob's config mapping) — convenience for tests and APIs that think
    /// in engineering units (seconds, waveform index, …).
    pub fn set_knob_value(&mut self, instance_id: &str, jack_id: &str, value: f32) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let jack = self.jack_index(node, jack_id)?;
        let link = self.tempo_link(node, jack);
        self.write_knob_value(node, jack, value)?;
        self.apply_tempo_link(link)
    }

    /// The knob config in force for an input: the per-patch override, else
    /// the manifest's declaration.
    pub(crate) fn knob_config(&self, node: usize, jack: usize) -> KnobConfig {
        self.nodes[node].knobs[jack]
            .config
            .clone()
            .or_else(|| self.nodes[node].manifest.inputs[jack].knob.clone())
            .unwrap_or_default()
    }

    /// Value an input's knob currently maps to (what an unwired jack reads).
    pub(crate) fn knob_value(&self, node: usize, jack: usize) -> f32 {
        self.knob_config(node, jack)
            .map(self.nodes[node].knobs[jack].position)
    }

    /// Move a knob to the position that maps to `value`, with no linked-
    /// knob side effects (the mirror in [`Engine::apply_tempo_link`] uses
    /// this to write the partner without recursing).
    pub(crate) fn write_knob_value(&mut self, node: usize, jack: usize, value: f32) -> Result<()> {
        let cfg = self.knob_config(node, jack);
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

    /// Set a wired input's blend mode: CV (signal modulates the knob
    /// baseline) or Override (signal IS the value, knob inert). Per-patch
    /// state; the app also sets it automatically at wire time when both
    /// ends carry a `volt_per_octave` display map (`wire_is_pitch_pair`).
    pub fn set_knob_wire_style(
        &mut self,
        instance_id: &str,
        jack_id: &str,
        style: crate::knob::WireStyle,
    ) -> Result<()> {
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        self.nodes[node].knobs[jack].wire_style = style;
        self.push_knob_rt(node, jack)
    }

    /// True when both ends of a prospective wire carry a `volt_per_octave`
    /// display map — pitch flowing into pitch, the auto-Override case.
    pub fn wire_is_pitch_pair(
        &self,
        from_id: &str,
        from_jack: &str,
        to_id: &str,
        to_jack: &str,
    ) -> Result<bool> {
        use crate::manifest::DisplayMap;
        let is_voct = |d: &Option<crate::manifest::DisplaySpec>| {
            d.as_ref()
                .and_then(|d| d.map.as_ref())
                .is_some_and(|m| matches!(m, DisplayMap::VoltPerOctave { .. }))
        };
        let (from_id, from_jack) = self.resolve_out_jack(from_id, from_jack)?;
        let (to_id, to_jack) = self.resolve_in_jack(to_id, to_jack)?;
        let from_node = self.node_idx(&from_id)?;
        let to_node = self.node_idx(&to_id)?;
        let from_jack = self.out_jack_index(from_node, &from_jack)?;
        let to_jack = self.jack_index(to_node, &to_jack)?;
        Ok(
            is_voct(&self.nodes[from_node].manifest.outputs[from_jack].display)
                && is_voct(&self.nodes[to_node].manifest.inputs[to_jack].display),
        )
    }

    /// Number of wires currently arriving at an input jack.
    pub fn input_wire_count(&self, instance_id: &str, jack_id: &str) -> Result<usize> {
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        Ok(self
            .wires
            .iter()
            .filter(|w| w.to_node == node && w.to_jack == jack)
            .count())
    }

    /// True when a prospective wire STARTS at a control surface — a module
    /// that is a piece of hardware, whose outputs are the positions of real
    /// knobs, faders and buttons (see [`BuiltinKind::is_control_surface`]).
    pub fn wire_is_from_control_surface(&self, from_id: &str, from_jack: &str) -> Result<bool> {
        let (from_id, _) = self.resolve_out_jack(from_id, from_jack)?;
        let node = self.node_idx(&from_id)?;
        Ok(BuiltinKind::is_control_surface(&self.nodes[node].ext_id))
    }

    /// User wire-time auto blend mode (called by the app right after
    /// `connect`): the FIRST wire into a jack decides — Override when the
    /// wire carries a POSITION rather than a modulation, so it SETS what it
    /// lands on: pitch into pitch (v/oct on both ends), or anything out of
    /// a control surface, where the physical fader in the user's hand is
    /// the value. Anything else resets to CV so a stale Override never
    /// captures an LFO. Extra wires sum without touching the mode (vibrato
    /// on top of a note CV). Patch load and undo restore the saved field
    /// instead of re-deriving it.
    pub fn auto_wire_style_on_connect(
        &mut self,
        from_id: &str,
        from_jack: &str,
        to_id: &str,
        to_jack: &str,
    ) -> Result<()> {
        if self.input_wire_count(to_id, to_jack)? != 1 {
            return Ok(());
        }
        let sets_the_value = self.wire_is_pitch_pair(from_id, from_jack, to_id, to_jack)?
            || self.wire_is_from_control_surface(from_id, from_jack)?;
        let style = if sets_the_value {
            crate::knob::WireStyle::Override
        } else {
            crate::knob::WireStyle::Cv
        };
        self.set_knob_wire_style(to_id, to_jack, style)
    }

    /// Reset one input knob to its default *value*: position back to the
    /// manifest default, wire atten/offset back to `KnobState` defaults.
    /// A per-patch config override (style/range/curve) is a deliberate
    /// customization, not a value — it stays, and the default position is
    /// computed against it. On a macro instance's external jack the
    /// default is the state saved in the macro definition (what a fresh
    /// instantiation would give).
    pub fn reset_knob(&mut self, instance_id: &str, jack_id: &str) -> Result<()> {
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        let saved = self.macro_instances.get(instance_id).and_then(|mi| {
            let ij = mi.def.interface.inputs.iter().find(|ij| ij.id == jack_id)?;
            self.macro_default_knob(&mi.def, &ij.node, &ij.jack)
        });
        let state = saved.unwrap_or_else(|| {
            let decl = &self.nodes[node].manifest.inputs[jack];
            let config = self.nodes[node].knobs[jack].config.clone();
            let cfg = config
                .clone()
                .or_else(|| decl.knob.clone())
                .unwrap_or_default();
            KnobState {
                position: position_for_value(&cfg, decl.default),
                config,
                // The blend mode belongs to the wire, not the value — a
                // double-click value reset must not flip Override off.
                wire_style: self.nodes[node].knobs[jack].wire_style,
                ..KnobState::default()
            }
        });
        self.nodes[node].knobs[jack] = state;
        self.push_knob_rt(node, jack)
    }

    /// Reset every input knob and every param of a module to defaults —
    /// the state a freshly added module of this type would have. For a
    /// macro instance that is the saved internal state of ITS OWN copy of
    /// the definition (see [`Engine::reset_macro_instance`], which also
    /// restores internal wiring). Non-structural: wires, MIDI mappings
    /// and loaded tracks are untouched.
    pub fn reset_module(&mut self, instance_id: &str) -> Result<()> {
        if let Some(def) = self
            .macro_instances
            .get(instance_id)
            .map(|mi| mi.def.clone())
        {
            return self.reset_macro_state(instance_id, &def);
        }
        self.node_idx(instance_id)?;
        self.reset_node_to_manifest(instance_id)
    }

    /// Reset one concrete node's knobs and params to its manifest defaults.
    pub(super) fn reset_node_to_manifest(&mut self, instance_id: &str) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        for jack in 0..self.nodes[node].manifest.inputs.len() {
            let decl = &self.nodes[node].manifest.inputs[jack];
            let cfg = decl.knob.clone().unwrap_or_default();
            self.nodes[node].knobs[jack] = KnobState {
                position: position_for_value(&cfg, decl.default),
                ..KnobState::default()
            };
            self.push_knob_rt(node, jack)?;
        }
        let params: Vec<(String, f32)> = self.nodes[node]
            .manifest
            .params
            .iter()
            .map(|p| (p.id.clone(), p.default_f32()))
            .collect();
        for (param, value) in params {
            self.set_param(instance_id, &param, value)?;
        }
        Ok(())
    }

    /// Recall one of a module's built-in presets (manifest `presets`, PRD
    /// §5.1): a named set of input-jack VALUES. A preset only moves knobs
    /// — wiring, attenuverter settings, knob config overrides and any jack
    /// the preset leaves out are untouched, exactly as if the user had
    /// turned those controls by hand.
    pub fn apply_preset(&mut self, instance_id: &str, preset: &str) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let values = self.nodes[node]
            .manifest
            .preset(preset)
            .ok_or_else(|| anyhow!("module {instance_id:?} has no preset {preset:?}"))?
            .values
            .clone();
        for (jack_id, value) in values {
            self.set_knob_value(instance_id, &jack_id, value)?;
        }
        Ok(())
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

    /// Read an input jack's live telemetry (`graph.tap`) — instantaneous
    /// value, 100 ms RMS, fast flag, volatility, and the value the UI
    /// should display.
    pub fn tap(&self, instance_id: &str, jack_id: &str) -> Result<JackTelemetry> {
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        Ok(self.nodes[node].telemetry[jack].read())
    }

    /// Read an output jack's live telemetry — same shape as [`Engine::tap`],
    /// resolving macro externals and named MIDI mapping jacks.
    pub fn tap_out(&self, instance_id: &str, jack_id: &str) -> Result<JackTelemetry> {
        let (rid, rjack) = self.resolve_out_jack(instance_id, jack_id)?;
        let node = self.node_idx(&rid)?;
        let jack = self.out_jack_index(node, &rjack)?;
        self.nodes[node]
            .out_telemetry
            .get(jack)
            .map(|s| s.read())
            .ok_or_else(|| anyhow!("no output telemetry for {instance_id:?}:{jack_id:?}"))
    }

    /// Read the raw sample window an input jack captures — the signal
    /// itself, for panels that DRAW it (the Scope). Only jacks whose
    /// manifest marks them `capture` have one.
    pub fn jack_capture(&self, instance_id: &str, jack_id: &str) -> Result<CaptureWindow> {
        let (node, jack) = self.in_jack_indices(instance_id, jack_id)?;
        self.nodes[node]
            .capture
            .get(jack)
            .and_then(|c| c.as_ref())
            .map(|c| c.read())
            .ok_or_else(|| anyhow!("jack {instance_id:?}:{jack_id:?} captures no samples"))
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
