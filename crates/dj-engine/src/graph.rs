//! Directed patch graph with RT-safe block execution (PRD §6).
//!
//! - Cycles are allowed: back edges (detected at plan time) read the source's
//!   *previous* block output (one-block delay), feed-forward edges read the
//!   current block.
//! - All buffers are allocated at edit/plan time; `process_block` performs no
//!   allocation and takes no locks.

use crate::builtin::AudioOutModule;
use crate::knob::JackRt;
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
}

pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub wires: Vec<WireSpec>,

    // Per node, per jack buffers (allocated at plan time).
    in_bufs: Vec<Vec<Vec<f32>>>,
    out_curr: Vec<Vec<Vec<f32>>>,
    out_prev: Vec<Vec<Vec<f32>>>,
    pub jack_rt: Vec<Vec<JackRt>>,
    analyzers: Vec<Vec<JackAnalyzer>>,

    incoming: Vec<Vec<Vec<Incoming>>>,
    connected_mask: Vec<u64>,
    order: Vec<usize>,

    block_size: usize,
    pub frames_processed: u64,
}

impl Graph {
    pub fn new(block_size: usize) -> Self {
        Graph {
            nodes: Vec::new(),
            wires: Vec::new(),
            in_bufs: Vec::new(),
            out_curr: Vec::new(),
            out_prev: Vec::new(),
            jack_rt: Vec::new(),
            analyzers: Vec::new(),
            incoming: Vec::new(),
            connected_mask: Vec::new(),
            order: Vec::new(),
            block_size,
            frames_processed: 0,
        }
    }

    pub fn block_size(&self) -> usize {
        self.block_size
    }

    /// Add a node. `jack_rt` and `analyzers` must have one entry per input.
    pub fn add_node(
        &mut self,
        node: GraphNode,
        jack_rt: Vec<JackRt>,
        analyzers: Vec<JackAnalyzer>,
    ) -> usize {
        let n_in = node.n_in;
        let n_out = node.n_out;
        self.in_bufs.push(vec![vec![0.0; self.block_size]; n_in]);
        self.out_curr.push(vec![vec![0.0; self.block_size]; n_out]);
        self.out_prev.push(vec![vec![0.0; self.block_size]; n_out]);
        self.jack_rt.push(jack_rt);
        self.analyzers.push(analyzers);
        self.incoming.push(vec![Vec::new(); n_in]);
        self.connected_mask.push(0);
        self.nodes.push(node);
        let idx = self.nodes.len() - 1;
        self.replan();
        idx
    }

    pub fn add_wire(&mut self, w: WireSpec) {
        self.wires.push(w);
        self.replan();
    }

    pub fn remove_wire(&mut self, w: WireSpec) {
        self.wires.retain(|x| *x != w);
        self.replan();
    }

    /// Recompute execution order, back edges, incoming lists, and masks.
    /// Called on the control thread only.
    fn replan(&mut self) {
        let n = self.nodes.len();
        // DFS computing reverse postorder; edges to gray nodes are back edges.
        let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); n]; // node -> (target, wire idx)
        for (wi, w) in self.wires.iter().enumerate() {
            adj[w.from_node].push((w.to_node, wi));
        }
        let mut color = vec![0u8; n]; // 0 white, 1 gray, 2 black
        let mut postorder = Vec::with_capacity(n);
        let mut back_edge = vec![false; self.wires.len()];

        // Iterative DFS.
        for start in 0..n {
            if color[start] != 0 {
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
        self.order = postorder;

        for node in 0..n {
            for jack in 0..self.nodes[node].n_in {
                self.incoming[node][jack].clear();
            }
            self.connected_mask[node] = 0;
        }
        for (wi, w) in self.wires.iter().enumerate() {
            self.incoming[w.to_node][w.to_jack].push((w.from_node, w.from_jack, back_edge[wi]));
            self.connected_mask[w.to_node] |= 1u64 << w.to_jack;
        }
    }

    /// Process one block. `master` is the pre-allocated master bus
    /// (one Vec<f32> of block_size per output channel). RT-safe.
    pub fn process_block(&mut self, frames: usize, master: &mut [Vec<f32>]) {
        let frames = frames.min(self.block_size);
        for ch in master.iter_mut() {
            ch[..frames].fill(0.0);
        }

        for oi in 0..self.order.len() {
            let node = self.order[oi];
            let n_in = self.nodes[node].n_in;

            // Gather effective inputs.
            for jack in 0..n_in {
                let rt = self.jack_rt[node][jack];
                let wired = !self.incoming[node][jack].is_empty();
                if !wired {
                    self.in_bufs[node][jack][..frames].fill(rt.unwired_value);
                } else {
                    self.in_bufs[node][jack][..frames].fill(0.0);
                    for k in 0..self.incoming[node][jack].len() {
                        let (src, sjack, prev) = self.incoming[node][jack][k];
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
                    // Wired inputs blend with the manual knob: the knob's
                    // mapped value is the baseline and the incoming signal
                    // adds on top, scaled by the attenuverter (+ offset for
                    // asymmetric spreads).
                    let dst = &mut self.in_bufs[node][jack];
                    for x in dst.iter_mut().take(frames) {
                        *x = rt.unwired_value + *x * rt.atten + rt.offset;
                    }
                }
                self.analyzers[node][jack].update(&self.in_bufs[node][jack][..frames]);
            }

            // Run the module.
            let mask = self.connected_mask[node];
            self.nodes[node].module.process(
                &self.in_bufs[node],
                &mut self.out_curr[node],
                mask,
                frames,
            );

            // Mix audio-out nodes into the master bus (hard clip happens at
            // the device/file boundary, not here).
            if self.nodes[node].audio_out {
                let offset = self.nodes[node]
                    .module
                    .as_any()
                    .downcast_ref::<AudioOutModule>()
                    .map(|m| m.channel_offset)
                    .unwrap_or(0);
                // Only the audio jacks mix to master; the trailing
                // channel_offset input jack is control, not audio.
                for jack in 0..n_in.min(crate::builtin::AUDIO_OUT_CHANNELS) {
                    let ch = offset + jack;
                    if ch >= master.len() {
                        break;
                    }
                    // Skip unwired inputs so silent jacks don't add DC.
                    if self.incoming[node][jack].is_empty() {
                        continue;
                    }
                    let src = &self.in_bufs[node][jack];
                    let dst = &mut master[ch];
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
        let state = self.nodes[node].module.save_state();
        new_module.load_state(&state);
        std::mem::replace(&mut self.nodes[node].module, new_module)
    }

    pub fn set_jack_rt(&mut self, node: usize, jack: usize, rt: JackRt) {
        self.jack_rt[node][jack] = rt;
    }
}
