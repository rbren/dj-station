// Custom panel body for the built-in MIDI module: pick which MIDI controls
// (notes/CCs) to map — a mapping's output jack only exists once it's added —
// and optionally bind a computer-keyboard key to each note mapping
// (keydown = note on, keyup = note off) so patches are playable without
// hardware MIDI.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MidiMapping } from '../engine';
import { useRackKeysActive } from '../keyScope';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(num: number): string {
  return `${NOTE_NAMES[num % 12]}${Math.floor(num / 12) - 1}`;
}

function defaultName(kind: 'note' | 'cc', num: number, taken: Set<string>): string {
  const base = kind === 'note' ? noteName(num) : `cc${num}`;
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

function loadKeys(instance: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(`dj-midi-keys:${instance}`) ?? '{}');
  } catch {
    return {};
  }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export interface MidiPanelProps {
  instance: string;
  mappings: MidiMapping[];
  /** LED feedback mappings (M4, PRD §7.1): input jacks driving note/CC out. */
  ledMappings?: MidiMapping[];
  onAdd(kind: 'note' | 'cc', num: number, name: string): void;
  onRemove(name: string): void;
  onAddLed?(kind: 'note' | 'cc', num: number, name: string): void;
  onRemoveLed?(name: string): void;
  /** Inject a raw MIDI message (used by keyboard-key bindings). */
  onMidi(data: [number, number, number]): void;
}

export function MidiPanel(props: MidiPanelProps) {
  const { instance, mappings, onAdd, onRemove, onMidi } = props;
  const ledMappings = props.ledMappings ?? [];
  const [kind, setKind] = useState<'note' | 'cc'>('note');
  const [num, setNum] = useState(60);
  const [keys, setKeys] = useState<Record<string, string>>(() => loadKeys(instance));
  const [captureFor, setCaptureFor] = useState<string | null>(null);
  // Keys currently held down, so OS key-repeat doesn't retrigger notes.
  const held = useRef<Set<string>>(new Set());

  const saveKeys = useCallback(
    (next: Record<string, string>) => {
      setKeys(next);
      try {
        localStorage.setItem(`dj-midi-keys:${instance}`, JSON.stringify(next));
      } catch {
        // localStorage unavailable — bindings just won't persist.
      }
    },
    [instance],
  );

  // Key bindings are rack-page-scoped: on other pages the listeners come
  // off and anything held sends its note-off now (the keyup will land
  // where we no longer listen, so waiting for it would stick notes on).
  const active = useRackKeysActive();

  useEffect(() => {
    if (!active) {
      for (const key of held.current) {
        for (const m of mappings) {
          if (m.kind === 'note' && keys[m.name] === key) onMidi([0x80, m.num, 0]);
        }
      }
      held.current.clear();
      return;
    }
    const down = (e: KeyboardEvent) => {
      if (captureFor) {
        e.preventDefault();
        if (e.key !== 'Escape') {
          saveKeys({ ...keys, [captureFor]: e.key.toLowerCase() });
        }
        setCaptureFor(null);
        return;
      }
      if (e.repeat || isTyping(e.target) || held.current.has(e.key.toLowerCase())) return;
      const key = e.key.toLowerCase();
      for (const m of mappings) {
        if (m.kind === 'note' && keys[m.name] === key) {
          held.current.add(key);
          onMidi([0x90, m.num, 100]);
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!held.current.delete(key)) return;
      for (const m of mappings) {
        if (m.kind === 'note' && keys[m.name] === key) {
          onMidi([0x80, m.num, 0]);
        }
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [active, captureFor, keys, mappings, onMidi, saveKeys]);

  const add = () => {
    const taken = new Set(mappings.map((m) => m.name));
    onAdd(kind, num, defaultName(kind, num, taken));
  };

  return (
    <div className="midi-panel" data-testid={`midi-panel-${instance}`}>
      {mappings.length === 0 && (
        <p className="midi-empty">No controls mapped — add a note or CC below.</p>
      )}
      {mappings.map((m) => (
        <div className="midi-mapping" key={m.name} data-testid={`midi-mapping-${m.name}`}>
          <span className="midi-mapping-name">{m.name}</span>
          <span className="midi-mapping-src">
            {m.kind === 'note' ? `note ${m.num}` : `cc ${m.num}`}
          </span>
          {m.kind === 'note' && (
            <button
              type="button"
              className={`midi-key${captureFor === m.name ? ' midi-key-capture' : ''}`}
              data-testid={`midi-key-${m.name}`}
              data-tip="Bind a computer-keyboard key: hold to send note on"
              onClick={() => setCaptureFor(captureFor === m.name ? null : m.name)}
            >
              {captureFor === m.name ? 'press a key…' : (keys[m.name] ?? 'set key')}
            </button>
          )}
          <button
            type="button"
            className="midi-remove"
            data-testid={`midi-remove-${m.name}`}
            data-tip="Remove mapping (and its wires)"
            onClick={() => onRemove(m.name)}
          >
            ×
          </button>
        </div>
      ))}
      <div className="midi-add">
        <select
          value={kind}
          data-testid="midi-add-kind"
          onChange={(e) => setKind(e.target.value as 'note' | 'cc')}
        >
          <option value="note">note</option>
          <option value="cc">cc</option>
        </select>
        <input
          type="number"
          min={0}
          max={127}
          value={num}
          data-testid="midi-add-num"
          onChange={(e) => setNum(Math.min(127, Math.max(0, Number(e.target.value) || 0)))}
        />
        <span className="midi-add-preview">{kind === 'note' ? noteName(num) : `cc${num}`}</span>
        <button type="button" data-testid="midi-add" onClick={add}>
          + map
        </button>
        {props.onAddLed && (
          <button
            type="button"
            data-testid="midi-add-led"
            data-tip="Add an LED feedback mapping: an input jack whose signal drives this note/CC back out to the controller"
            onClick={() => {
              const taken = new Set(ledMappings.map((m) => m.name.replace(/^led_/, '')));
              props.onAddLed?.(kind, num, `led_${defaultName(kind, num, taken)}`);
            }}
          >
            + LED
          </button>
        )}
      </div>
      {ledMappings.length > 0 && (
        <div className="midi-leds" data-testid={`midi-leds-${instance}`}>
          <span className="midi-leds-title">LED out</span>
          {ledMappings.map((m) => (
            <div className="midi-mapping" key={m.name} data-testid={`midi-led-${m.name}`}>
              <span className="midi-mapping-name">{m.name}</span>
              <span className="midi-mapping-src">
                {m.kind === 'note' ? `note ${m.num}` : `cc ${m.num}`}
              </span>
              <button
                type="button"
                className="midi-remove"
                data-testid={`midi-led-remove-${m.name}`}
                data-tip="Remove LED mapping (and wires into its jack)"
                onClick={() => props.onRemoveLed?.(m.name)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
