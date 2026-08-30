// In-app module documentation: every extension manifest on disk and every
// builtin has a docs entry, doc jack keys refer to real jacks (so docs
// can't silently drift from the manifests), and the DocsPanel renders
// manifest-derived jack tables with the prose.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocsPanel } from '../src/components/DocsPanel';
import { getModuleDoc, jackDoc, MODULE_DOCS } from '../src/moduleDocs';
import type { Manifest } from '../src/types';

// Every extension manifest on disk, so the docs can't silently miss a
// module. Disk manifests may omit "params"; the engine always fills it in.
const MANIFESTS: Manifest[] = Object.values(
  import.meta.glob<Manifest>('../../extensions/*/manifest.json', {
    eager: true,
    import: 'default',
  }),
).map((m) => ({ ...m, params: m.params ?? [] }));
const byId = (id: string) => {
  const m = MANIFESTS.find((m) => m.id === id);
  if (!m) throw new Error(`no manifest for ${id}`);
  return m;
};

const BUILTIN_IDS = [
  'builtin.audio_out',
  'builtin.midi',
  'builtin.launchcontrol',
  'builtin.qwerty',
  'builtin.hands',
  'builtin.math',
  'builtin.deck',
  'builtin.playback',
  'builtin.audio',
  'builtin.beat_clip',
  'builtin.decks',
  'builtin.crossfader',
];

/** True when a doc key addresses at least one real jack id (exact or with
 *  digits collapsed to `#`). */
const keyMatches = (ids: string[], key: string) =>
  ids.includes(key) || ids.some((id) => id.replace(/\d+/g, '#') === key);

describe('module docs completeness', () => {
  it('found the extension manifests on disk', () => {
    expect(MANIFESTS.length).toBeGreaterThanOrEqual(30);
  });

  it('every extension manifest has a docs entry with summary and examples', () => {
    for (const m of MANIFESTS) {
      const doc = MODULE_DOCS[m.id];
      expect(doc, `missing docs for ${m.id}`).toBeTruthy();
      expect(doc.summary.length, `${m.id} summary too short`).toBeGreaterThan(20);
      expect(doc.examples?.length, `${m.id} has no patching examples`).toBeGreaterThan(0);
    }
  });

  it('every builtin has a docs entry, and macros fall back to the generic doc', () => {
    for (const id of BUILTIN_IDS) {
      expect(MODULE_DOCS[id], `missing docs for ${id}`).toBeTruthy();
    }
    expect(getModuleDoc('macro.some-user-macro', 'macro-1')?.summary).toMatch(/macro/i);
    expect(getModuleDoc('com.dj.oscillator')).toBe(MODULE_DOCS['com.dj.oscillator']);
  });

  it('extension doc jack/param keys refer to real manifest jacks (no drift)', () => {
    for (const m of MANIFESTS) {
      const doc = MODULE_DOCS[m.id];
      const inputIds = m.inputs.map((i) => i.id);
      const outputIds = m.outputs.map((o) => o.id);
      const paramIds = (m.params ?? []).map((p) => p.id);
      for (const key of Object.keys(doc.inputs ?? {})) {
        expect(keyMatches(inputIds, key), `${m.id}: doc input "${key}" has no jack`).toBe(true);
      }
      for (const key of Object.keys(doc.outputs ?? {})) {
        expect(keyMatches(outputIds, key), `${m.id}: doc output "${key}" has no jack`).toBe(true);
      }
      for (const key of Object.keys(doc.params ?? {})) {
        expect(keyMatches(paramIds, key), `${m.id}: doc param "${key}" has no param`).toBe(true);
      }
    }
  });

  it('every documented input on a sampled module has prose', () => {
    for (const id of ['com.dj.oscillator', 'com.dj.adsr', 'com.dj.clock_mult', 'com.dj.step_seq']) {
      const m = byId(id);
      const doc = MODULE_DOCS[id];
      for (const input of m.inputs) {
        expect(jackDoc(doc.inputs, input.id), `${id}: no doc for input ${input.id}`).toBeTruthy();
      }
      for (const output of m.outputs) {
        expect(
          jackDoc(doc.outputs, output.id),
          `${id}: no doc for output ${output.id}`,
        ).toBeTruthy();
      }
    }
  });
});

describe('DocsPanel rendering', () => {
  it('renders summary, jack rows with units/ranges, and examples (oscillator)', () => {
    const m = byId('com.dj.oscillator');
    render(<DocsPanel typeId={m.id} manifest={m} onClose={() => {}} />);
    expect(screen.getByTestId('docs-summary').textContent).toMatch(/oscillator/i);
    // Jack rows come from the manifest; the prose from moduleDocs.
    const pitch = screen.getByTestId('docs-row-pitch');
    expect(pitch.textContent).toContain('1 V/oct');
    expect(pitch.textContent).toContain('knob (-5..5)');
    const audio = screen.getByTestId('docs-row-audio');
    expect(audio.textContent).toContain('-10..+10 V');
    expect(screen.getByTestId('docs-examples').textContent).toMatch(/Filter/);
  });

  it('collapses numbered jack families into one row (step sequencer)', () => {
    const m = byId('com.dj.step_seq');
    render(<DocsPanel typeId={m.id} manifest={m} onClose={() => {}} />);
    expect(screen.getByTestId('docs-row-cv1 .. cv16')).toBeTruthy();
    expect(screen.getByTestId('docs-row-gate1 .. gate16')).toBeTruthy();
    // Non-numbered jacks keep their own rows.
    expect(screen.getByTestId('docs-row-clock')).toBeTruthy();
    expect(screen.queryByTestId('docs-row-cv3')).toBeNull();
  });

  it('keeps individually-documented numbered jacks separate (turing bits)', () => {
    const m = byId('com.dj.turing');
    render(<DocsPanel typeId={m.id} manifest={m} onClose={() => {}} />);
    expect(screen.getByTestId('docs-row-bit1').textContent).toContain('One register bit');
    expect(screen.getByTestId('docs-row-bit2').textContent).toContain('different rhythm');
  });

  it('renders builtin deck docs including params (from the live manifest)', () => {
    // Builtins have no manifest.json on disk; the panel gets the node's
    // live manifest snapshot. A representative subset is enough here.
    const deck: Manifest = {
      id: 'builtin.deck',
      name: 'DJ Deck',
      version: '0.1.0',
      abi: 'native-1',
      category: 'DJ',
      inputs: [
        { id: 'play_gate', name: 'Play Gate' },
        { id: 'cue_trig1', name: 'Cue 1' },
        { id: 'cue_trig2', name: 'Cue 2' },
        { id: 'cue_trig3', name: 'Cue 3' },
      ],
      outputs: [
        { id: 'audio_l', name: 'Audio L' },
        { id: 'beat_clock', name: 'Beat Clock' },
      ],
      params: [{ id: 'keylock', name: 'Keylock', type: 'toggle' }],
    };
    render(<DocsPanel typeId="builtin.deck" manifest={deck} onClose={() => {}} />);
    expect(screen.getByTestId('docs-summary').textContent).toMatch(/deck/i);
    expect(screen.getByTestId('docs-row-play_gate').textContent).toMatch(/play/i);
    expect(screen.getByTestId('docs-row-cue_trig1 .. cue_trig3').textContent).toMatch(/hot cue/i);
    expect(screen.getByTestId('docs-row-keylock').textContent).toMatch(/key/i);
  });

  it('says so when the module type is deprecated', () => {
    const m: Manifest = {
      id: 'com.example.old',
      name: 'Old Thing',
      version: '0.0.1',
      abi: 'wasm-1',
      category: 'Utilities',
      deprecated: true,
      inputs: [{ id: 'in', name: 'In' }],
      outputs: [],
      params: [],
    };
    const { unmount } = render(<DocsPanel typeId={m.id} manifest={m} onClose={() => {}} />);
    expect(screen.getByTestId('docs-deprecated').textContent).toBe('deprecated');
    unmount();
    render(<DocsPanel typeId={m.id} manifest={{ ...m, deprecated: false }} onClose={() => {}} />);
    expect(screen.queryByTestId('docs-deprecated')).toBeNull();
  });

  it('renders a fallback for unknown module types', () => {
    const m: Manifest = {
      id: 'com.example.mystery',
      name: 'Mystery',
      version: '0.0.1',
      abi: 'wasm-1',
      inputs: [{ id: 'in', name: 'In' }],
      outputs: [],
      params: [],
    };
    render(<DocsPanel typeId={m.id} manifest={m} onClose={() => {}} />);
    expect(screen.getByTestId('docs-summary').textContent).toMatch(/no documentation/i);
    // The jack table still renders from the manifest.
    expect(screen.getByTestId('docs-row-in')).toBeTruthy();
  });
});
