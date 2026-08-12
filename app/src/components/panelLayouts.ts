// Declarative panel layouts: each module type can describe how its input
// cells are grouped and arranged (titled groups, rows / columns / grids,
// fader vs dial controls, hidden labels) and how its output jacks are
// grouped. Unknown modules fall back to a wrapped-row auto layout, and
// normalization guarantees every manifest jack is rendered exactly once —
// a layout can rearrange jacks but never lose one.

import type { Manifest } from '../types';

/** How a single input cell renders its control. */
export type CellControl =
  | 'auto' // follow the knob config style (dial / toggle / button / wire)
  | 'fader' // vertical slider
  | 'hfader' // horizontal slider (e.g. a crossfader)
  | 'jack'; // jack only — the value is managed by a custom UI

export interface CellSpec {
  jack: string;
  /** Display label; defaults to the jack id. */
  label?: string;
  hideLabel?: boolean;
  control?: CellControl;
}

export interface GroupSpec {
  title?: string;
  /** Cell flow inside the group. Default: 'row' (wraps). */
  kind?: 'row' | 'column' | 'grid';
  /** Grid column count (kind: 'grid'). */
  columns?: number;
  inputs: (string | CellSpec)[];
  /** Start this group on a new line of the panel. */
  break?: boolean;
}

export interface OutputGroupSpec {
  title?: string;
  outputs: string[];
  /** Grid column count; outputs wrap freely when unset. */
  columns?: number;
}

export interface PanelLayout {
  groups: GroupSpec[];
  outputGroups?: OutputGroupSpec[];
}

/** Normalized cell/group forms handed to the renderer. */
export interface ResolvedGroup extends Omit<GroupSpec, 'inputs'> {
  cells: CellSpec[];
}

export interface ResolvedLayout {
  groups: ResolvedGroup[];
  outputGroups: OutputGroupSpec[];
}

const cell = (spec: string | CellSpec): CellSpec =>
  typeof spec === 'string' ? { jack: spec } : spec;

/** `ids('cv', 1, 16)` -> cv1..cv16 as unlabeled cells. */
const seq = (prefix: string, from: number, to: number, opts?: Partial<CellSpec>): CellSpec[] => {
  const out: CellSpec[] = [];
  for (let i = from; i <= to; i++) out.push({ jack: `${prefix}${i}`, label: String(i), ...opts });
  return out;
};

const seqIds = (prefix: string, from: number, to: number): string[] => {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${prefix}${i}`);
  return out;
};

type LayoutFactory = (manifest: Manifest) => PanelLayout;

/** Per-module layouts, keyed by manifest id. */
const LAYOUTS: Record<string, LayoutFactory> = {
  'com.dj.oscillator': () => ({
    groups: [{ inputs: ['pitch', 'fm', 'sync', 'waveform'] }],
  }),

  'com.dj.vco': () => ({
    groups: [
      { title: 'pitch', inputs: ['pitch', 'fine'] },
      { title: 'fm', inputs: ['fm', 'fm_index'] },
      { title: 'shape', inputs: [{ jack: 'pwm', label: 'pw' }, 'sync'] },
    ],
  }),

  'com.dj.wavetable': () => ({
    groups: [
      { title: 'pitch', inputs: ['pitch', 'fine'] },
      { title: 'table', inputs: ['pos'] },
      { title: 'fm', inputs: ['fm', 'fm_index'] },
      { inputs: ['sync'] },
    ],
  }),

  'com.dj.lfo': () => ({
    groups: [
      { title: 'rate', inputs: ['rate', 'phase'] },
      { title: 'shape', inputs: ['shape', 'pw'] },
      { title: 'sync', inputs: ['clock', 'ratio', 'reset'] },
    ],
  }),

  'com.dj.adsr': () => ({
    groups: [
      { title: 'gates', inputs: ['gate', 'retrig'] },
      {
        title: 'envelope',
        inputs: [
          { jack: 'attack', label: 'A' },
          { jack: 'decay', label: 'D' },
          { jack: 'sustain', label: 'S' },
          { jack: 'release', label: 'R' },
        ],
      },
    ],
  }),

  'com.dj.filter': () => ({
    groups: [
      { title: 'audio', inputs: ['in'] },
      { title: 'cutoff', inputs: ['cutoff'] },
      { title: 'resonance', inputs: ['res'] },
      { title: 'drive', inputs: ['drive', { jack: 'topology', label: 'topo' }] },
    ],
  }),

  'com.dj.vca': () => ({
    groups: [{ inputs: ['in', 'cv'] }],
  }),

  'com.dj.vca_dual': () => ({
    groups: [
      {
        title: 'channel 1',
        kind: 'column',
        inputs: [
          'in1',
          'cv1',
          { jack: 'resp1', label: 'resp' },
          { jack: 'offset1', label: 'offs' },
        ],
      },
      {
        title: 'channel 2',
        kind: 'column',
        inputs: [
          'in2',
          'cv2',
          { jack: 'resp2', label: 'resp' },
          { jack: 'offset2', label: 'offs' },
        ],
      },
    ],
  }),

  // A real-mixer look: one strip per channel — stereo input jacks on top,
  // pan knob, then the level fader — plus a master strip.
  'com.dj.mixer': () => ({
    groups: [
      ...[1, 2, 3, 4, 5, 6].map((ch) => ({
        title: String(ch),
        kind: 'column' as const,
        inputs: [
          { jack: `in${ch}_l`, label: 'L' },
          { jack: `in${ch}_r`, label: 'R' },
          { jack: `pan${ch}`, label: 'pan' },
          { jack: `lvl${ch}`, control: 'fader' as const, hideLabel: true },
        ],
      })),
      {
        title: 'mstr',
        kind: 'column',
        inputs: [{ jack: 'master', control: 'fader', hideLabel: true }],
      },
    ],
    outputGroups: [{ title: 'out', outputs: ['out_l', 'out_r'] }],
  }),

  'com.dj.attenuverter': () => ({
    groups: [
      {
        kind: 'grid',
        columns: 3,
        inputs: [1, 2, 3, 4, 5, 6, 7, 8].flatMap((ch) => [
          { jack: `in${ch}`, label: `in ${ch}` },
          { jack: `atten${ch}`, label: 'atten' },
          { jack: `offset${ch}`, label: 'offset' },
        ]),
      },
    ],
    outputGroups: [{ outputs: seqIds('out', 1, 8) }],
  }),

  'com.dj.clock': () => ({
    groups: [
      { title: 'tempo', inputs: ['bpm', 'swing', 'beats'] },
      { title: 'transport', inputs: ['run', 'reset'] },
    ],
    outputGroups: [
      { title: 'clock', outputs: ['clock', 'bar'] },
      { title: 'div', outputs: ['div2', 'div4', 'div8', 'div16'] },
      { title: 'mul', outputs: ['mul2', 'mul3', 'mul4'] },
    ],
  }),

  // One column per step (cv over gate over ratchet), like a hardware
  // sequencer's per-step channel. The step grid comes FIRST so it sits
  // directly under the custom playhead strip (StepSeqUI), which renders
  // a grid with the same --cell-w columns — lamp s aligns with column s.
  'com.dj.step_seq': () => ({
    groups: [
      {
        title: 'cv / gate / ratchet',
        kind: 'grid',
        columns: 16,
        inputs: [
          ...seq('cv', 1, 16),
          ...seq('gate', 1, 16, { hideLabel: true }),
          ...seq('ratchet', 1, 16, { hideLabel: true }),
        ],
      },
      {
        title: 'transport',
        break: true,
        inputs: ['clock', 'reset', 'length', 'dir', 'glide'],
      },
    ],
  }),

  // The step grid itself is the custom TrigSeqUI; the pattern jacks stay
  // wireable as jack-only cells and the lengths keep their knobs.
  'com.dj.trig_seq': () => ({
    groups: [
      { title: 'transport', inputs: ['clock', 'reset'] },
      {
        title: 'pattern cv',
        kind: 'grid',
        columns: 8,
        inputs: seq('pat', 1, 8, { control: 'jack' }).map((c, i) => ({
          ...c,
          label: `p${i + 1}`,
        })),
      },
      {
        title: 'length',
        kind: 'grid',
        columns: 8,
        inputs: seq('len', 1, 8),
      },
    ],
    outputGroups: [
      { title: 'trig', outputs: seqIds('trig', 1, 8), columns: 8 },
      { outputs: ['pos'] },
    ],
  }),

  'com.dj.euclid': () => ({
    groups: [
      { title: 'transport', inputs: ['clock', 'reset'] },
      ...[1, 2, 3, 4].map((ch) => ({
        title: `ring ${ch}`,
        kind: 'column' as const,
        inputs: [
          { jack: `steps${ch}`, label: 'steps' },
          { jack: `fill${ch}`, label: 'fill' },
          { jack: `rot${ch}`, label: 'rot' },
        ],
      })),
    ],
    outputGroups: [
      { outputs: ['ch1', 'ch2', 'ch3', 'ch4', 'or'] },
      { title: 'step', outputs: seqIds('step', 1, 4) },
    ],
  }),

  'com.dj.drum': () => ({
    groups: [
      {
        title: 'kick',
        kind: 'column',
        inputs: [
          { jack: 'kick_trig', label: 'trig' },
          { jack: 'kick_tune', label: 'tune' },
          { jack: 'kick_decay', label: 'decay' },
          { jack: 'kick_tone', label: 'click' },
        ],
      },
      {
        title: 'snare',
        kind: 'column',
        inputs: [
          { jack: 'snare_trig', label: 'trig' },
          { jack: 'snare_tune', label: 'tune' },
          { jack: 'snare_decay', label: 'decay' },
          { jack: 'snare_tone', label: 'snap' },
        ],
      },
      {
        title: 'hat',
        kind: 'column',
        inputs: [
          { jack: 'hat_trig', label: 'trig' },
          { jack: 'hat_tune', label: 'tune' },
          { jack: 'hat_decay', label: 'decay' },
          { jack: 'hat_tone', label: 'tone' },
        ],
      },
    ],
    outputGroups: [{ outputs: ['kick', 'snare', 'hat', 'mix'] }],
  }),

  'com.dj.noise': () => ({
    groups: [{ inputs: ['clock', 'rate'] }],
  }),

  'com.dj.sample_hold': () => ({
    groups: [{ inputs: ['in', 'trig', 'mode', 'slew'] }],
  }),

  'com.dj.turing': () => ({
    groups: [
      { title: 'sequence', inputs: ['clock', 'prob', 'length'] },
      { title: 'voltage', inputs: ['range', 'scale', 'root'] },
    ],
  }),

  // The scale keyboard (QuantizerUI) is the custom-mask editor; the
  // `custom` jack stays wireable as a jack-only cell like trig_seq's
  // pattern jacks.
  'com.dj.quantizer': () => ({
    groups: [
      { title: 'quantize', inputs: ['in', 'scale', 'root'] },
      {
        title: 'transpose',
        inputs: [
          { jack: 'semitones', label: 'semi' },
          { jack: 'octaves', label: 'oct' },
        ],
      },
      { inputs: [{ jack: 'custom', control: 'jack', label: 'cust' }] },
    ],
  }),

  'com.dj.function': () => ({
    groups: [
      { title: 'signal', inputs: ['in', 'trig', 'gate'] },
      { title: 'shape', inputs: ['rise', 'fall', 'curve', 'cycle'] },
    ],
  }),

  'com.dj.logic': () => ({
    groups: [
      { title: 'gates', inputs: ['a', 'b', 'c'] },
      {
        title: 'compare',
        inputs: [
          { jack: 'cmp_in', label: 'in' },
          { jack: 'threshold', label: 'thresh' },
        ],
      },
      {
        title: 'window',
        inputs: [
          { jack: 'win_in', label: 'in' },
          { jack: 'win_low', label: 'low' },
          { jack: 'win_high', label: 'high' },
        ],
      },
      {
        title: 'gate→trig',
        inputs: [
          { jack: 'g2t_in', label: 'in' },
          { jack: 'trig_ms', label: 'ms' },
        ],
      },
    ],
    outputGroups: [
      { title: 'logic', outputs: ['and', 'nand', 'or', 'nor', 'xor', 'xnor', 'not_a', 'not_b'] },
      { title: 'compare', outputs: ['cmp', 'window', 'trig'] },
    ],
  }),

  'com.dj.mult': () => ({
    groups: [
      {
        title: 'mult',
        inputs: [
          { jack: 'a_in', label: 'a' },
          { jack: 'b_in', label: 'b' },
        ],
      },
      { title: 'merge', inputs: seq('merge', 1, 4) },
      {
        title: 'split',
        inputs: [
          { jack: 'split_in', label: 'in' },
          { jack: 'split_sel', label: 'sel' },
        ],
      },
    ],
    outputGroups: [
      { title: 'a', outputs: seqIds('a', 1, 4) },
      { title: 'b', outputs: seqIds('b', 1, 4) },
      { title: 'merge', outputs: ['merge'] },
      { title: 'split', outputs: seqIds('s', 1, 4) },
    ],
  }),

  'com.dj.seq_switch': () => ({
    groups: [
      { title: 'route', inputs: ['in', 'cv', 'steps', 'clock', 'reset'] },
      { title: 'inputs', kind: 'grid', columns: 8, inputs: seq('i', 1, 8) },
      { title: 'mutes', kind: 'grid', columns: 8, inputs: seq('m', 1, 8) },
    ],
    outputGroups: [
      { title: 'outputs', outputs: seqIds('o', 1, 8), columns: 8 },
      { outputs: ['out', 'step_cv'] },
    ],
  }),

  'com.dj.delay': () => ({
    groups: [
      {
        title: 'audio',
        inputs: [
          { jack: 'in_l', label: 'L' },
          { jack: 'in_r', label: 'R' },
        ],
      },
      { title: 'time', inputs: ['time', 'clock', 'div'] },
      {
        title: 'tone',
        inputs: [
          { jack: 'feedback', label: 'fdbk' },
          { jack: 'lowpass', label: 'lp' },
          { jack: 'highpass', label: 'hp' },
        ],
      },
      { title: 'mix', inputs: ['mix', { jack: 'pingpong', label: 'pong' }] },
    ],
  }),

  'com.dj.reverb': () => ({
    groups: [
      {
        title: 'audio',
        inputs: [
          { jack: 'in_l', label: 'L' },
          { jack: 'in_r', label: 'R' },
        ],
      },
      {
        title: 'space',
        inputs: [
          'size',
          'decay',
          { jack: 'damping', label: 'damp' },
          { jack: 'diffusion', label: 'diff' },
        ],
      },
      { title: 'mix', inputs: ['freeze', 'mix'] },
    ],
  }),

  'com.dj.granular': () => ({
    groups: [
      {
        title: 'audio',
        inputs: [{ jack: 'in_l', label: 'L' }, { jack: 'in_r', label: 'R' }, 'trig'],
      },
      {
        title: 'grains',
        inputs: [
          { jack: 'density', label: 'dens' },
          'size',
          { jack: 'position', label: 'pos' },
          'pitch',
        ],
      },
      {
        title: 'texture',
        inputs: [
          { jack: 'texture', label: 'tex' },
          { jack: 'spread', label: 'sprd' },
          { jack: 'feedback', label: 'fdbk' },
          'freeze',
        ],
      },
      { title: 'mix', inputs: ['mix'] },
    ],
  }),

  'com.dj.modfx': () => ({
    groups: [
      {
        title: 'audio',
        inputs: [
          { jack: 'in_l', label: 'L' },
          { jack: 'in_r', label: 'R' },
        ],
      },
      { title: 'mod', inputs: ['mode', 'rate', 'depth'] },
      {
        title: 'voice',
        inputs: [
          { jack: 'feedback', label: 'fdbk' },
          { jack: 'spread', label: 'sprd' },
          { jack: 'through_zero', label: 'tz' },
        ],
      },
      { title: 'mix', inputs: ['mix'] },
    ],
  }),

  'com.dj.compressor': () => ({
    groups: [
      {
        title: 'audio',
        inputs: [
          { jack: 'in_l', label: 'L' },
          { jack: 'in_r', label: 'R' },
          { jack: 'sidechain', label: 'sc' },
        ],
      },
      { title: 'dynamics', inputs: [{ jack: 'threshold', label: 'thresh' }, 'ratio', 'knee'] },
      {
        title: 'envelope',
        inputs: [
          { jack: 'attack', label: 'atk' },
          { jack: 'release', label: 'rel' },
        ],
      },
      { title: 'gain', inputs: [{ jack: 'makeup', label: 'makeup' }] },
    ],
    outputGroups: [{ outputs: ['out_l', 'out_r', 'gr'] }],
  }),

  'com.dj.waveshaper': () => ({
    groups: [
      { title: 'audio', inputs: ['in'] },
      { title: 'shape', inputs: ['mode', 'drive', 'bias', 'level'] },
    ],
  }),

  'com.dj.resonator': () => ({
    groups: [
      { title: 'excite', inputs: ['in', 'trig'] },
      { title: 'pitch', inputs: ['pitch', { jack: 'structure', label: 'struct' }] },
      {
        title: 'tone',
        inputs: [
          { jack: 'brightness', label: 'brite' },
          { jack: 'damping', label: 'damp' },
          { jack: 'position', label: 'pos' },
        ],
      },
      { title: 'voice', inputs: ['mode', 'voices', 'mix'] },
    ],
  }),

  'com.dj.scope': () => ({
    groups: [
      { inputs: ['in', { jack: 'hysteresis', label: 'hyst' }, { jack: 'window', label: 'win' }] },
    ],
    outputGroups: [
      { title: 'signal', outputs: ['thru', 'trig'] },
      { title: 'measure', outputs: ['pitch', 'hz', 'peak', 'rms'] },
    ],
  }),

  'com.dj.camera': () => ({
    groups: [{ inputs: ['in'] }],
    outputGroups: [{ outputs: ['thru'] }],
  }),

  'com.dj.gain_native': () => ({
    groups: [{ inputs: ['in', 'gain'] }],
  }),

  'builtin.crossfader': () => ({
    groups: [
      {
        title: 'deck a',
        kind: 'column',
        inputs: [
          { jack: 'a_l', label: 'L' },
          { jack: 'a_r', label: 'R' },
        ],
      },
      { title: 'crossfade', inputs: [{ jack: 'xfade', control: 'hfader', hideLabel: true }] },
      {
        title: 'deck b',
        kind: 'column',
        inputs: [
          { jack: 'b_l', label: 'L' },
          { jack: 'b_r', label: 'R' },
        ],
      },
    ],
  }),

  'builtin.audio_out': () => ({
    groups: [
      {
        title: 'audio',
        inputs: [
          { jack: 'l', label: 'L' },
          { jack: 'r', label: 'R' },
        ],
      },
      { title: 'device', inputs: [{ jack: 'channel_offset', label: 'chan' }] },
    ],
  }),

  'builtin.playback': () => ({
    groups: [{ inputs: [{ jack: 'play_gate', label: 'play' }, 'speed', 'loop'] }],
  }),

  'builtin.deck': () => ({
    groups: [
      {
        title: 'transport',
        inputs: [
          { jack: 'play_gate', label: 'play' },
          { jack: 'speed', label: 'pitch', control: 'fader' },
          { jack: 'phase_nudge', label: 'nudge' },
          { jack: 'loop_toggle', label: 'loop' },
        ],
      },
      {
        title: 'hot cues',
        kind: 'grid',
        columns: 8,
        inputs: seq('cue_trig', 1, 8),
      },
    ],
    outputGroups: [
      { title: 'audio', outputs: ['audio_l', 'audio_r'] },
      { title: 'clock', outputs: ['beat_clock', 'bar_clock', 'phase', 'bpm'] },
      { title: 'stems', outputs: ['stem_vocals', 'stem_drums', 'stem_bass', 'stem_other'] },
    ],
  }),

  'builtin.midi': () => ({
    groups: [{ title: 'led feedback', kind: 'grid', columns: 8, inputs: seq('led', 0, 15) }],
    outputGroups: [
      { title: 'mappings', outputs: seqIds('map', 0, 63), columns: 8 },
      {
        title: 'voices',
        outputs: [1, 2, 3, 4].flatMap((v) => [`v${v}_pitch`, `v${v}_gate`, `v${v}_vel`]),
        columns: 3,
      },
      {
        title: 'global',
        outputs: ['mod', 'bend', 'pressure', 'sustain', 'clock', 'beat', 'transport'],
      },
    ],
  }),

  'builtin.gesture': () => ({
    groups: [],
    outputGroups: [{ title: 'mappings', outputs: seqIds('map', 0, 63), columns: 8 }],
  }),
};

/** Fallback: all inputs in one wrapped row, all outputs in one group. */
function autoLayout(manifest: Manifest): PanelLayout {
  return { groups: [{ inputs: manifest.inputs.map((i) => i.id) }] };
}

/**
 * Resolve the layout for a manifest: pick the registered layout (or the
 * auto layout), drop cells whose jack does not exist in this manifest,
 * and append any manifest jacks the layout forgot as an extra group —
 * layouts can rearrange jacks but never lose them.
 */
export function resolveLayout(manifest: Manifest): ResolvedLayout {
  const layout = (LAYOUTS[manifest.id] ?? autoLayout)(manifest);
  const inputIds = new Set(manifest.inputs.map((i) => i.id));
  const outputIds = new Set(manifest.outputs.map((o) => o.id));

  const seen = new Set<string>();
  const groups: ResolvedGroup[] = layout.groups
    .map((g) => ({
      ...g,
      cells: g.inputs
        .map(cell)
        .filter((c) => inputIds.has(c.jack) && !seen.has(c.jack) && (seen.add(c.jack), true)),
    }))
    .filter((g) => g.cells.length > 0);
  const missing = manifest.inputs.filter((i) => !seen.has(i.id));
  if (missing.length > 0) {
    groups.push({ cells: missing.map((i) => ({ jack: i.id })) });
  }

  const seenOut = new Set<string>();
  const outputGroups: OutputGroupSpec[] = (layout.outputGroups ?? [])
    .map((g) => ({
      ...g,
      outputs: g.outputs.filter(
        (id) => outputIds.has(id) && !seenOut.has(id) && (seenOut.add(id), true),
      ),
    }))
    .filter((g) => g.outputs.length > 0);
  const missingOut = manifest.outputs.filter((o) => !seenOut.has(o.id));
  if (missingOut.length > 0) {
    outputGroups.push({ outputs: missingOut.map((o) => o.id) });
  }

  return { groups, outputGroups };
}
