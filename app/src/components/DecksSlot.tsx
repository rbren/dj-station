// One deck: a channel strip for a Beatify clip. Reading down, it is the
// order a DJ's hand works in — what is loaded, what it costs to run it at
// the bank's tempo, where it sits on the grid, then the three tone
// controls, the fader, and mute/solo at the bottom where the thumb is.
//
// The dial/fader controls ARE the rack's own Knob (same look, same drag
// law, same tooltip): a bank's slot is a mixer channel, not a new kind of
// widget. Their values are engine units — 0..1 for the fader, 0..EQ_MAX
// for a tone control, flat at 1 — and the knob positions are the linear
// mapping of those, so a Launch Control XL knob at 12 o'clock and a dial
// pointing up mean the same thing.

import { Knob } from './Knob';
import { StemTags } from './StemTags';
import { alignLabel, loopBeats, stretchLabel, EQ_MAX, type DeckSlotStatus } from '../decks';
import type { KnobConfig } from '../types';

const FADER_CONFIG: KnobConfig = { style: 'continuous', min: 0, max: 1, curve: 'linear' };
const TONE_CONFIG: KnobConfig = { style: 'continuous', min: 0, max: EQ_MAX, curve: 'linear' };

/** Beat lamps stay readable rather than complete: a 64-beat clip would
 *  otherwise draw a grey smear. */
const MAX_DOTS = 16;

export interface DecksSlotProps {
  slot: DeckSlotStatus;
  /** How many slots of the bank have a clip in them — an alignment note
   *  needs something to be aligned WITH. */
  loadedSlots: number;
  onLoad(): void;
  onClear(): void;
  onControl(control: 'level' | 'high' | 'mid' | 'low', value: number): void;
  onToggle(control: 'mute' | 'solo'): void;
  onTail(tail: number): void;
  onPhase(phase: number): void;
  onRelease(): void;
}

export function DecksSlot(props: DecksSlotProps) {
  const { slot } = props;
  const n = slot.slot + 1;
  const empty = slot.beats === 0;
  const loop = loopBeats(slot);
  const align = alignLabel(slot, props.loadedSlots);

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
      {align && (
        <p
          className={`decks-slot-note${slot.aligned ? '' : ' decks-slot-adrift'}`}
          data-testid={`decks-align-${slot.slot}`}
        >
          {align}
        </p>
      )}

      <div
        className="decks-beats"
        data-testid={`decks-dots-${slot.slot}`}
        aria-label={empty ? 'no clip' : `beat ${slot.beat + 1} of ${loop}`}
      >
        {Array.from({ length: Math.min(loop, MAX_DOTS) }, (_, i) => (
          <span
            key={i}
            className={`decks-beat-dot${i === slot.beat ? ' on' : ''}${
              i >= slot.beats ? ' decks-beat-tail' : ''
            }`}
          />
        ))}
      </div>

      <div className="decks-tone">
        <Knob
          label={`${n} HIGH`}
          config={TONE_CONFIG}
          position={slot.high / EQ_MAX}
          onPosition={(p) => props.onControl('high', p * EQ_MAX)}
          onRelease={props.onRelease}
        />
        <Knob
          label={`${n} MID`}
          config={TONE_CONFIG}
          position={slot.mid / EQ_MAX}
          onPosition={(p) => props.onControl('mid', p * EQ_MAX)}
          onRelease={props.onRelease}
        />
        <Knob
          label={`${n} LOW`}
          config={TONE_CONFIG}
          position={slot.low / EQ_MAX}
          onPosition={(p) => props.onControl('low', p * EQ_MAX)}
          onRelease={props.onRelease}
        />
      </div>

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
            className={`decks-btn decks-btn-solo${slot.solo ? ' is-on' : ''}`}
            data-testid={`decks-solo-${slot.slot}`}
            aria-pressed={slot.solo}
            onClick={() => props.onToggle('solo')}
          >
            Solo
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
