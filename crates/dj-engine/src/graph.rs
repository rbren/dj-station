//! Directed patch graph with RT-safe block execution (PRD §6).
//!
//! - Cycles are allowed: back edges (detected at plan time) read the source's
//!   *previous* block output (one-block delay), feed-forward edges read the
//!   current block.
//! - All buffers and the execution [`Plan`] are allocated on the CONTROL
//!   thread; `process_block` performs no allocation and takes no locks.
//! - Structural edits arrive as pre-allocated [`GraphEdit`]s.
//!   [`Graph::apply_edit`] installs the new state with moves/swaps only and
//!   leaves every replaced allocation *inside* the edit, so the same box can
//!   ship back over the garbage ring for a control-thread drop — the graph
//!   can therefore be edited live at a block boundary with zero RT
//!   allocation and zero audible gap.
//! - Node slots are STABLE: removing a node leaves a tombstone (`None`) and
//!   the slot is recycled by the next add (the engine owns the free-list).
//!   Slot indices in `WireSpec`s, RT command queues and the engine's side
//!   tables therefore never shift, which is what makes add/remove-module an
//!   incremental edit instead of a rebuild-the-world event.

use crate::builtin::AudioOutModule;
use crate::knob::{BlendRt, JackRt};
use crate::module_host::HostModule;
use crate::telemetry::JackAnalyzer;

pub const SIGNAL_MAX: f32 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WireSpec {
    pub from_node: usize,
    pub from_jack: usize,
    pub to_node: usize,
    pub to_jack: usize,
}

/// Resolved source of one incoming wire: (node, jack, reads_prev_block).
type Incoming = (usize, usize, bool);

pub struct GraphNode {
    pub module: Box<dyn HostModule>,
    pub n_in: usize,
    pub n_out: usize,
    /// Audio-out nodes are mixed into the master bus by the executor.
    pub audio_out: bool,
    /// Monitor-out nodes are mixed into the monitor (cue) bus instead.
    pub monitor_out: bool,
    /// Per output jack, the input jack its samples are copied from while
    /// `bypassed` (`None` = that output falls silent). Allocated on the
    /// control thread from the manifest ([`crate::manifest::Manifest::bypass_routes`]);
    /// empty means the module declares no bypass and can never be
    /// bypassed.
    pub bypass_routes: Vec<Option<usize>>,
    /// While true the executor copies the routes above and does NOT run
    /// the module: a bypassed module does no processing at all.
    pub bypassed: bool,
}

/// Derived execution state: node order, per-jack incoming wire lists and
/// connected masks. Computed on the control thread by [`compute_plan`];
/// installed on the graph by swap, never mutated in place.
#[derive(Default)]
pub struct Plan {
    order: Vec<usize>,
    incoming: Vec<Vec<Vec<Incoming>>>,
    connected_mask: Vec<u64>,
}

/// Compute the plan for a graph shape: `n_inputs[slot]` is the input-jack
/// count of the node living in `slot` (`None` = tombstone). Control thread
/// only (allocates). The DFS mirrors the original in-graph replan exactly so
/// execution order — and therefore back-edge placement and golden audio —
/// is unchanged.
pub fn compute_plan(n_inputs: &[Option<usize>], wires: &[WireSpec]) -> Plan {
    let n = n_inputs.len();
    // DFS computing reverse postorder; edges to gray nodes are back edges.
    let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); n]; // node -> (target, wire idx)
    for (wi, w) in wires.iter().enumerate() {
        adj[w.from_node].push((w.to_node, wi));
    }
    let mut color = vec![0u8; n]; // 0 white, 1 gray, 2 black
    let mut postorder = Vec::with_capacity(n);
    let mut back_edge = vec![false; wires.len()];

    // Iterative DFS.
    for start in 0..n {
        if color[start] != 0 || n_inputs[start].is_none() {
            continue;
        }
        let mut stack: Vec<(usize, usize)> = vec![(start, 0)];
        color[start] = 1;
        while let Some(&mut (node, ref mut ei)) = stack.last_mut() {
            if *ei < adj[node].len() {
                let (tgt, wi) = adj[node][*ei];
                *ei += 1;
                match color[tgt] {
                    0 => {
                        color[tgt] = 1;
                        stack.push((tgt, 0));
                    }
                    1 => back_edge[wi] = true,
                    _ => {}
                }
            } else {
                color[node] = 2;
                postorder.push(node);
                stack.pop();
            }
        }
    }
    postorder.reverse();

    let mut incoming: Vec<Vec<Vec<Incoming>>> = n_inputs
        .iter()
        .map(|n_in| vec![Vec::new(); n_in.unwrap_or(0)])
        .collect();
    let mut connected_mask = vec![0u64; n];
    for (wi, w) in wires.iter().enumerate() {
        incoming[w.to_node][w.to_jack].push((w.from_node, w.from_jack, back_edge[wi]));
        connected_mask[w.to_node] |= 1u64 << w.to_jack;
    }
    Plan {
        order: postorder,
        incoming,
        connected_mask,
    }
}

/// One node slot's per-jack storage. Fully populated on the control thread
/// for an add; emptied by moves into a remove edit for a control-side drop.
#[derive(Default)]
pub struct NodeStorage {
    pub in_bufs: Vec<Vec<f32>>,
    pub out_curr: Vec<Vec<f32>>,
    pub out_prev: Vec<Vec<f32>>,
    pub jack_rt: Vec<JackRt>,
    pub analyzers: Vec<JackAnalyzer>,
    pub out_analyzers: Vec<JackAnalyzer>,
}

impl NodeStorage {
    /// Buffers and per-jack state for a fresh node (control thread).
    pub fn for_node(
        n_in: usize,
        n_out: usize,
        block_size: usize,
        jack_rt: Vec<JackRt>,
        analyzers: Vec<JackAnalyzer>,
        out_analyzers: Vec<JackAnalyzer>,
    ) -> Self {
        NodeStorage {
            in_bufs: vec![vec![0.0; block_size]; n_in],
            out_curr: vec![vec![0.0; block_size]; n_out],
            out_prev: vec![vec![0.0; block_size]; n_out],
            jack_rt,
            analyzers,
            out_analyzers,
        }
    }
}

/// Pre-allocated replacement outer slot-vectors for growing the graph to a
/// new slot count (a fresh slot beyond the current storage). The RT side
/// swaps each existing element over (moves only) and leaves the old outer
/// vectors here for the control-side drop.
pub struct GrowStorage {
    nodes: Vec<Option<GraphNode>>,
    in_bufs: Vec<Vec<Vec<f32>>>,
    out_curr: Vec<Vec<Vec<f32>>>,
    out_prev: Vec<Vec<Vec<f32>>>,
    jack_rt: Vec<Vec<JackRt>>,
    analyzers: Vec<Vec<JackAnalyzer>>,
    out_analyzers: Vec<Vec<JackAnalyzer>>,
}

impl GrowStorage {
    /// Placeholder-filled vectors of `len` slots (control thread).
    pub fn with_len(len: usize) -> Self {
        GrowStorage {
            nodes: std::iter::repeat_with(|| None).take(len).collect(),
            in_bufs: vec![Vec::new(); len],
            out_curr: vec![Vec::new(); len],
            out_prev: vec![Vec::new(); len],
            jack_rt: vec![Vec::new(); len],
            analyzers: std::iter::repeat_with(Vec::new).take(len).collect(),
            out_analyzers: std::iter::repeat_with(Vec::new).take(len).collect(),
        }
    }
}

/// A structural edit, fully pre-allocated on the control thread. Applying
/// it (RT or stopped) swaps the new state in and parks every replaced
/// allocation back inside this value, which then travels the garbage ring
/// so the drop happens off the RT thread.
pub enum GraphEdit {
    AddNode {
        slot: usize,
        /// In: the node. Out: `None`.
        node: Option<GraphNode>,
        /// In: the slot's buffers/analyzers. Out: emptied.
        storage: NodeStorage,
        /// Present when `slot` is beyond current storage. Out: the old
        /// outer vectors. Boxed to keep this variant from dwarfing the
        /// others — the box is allocated with its contents on the control
        /// thread and only ever moved by the RT thread.
        grow: Option<Box<GrowStorage>>,
        /// In: the new plan. Out: the old plan.
        plan: Plan,
    },
    RemoveNode {
        slot: usize,
        /// In: the new plan. Out: the old plan.
        plan: Plan,
        /// In: `None`. Out: the removed module, for control-side drop.
        module: Option<Box<dyn HostModule>>,
        /// In: empty. Out: the slot's buffers/analyzers.
        storage: NodeStorage,
    },
    /// Wire add/remove: only the derived plan changes.
    Replan {
        /// In: the new plan. Out: the old plan.
        plan: Plan,
    },
}

/// Move all of `cur`'s elements into the (longer, placeholder-filled)
/// `incoming` vector and swap the vectors, leaving the old allocation in
/// `incoming`. Moves and swaps only — RT-safe.
fn migrate<T>(cur: &mut Vec<T>, incoming: &mut Vec<T>) {
    debug_assert!(incoming.len() >= cur.len());
    for (i, v) in cur.iter_mut().enumerate() {
        std::mem::swap(v, &mut incoming[i]);
    }
    std::mem::swap(cur, incoming);
}

pub struct Graph {
    /// Stable node slots; `None` is a tombstone left by a remove edit
    /// (reused by the next add). Indices never shift.
    nodes: Vec<Option<GraphNode>>,

    // Per slot, per jack buffers (allocated at edit time, control side).
    in_bufs: Vec<Vec<Vec<f32>>>,
    out_curr: Vec<Vec<Vec<f32>>>,
    out_prev: Vec<Vec<Vec<f32>>>,
    jack_rt: Vec<Vec<JackRt>>,
    analyzers: Vec<Vec<JackAnalyzer>>,
    out_analyzers: Vec<Vec<JackAnalyzer>>,

    plan: Plan,

    block_size: usize,
    pub frames_processed: u64,
}

impl Graph {
    pub fn new(block_size: usize) -> Self {
        Graph {
            nodes: Vec::new(),
            in_bufs: Vec::new(),
            out_curr: Vec::new(),
            out_prev: Vec::new(),
            jack_rt: Vec::new(),
            analyzers: Vec::new(),
            out_analyzers: Vec::new(),
            plan: Plan::default(),
            block_size,
            frames_processed: 0,
        }
    }

    pub fn block_size(&self) -> usize {
        self.block_size
    }

    /// The module in a live slot. Panics on a tombstone (a stale index is
    /// an engine bookkeeping bug, not a recoverable condition).
    pub fn module_mut(&mut self, slot: usize) -> &mut dyn HostModule {
        self.nodes[slot]
            .as_mut()
            .expect("dead graph slot")
            .module
            .as_mut()
    }

    /// Apply a structural edit at a block boundary. RT-safe: moves and
    /// swaps only; every replaced allocation is parked back inside `edit`
    /// for a control-side drop (see [`GraphEdit`]).
    pub fn apply_edit(&mut self, edit: &mut GraphEdit) {
        match edit {
            GraphEdit::AddNode {
                slot,
                node,
                storage,
                grow,
                plan,
            } => {
                if let Some(g) = grow {
                    self.grow(g);
                }
                let slot = *slot;
                debug_assert!(self.nodes[slot].is_none(), "add into live slot {slot}");
                self.nodes[slot] = node.take();
                // The slot's entries are empty (fresh growth or a prior
                // remove shipped them out), so these drop nothing.
                self.in_bufs[slot] = std::mem::take(&mut storage.in_bufs);
                self.out_curr[slot] = std::mem::take(&mut storage.out_curr);
                self.out_prev[slot] = std::mem::take(&mut storage.out_prev);
                self.jack_rt[slot] = std::mem::take(&mut storage.jack_rt);
                self.analyzers[slot] = std::mem::take(&mut storage.analyzers);
                self.out_analyzers[slot] = std::mem::take(&mut storage.out_analyzers);
                std::mem::swap(&mut self.plan, plan);
            }
            GraphEdit::RemoveNode {
                slot,
                plan,
                module,
                storage,
            } => {
                let slot = *slot;
                *module = self.nodes[slot].take().map(|n| n.module);
                debug_assert!(module.is_some(), "remove of dead slot {slot}");
                storage.in_bufs = std::mem::take(&mut self.in_bufs[slot]);
                storage.out_curr = std::mem::take(&mut self.out_curr[slot]);
                storage.out_prev = std::mem::take(&mut self.out_prev[slot]);
                storage.jack_rt = std::mem::take(&mut self.jack_rt[slot]);
                storage.analyzers = std::mem::take(&mut self.analyzers[slot]);
                storage.out_analyzers = std::mem::take(&mut self.out_analyzers[slot]);
                std::mem::swap(&mut self.plan, plan);
            }
            GraphEdit::Replan { plan } => std::mem::swap(&mut self.plan, plan),
        }
    }

    fn grow(&mut self, g: &mut GrowStorage) {
        migrate(&mut self.nodes, &mut g.nodes);
        migrate(&mut self.in_bufs, &mut g.in_bufs);
        migrate(&mut self.out_curr, &mut g.out_curr);
        migrate(&mut self.out_prev, &mut g.out_prev);
        migrate(&mut self.jack_rt, &mut g.jack_rt);
        migrate(&mut self.analyzers, &mut g.analyzers);
        migrate(&mut self.out_analyzers, &mut g.out_analyzers);
    }

    /// Process one block. `master` and `monitor` are the pre-allocated
    /// buses (one Vec<f32> of block_size per output channel) — the live
    /// output and the cue output, filled by the Audio Output and Monitor
    /// Output modules respectively. RT-safe.
    pub fn process_block(
        &mut self,
        frames: usize,
        master: &mut [Vec<f32>],
        monitor: &mut [Vec<f32>],
    ) {
        let frames = frames.min(self.block_size);
        for ch in master.iter_mut().chain(monitor.iter_mut()) {
            ch[..frames].fill(0.0);
        }

        for oi in 0..self.plan.order.len() {
            let node = self.plan.order[oi];
            // Order only contains live slots (replan skips tombstones).
            let n_in = self.nodes[node].as_ref().unwrap().n_in;

            // Gather effective inputs.
            for jack in 0..n_in {
                let rt = self.jack_rt[node][jack];
                let wired = !self.plan.incoming[node][jack].is_empty();
                if !wired {
                    self.in_bufs[node][jack][..frames].fill(rt.unwired_value);
                } else {
                    self.in_bufs[node][jack][..frames].fill(0.0);
                    for k in 0..self.plan.incoming[node][jack].len() {
                        let (src, sjack, prev) = self.plan.incoming[node][jack][k];
                        let src_buf = if prev {
                            &self.out_prev[src][sjack]
                        } else {
                            &self.out_curr[src][sjack]
                        };
                        let dst = &mut self.in_bufs[node][jack];
                        for s in 0..frames {
                            dst[s] += src_buf[s];
                        }
                    }
                    // Wired inputs blend with the manual knob (knob.rs docs).
                    // Knob-backed inputs blend in position space so the
                    // knob's curve shapes the modulation; plain wire jacks
                    // (audio/gate paths) stay additive. Multiple wires sum,
                    // so the additive result can exceed the rails — hard
                    // clip to ±10 V (positional blends clamp to the knob's
                    // travel instead).
                    let dst = &mut self.in_bufs[node][jack];
                    match rt.blend {
                        BlendRt::Additive => {
                            for x in dst.iter_mut().take(frames) {
                                *x = (rt.unwired_value + *x * rt.atten + rt.offset)
                                    .clamp(-SIGNAL_MAX, SIGNAL_MAX);
                            }
                        }
                        BlendRt::Positional { base_pos, curve } => {
                            let scale = rt.atten / SIGNAL_MAX;
                            let base = base_pos + rt.offset;
                            for x in dst.iter_mut().take(frames) {
                                *x = curve.at(base + *x * scale);
                            }
                        }
                        // Override: the summed signal IS the value, clamped
                        // to the knob's range in value space (never mapped
                        // through the curve — a v/oct CV passes untouched).
                        BlendRt::Override { min, max } => {
                            for x in dst.iter_mut().take(frames) {
                                *x = x.clamp(min, max);
                            }
                        }
                    }
                }
                self.analyzers[node][jack].update(&self.in_bufs[node][jack][..frames]);
            }

            // Run the module — unless it is bypassed, in which case each
            // output takes its declared input's samples verbatim and the
            // DSP is skipped entirely (a copy, so still RT-safe).
            let mask = self.plan.connected_mask[node];
            let gn = self.nodes[node].as_mut().unwrap();
            if gn.bypassed {
                debug_assert_eq!(gn.bypass_routes.len(), gn.n_out, "bypassed without routes");
                for jack in 0..gn.n_out {
                    match gn.bypass_routes[jack] {
                        Some(src) => {
                            let src_buf = &self.in_bufs[node][src];
                            let dst = &mut self.out_curr[node][jack];
                            dst[..frames].copy_from_slice(&src_buf[..frames]);
                        }
                        None => self.out_curr[node][jack][..frames].fill(0.0),
                    }
                }
            } else {
                gn.module
                    .process(&self.in_bufs[node], &mut self.out_curr[node], mask, frames);
            }

            // Tap outputs for telemetry (same machinery as inputs).
            for jack in 0..gn.n_out {
                self.out_analyzers[node][jack].update(&self.out_curr[node][jack][..frames]);
            }

            // Mix audio-out nodes into their bus — live or monitor (hard
            // clip happens at the device/file boundary, not here).
            if gn.audio_out || gn.monitor_out {
                let (offset, muted) = gn
                    .module
                    .as_any()
                    .downcast_ref::<AudioOutModule>()
                    .map(|m| (m.channel_offset, m.muted))
                    .unwrap_or((0, false));
                if muted {
                    continue;
                }
                let bus: &mut [Vec<f32>] = if gn.monitor_out { monitor } else { master };
                // Only the audio jacks mix to the bus; the trailing
                // channel_offset input jack is control, not audio.
                for jack in 0..n_in.min(crate::builtin::AUDIO_OUT_CHANNELS) {
                    let ch = offset + jack;
                    if ch >= bus.len() {
                        break;
                    }
                    // Skip unwired inputs so silent jacks don't add DC.
                    if self.plan.incoming[node][jack].is_empty() {
                        continue;
                    }
                    let src = &self.in_bufs[node][jack];
                    let dst = &mut bus[ch];
                    for s in 0..frames {
                        dst[s] += src[s];
                    }
                }
            }
        }

        // Rotate current/previous outputs for one-block-delay back edges.
        for node in 0..self.nodes.len() {
            std::mem::swap(&mut self.out_curr[node], &mut self.out_prev[node]);
        }
        self.frames_processed += frames as u64;
    }

    /// Swap a node's module in place (hot reload), transferring state.
    /// Runs at a block boundary; the save/load pair may allocate, which is
    /// the documented, bounded exception during a reload swap.
    pub fn swap_module(
        &mut self,
        node: usize,
        mut new_module: Box<dyn HostModule>,
    ) -> Box<dyn HostModule> {
        let gn = self.nodes[node].as_mut().expect("dead graph slot");
        let state = gn.module.save_state();
        new_module.load_state(&state);
        std::mem::replace(&mut gn.module, new_module)
    }

    pub fn set_jack_rt(&mut self, node: usize, jack: usize, rt: JackRt) {
        self.jack_rt[node][jack] = rt;
    }

    /// Bypass a node: its outputs copy their declared inputs and its DSP
    /// stops running. A node that declared no routes is never bypassed
    /// (the engine rejects the request before it gets here).
    pub fn set_bypassed(&mut self, node: usize, on: bool) {
        let gn = self.nodes[node].as_mut().expect("dead graph slot");
        gn.bypassed = on && !gn.bypass_routes.is_empty();
    }
}
