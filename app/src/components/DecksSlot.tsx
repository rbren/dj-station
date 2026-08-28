// One deck: a channel strip for a Beatify clip. Reading down, it is the
// order a DJ's hand works in — what is loaded, what it costs to run it at
// the bank's tempo, where it sits on the grid, then the three tone
// controls, the fader, and mute/monitor at the bottom where the thumb is.
//
// The dial/fader controls ARE the rack's own Knob (same look, same drag
// law, same tooltip): a bank's slot is a mixer channel, not a new kind of
// widget. Their values are engine units — 0..1 for the fader, 0..EQ_MAX
// for a tone control, flat at 1 — and the knob positions are the linear
// mapping of those, so a Launch Control XL knob at 12 o'clock and a dial
// pointing up mean the same thing.
//
// The strip also carries the deck's JACKS, because a deck is part of a
// rack module like any other: a send and a return (wire them and the rack
// becomes this deck's insert), and a CV out under each tone control. A
// patched tone control stops cutting its band and drives the rack
// instead, which the strip says out loud rather than leaving the knob
// looking broken.

import { Knob } from './Knob';
import { LiveJack } from './Jack';
import { StemTags } from './StemTags';
import {
  loopBeats,
  returnJack,
  sendJack,
  stretchLabel,
  toneJack,
  EQ_MAX,
  TONES,
  type DeckSlotStatus,
} from '../decks';
import type { KnobConfig } from '../types';

const FADER_CONFIG: KnobConfig = { style: 'continuous', min: 0, max: 1, curve: 'linear' };
const TONE_CONFIG: KnobConfig = { style: 'continuous', min: 0, max: EQ_MAX, curve: 'linear' };

export interface DecksSlotProps {
  slot: DeckSlotStatus;
  /** The bank this deck belongs to — its jacks are the bank's. */
  instance: string;
  onLoad(): void;
  onClear(): void;
  onControl(control: 'level' | 'high' | 'mid' | 'low', value: number): void;
  onToggle(control: 'mute' | 'monitor'): void;
  onTail(tail: number): void;
  onPhase(phase: number): void;
  onRelease(): void;
  /** Arm or complete a wire at one of this deck's jacks. */
  onJack(jack: string, kind: 'input' | 'output'): void;
  /** Whether a jack is armed as the pending wire's end. */
  isArmed(jack: string, kind: 'input' | 'output'): boolean;
  /** Whether a jack has a cable in it. */
  isWired(jack: string, kind: 'input' | 'output'): boolean;
}

export function DecksSlot(props: DecksSlotProps) {
  const { slot, instance } = props;
  const n = slot.slot + 1;
  const empty = slot.beats === 0;
  const loop = loopBeats(slot);

  const jack = (id: string, kind: 'input' | 'output', label: string) => (
    <LiveJack
      instance={instance}
      id={id}
      kind={kind}
      label={label}
      wired={props.isWired(id, kind)}
      selected={props.isArmed(id, kind)}
      onClick={() => props.onJack(id, kind)}
    />
  );

  return (
    <section
      className={`decks-slot${empty ? ' decks-slot-empty' : ''}`}
      data-testid={`decks-slot-${slot.slot}`}
      aria-label={`Deck ${n}`}
    >
      <header className="decks-slot-head">
        <span className="decks-slot-number mono">{n}</span>
        <button
          className="decks-slot-name"
          data-testid={`decks-name-${slot.slot}`}
          onClick={props.onLoad}
          title={empty ? 'Load a clip' : 'Load a different clip'}
        >
          {slot.clip?.name || 'empty'}
        </button>
        {!empty && (
          <button
            className="decks-slot-eject"
            data-testid={`decks-eject-${slot.slot}`}
            aria-label={`Eject the clip in deck ${n}`}
            onClick={props.onClear}
          >
            ⏏
          </button>
        )}
      </header>

      {/* Where the clip came from: two clips called "intro" are told
          apart by their project, not by their name. */}
      {slot.clip && (
        <p className="decks-slot-project" data-testid={`decks-project-${slot.slot}`}>
          {slot.clip.project_name || slot.clip.project}
        </p>
      )}

      <StemTags stems={slot.clip?.stems} testId={`decks-stems-${slot.slot}`} />

      <dl className="decks-slot-facts">
        <div>
          <dt>beats</dt>
          <dd className="mono" data-testid={`decks-beats-${slot.slot}`}>
            {empty ? '—' : slot.tail > 0 ? `${slot.beats} + ${slot.tail}` : `${slot.beats}`}
          </dd>
        </div>
        <div>
          <dt>clip bpm</dt>
          <dd className="mono" data-testid={`decks-source-bpm-${slot.slot}`}>
            {empty ? '—' : slot.source_bpm.toFixed(1)}
          </dd>
        </div>
        <div>
          <dt>stretch</dt>
          <dd className="mono" data-testid={`decks-stretch-${slot.slot}`}>
            {empty ? '—' : stretchLabel(slot.stretch)}
          </dd>
        </div>
      </dl>

      {!empty && !slot.loaded && (
        <p
          className="decks-slot-note decks-slot-missing"
          data-testid={`decks-missing-${slot.slot}`}
        >
          clip could not be assembled
        </p>
      )}

      {/* Every beat of the loop, silence included: a lamp row that stopped
          at sixteen lied about where a long clip was. */}
      <div
        className="decks-beats"
        data-testid={`decks-dots-${slot.slot}`}
        aria-label={empty ? 'no clip' : `beat ${slot.beat + 1} of ${loop}`}
      >
        {Array.from({ length: loop }, (_, i) => (
          <span
            key={i}
            className={`decks-beat-dot${i === slot.beat ? ' on' : ''}${
              i >= slot.beats ? ' decks-beat-tail' : ''
            }`}
          />
        ))}
      </div>

      <div className="decks-tone">
        {TONES.map((tone, i) => (
          <div className="decks-tone-cell" key={tone}>
            <Knob
              label={`${n} ${tone.toUpperCase()}`}
              config={TONE_CONFIG}
              position={slot[tone] / EQ_MAX}
              onPosition={(p) => props.onControl(tone, p * EQ_MAX)}
              onRelease={props.onRelease}
            />
            <span
              className={`decks-tone-jack${slot.tone_patched[i] ? ' is-patched' : ''}`}
              data-testid={`decks-tone-jack-${slot.slot}-${tone}`}
              data-patched={slot.tone_patched[i] ? 'yes' : 'no'}
              title={
                slot.tone_patched[i]
                  ? `deck ${n} ${tone}: driving the rack, not the ${tone} band`
                  : `deck ${n} ${tone}: cutting the ${tone} band — wire it to send it to the rack instead`
              }
            >
              {jack(toneJack(slot.slot, tone), 'output', tone)}
            </span>
          </div>
        ))}
      </div>

      <div className="decks-slot-io" data-testid={`decks-io-${slot.slot}`}>
        <span className="decks-io-label">audio out</span>
        {jack(sendJack(slot.slot, 'l'), 'output', 'L')}
        {jack(sendJack(slot.slot, 'r'), 'output', 'R')}
        <span className="decks-io-label">audio in</span>
        {jack(returnJack(slot.slot, 'l'), 'input', 'L')}
        {jack(returnJack(slot.slot, 'r'), 'input', 'R')}
      </div>
      {slot.insert && (
        <p className="decks-slot-note" data-testid={`decks-insert-${slot.slot}`}>
          through the rack
        </p>
      )}

      <div className="decks-mix">
        <Knob
          label={`${n} LEVEL`}
          config={FADER_CONFIG}
          appearance="fader"
          position={slot.level}
          onPosition={(p) => props.onControl('level', p)}
          onRelease={props.onRelease}
        />
        <div className="decks-mix-side">
          <button
            className={`decks-btn${slot.mute ? ' is-on' : ''}`}
            data-testid={`decks-mute-${slot.slot}`}
            aria-pressed={slot.mute}
            onClick={() => props.onToggle('mute')}
          >
            Mute
          </button>
          <button
            className={`decks-btn decks-btn-monitor${slot.monitor ? ' is-on' : ''}`}
            data-testid={`decks-monitor-${slot.slot}`}
            aria-pressed={slot.monitor}
            title="Play this deck through the monitor output instead of the live one"
            onClick={() => props.onToggle('monitor')}
          >
            Monitor
          </button>
          <div className="decks-step" data-testid={`decks-tail-${slot.slot}`}>
            <span className="decks-step-label">silence</span>
            <button
              aria-label={`One beat less silence after deck ${n}`}
              disabled={empty || slot.tail === 0}
              onClick={() => props.onTail(slot.tail - 1)}
            >
              −
            </button>
            <span className="decks-step-value mono">{slot.tail}</span>
            <button
              aria-label={`One more beat of silence after deck ${n}`}
              disabled={empty}
              onClick={() => props.onTail(slot.tail + 1)}
            >
              +
            </button>
          </div>
          <div className="decks-step" data-testid={`decks-phase-${slot.slot}`}>
            <span className="decks-step-label">shift</span>
            <button
              aria-label={`Shift deck ${n} back one beat`}
              disabled={empty}
              onClick={() => props.onPhase(slot.phase - 1)}
            >
              ◀
            </button>
            <span className="decks-step-value mono">{slot.phase}</span>
            <button
              aria-label={`Shift deck ${n} on one beat`}
              disabled={empty}
              onClick={() => props.onPhase(slot.phase + 1)}
            >
              ▶
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
