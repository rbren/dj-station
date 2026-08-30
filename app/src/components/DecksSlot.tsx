// One deck: a channel strip for a Beatify clip. Reading down, it is the
// order a DJ's hand works in — what is loaded, what it costs to run it at
// the bank's tempo, where it sits on the grid, then the three tone
// controls, the fader, and mute/monitor — with queue/drop, the same mute
// taken on the bank's grid — at the bottom where the thumb is. The tone
// row is a mixer's EQ column laid on its side, so it reads RIGHT TO LEFT
// (low, mid, high from the left); the surface's rows stay high on top.
//
// The dial/fader controls ARE the rack's own Knob (same look, same drag
// law, same tooltip): a bank's slot is a mixer channel, not a new kind of
// widget. Their values are engine units — 0..LEVEL_MAX for the fader,
// 0..EQ_MAX for a tone control, and BOTH are unity/flat at 1, halfway
// along the travel — and the knob positions are the linear mapping of
// those, so a Launch Control XL fader at its midpoint, a dial pointing up
// and a cap halfway up all mean the same thing.
//
// The strip is also the bank's PATCH BAY for this deck — chrome over the
// rack canvas below it. At the top sit the deck's audio OUT (its send)
// and IN (its return): wire the out through rack modules and back into
// the in, and those modules become the deck's insert. Each tone knob
// carries a CV jack too; wiring one takes the knob OFF the band (it sits
// flat) and makes it drive the connected module instead, which the strip
// says out loud rather than leaving the knob looking broken. The jacks
// are the REAL bank jacks (`data-jack` on the bank instance) — the same
// wire overlay and click-to-wire grammar the Rack tab uses.

import { Knob } from './Knob';
import { LiveJack } from './Jack';
import { StemTags } from './StemTags';
import {
  clipParts,
  clipTitle,
  loopBeats,
  returnJack,
  sendJack,
  tempoLabel,
  toneJack,
  EQ_MAX,
  LEVEL_MAX,
  LEVEL_UNITY,
  TONES,
  TONES_ACROSS,
  type DeckArm,
  type DeckSlotStatus,
} from '../decks';
import type { KnobConfig } from '../types';

const FADER_CONFIG: KnobConfig = { style: 'continuous', min: 0, max: LEVEL_MAX, curve: 'linear' };
const TONE_CONFIG: KnobConfig = { style: 'continuous', min: 0, max: EQ_MAX, curve: 'linear' };

export interface DecksSlotProps {
  slot: DeckSlotStatus;
  /** The bank this deck belongs to — its jacks are the bank's. */
  instance: string;
  onLoad(): void;
  onClear(): void;
  onControl(control: 'level' | 'high' | 'mid' | 'low', value: number): void;
  onToggle(control: 'mute' | 'monitor'): void;
  /** Queue or drop this deck on the bank's grid; 'none' takes it back. */
  onArm(arm: DeckArm): void;
  onTail(tail: number): void;
  onPhase(phase: number): void;
  onRelease(): void;
  /** Arm/complete/unplug a wire at one of this deck's jacks (the Rack
   *  tab's own jack-click grammar; shift unplugs). */
  onJack(jack: string, kind: 'input' | 'output', shift: boolean): void;
  /** Whether a jack is armed as the pending wire's end. */
  isArmed(jack: string, kind: 'input' | 'output'): boolean;
  /** Whether a jack has a cable in it. */
  isWired(jack: string, kind: 'input' | 'output'): boolean;
  /** Outline color for an armed jack — the pending cable's color. */
  armedColor?: string;
}

export function DecksSlot(props: DecksSlotProps) {
  const { slot, instance } = props;
  const n = slot.slot + 1;
  const empty = slot.beats === 0;
  const loop = loopBeats(slot);
  const parts = clipParts(slot.clip);

  // A jack with no label of its own is a bare socket: the send/return
  // pair is named once by the arrow beside it, not four times over.
  const jack = (id: string, kind: 'input' | 'output', label?: string) => (
    <LiveJack
      instance={instance}
      id={id}
      kind={kind}
      label={label}
      showLabel={label !== undefined}
      wired={props.isWired(id, kind)}
      selected={props.isArmed(id, kind)}
      selectedColor={props.armedColor}
      onClick={(shift) => props.onJack(id, kind, shift)}
    />
  );

  return (
    <section
      className={`decks-slot${empty ? ' decks-slot-empty' : ''}`}
      data-testid={`decks-slot-${slot.slot}`}
      aria-label={`Deck ${n}`}
    >
      {/* The deck's patch points, at the very top where the cables from
          the rack canvas arrive: OUT is the deck's audio (its send), IN
          brings the rack's answer back and makes it the deck's insert. */}
      <div className="decks-slot-io" data-testid={`decks-io-${slot.slot}`}>
        <span className="decks-io-label" title={`Deck ${n} out`}>
          ↑
        </span>
        {jack(sendJack(slot.slot, 'l'), 'output')}
        {jack(sendJack(slot.slot, 'r'), 'output')}
        <span className="decks-io-label" title={`Deck ${n} in`}>
          ↓
        </span>
        {jack(returnJack(slot.slot, 'l'), 'input')}
        {jack(returnJack(slot.slot, 'r'), 'input')}
        {slot.insert && (
          <span className="decks-slot-note" data-testid={`decks-insert-${slot.slot}`}>
            through the rack
          </span>
        )}
      </div>

      {/* What is in the deck, and nothing else on the line: the project
          the clip was cut in and the clip's own name, plain text rather
          than a box, each truncated on its own so neither one can push
          the other off the strip. */}
      <header className="decks-slot-head">
        <button
          className="decks-slot-name"
          data-testid={`decks-name-${slot.slot}`}
          onClick={props.onLoad}
          title={empty ? 'Load a clip' : `${clipTitle(slot.clip)} — load a different clip`}
        >
          {parts ? (
            <>
              {parts.project && (
                <>
                  <span className="decks-slot-project">{parts.project}</span>
                  <span className="decks-slot-sep" aria-hidden="true">
                    {' - '}
                  </span>
                </>
              )}
              <span className="decks-slot-clip">{parts.name}</span>
            </>
          ) : (
            'empty'
          )}
        </button>
      </header>

      {/* What the clip is made of, with eject at the end of the same row:
          taking the clip out is the smallest thing on the strip, so it
          rides with the tags rather than owning a line. */}
      {!empty && (
        <div className="decks-slot-tags" data-testid={`decks-tag-row-${slot.slot}`}>
          <StemTags stems={slot.clip?.stems} testId={`decks-stems-${slot.slot}`} />
          <button
            className="decks-slot-eject"
            data-testid={`decks-eject-${slot.slot}`}
            aria-label={`Eject the clip in deck ${n}`}
            title={`Eject the clip in deck ${n}`}
            onClick={props.onClear}
          >
            ⏏
          </button>
        </div>
      )}

      {/* What the clip costs at the bank's tempo: the tempo it was cut at
          and the stretch to get here, one line. The length is the lamp
          row below — counting it twice said nothing new. */}
      <p className="decks-slot-tempo mono" data-testid={`decks-tempo-${slot.slot}`}>
        {empty ? '—' : tempoLabel(slot.source_bpm, slot.stretch)}
      </p>

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
        {TONES_ACROSS.map((tone) => {
          const patched = slot.tone_patched[TONES.indexOf(tone)];
          return (
            <div className="decks-tone-cell" key={tone}>
              <Knob
                label={`${n} ${tone.toUpperCase()}`}
                config={TONE_CONFIG}
                position={slot[tone] / EQ_MAX}
                onPosition={(p) => props.onControl(tone, p * EQ_MAX)}
                onRelease={props.onRelease}
              />
              {/* The knob's CV jack: wired, the knob leaves the band (it
                  sits flat) and drives the connected module instead. */}
              <span
                className={`decks-tone-jack${patched ? ' is-patched' : ''}`}
                data-testid={`decks-tone-jack-${slot.slot}-${tone}`}
                data-patched={patched ? 'yes' : 'no'}
                title={
                  patched
                    ? `deck ${n} ${tone}: driving the rack, not the ${tone} band`
                    : `deck ${n} ${tone}: cutting the ${tone} band — wire it to send it to the rack instead`
                }
              >
                {jack(toneJack(slot.slot, tone), 'output', tone)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="decks-mix">
        {/* Unity is MID-TRAVEL: halfway up is the clip exactly as it was
            imported and the half above it is boost, so a clip cut quiet
            can be lifted instead of only cut. Double-click comes back to
            unity. */}
        <Knob
          label={`${n} LEVEL`}
          config={FADER_CONFIG}
          appearance="fader"
          position={slot.level / LEVEL_MAX}
          onPosition={(p) => props.onControl('level', p * LEVEL_MAX)}
          onReset={() => props.onControl('level', LEVEL_UNITY)}
          onRelease={props.onRelease}
        />
        <div className="decks-mix-side">
          <div className="decks-btn-row">
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
          </div>
          {/* Mute, on the bank's grid instead of under the finger: Queue
              starts the deck the next time its clip's own first beat
              comes round, Drop lets it play its clip out first. Either
              press again to take it back. */}
          <div className="decks-btn-row">
            <button
              className={`decks-btn decks-btn-arm${slot.arm === 'queue' ? ' is-armed' : ''}`}
              data-testid={`decks-queue-${slot.slot}`}
              aria-pressed={slot.arm === 'queue'}
              disabled={empty || (slot.arm !== 'queue' && !slot.mute)}
              title="Start this deck the next time its first beat comes round"
              onClick={() => props.onArm(slot.arm === 'queue' ? 'none' : 'queue')}
            >
              {slot.arm === 'queue' ? 'Queued' : 'Queue'}
            </button>
            <button
              className={`decks-btn decks-btn-arm${slot.arm === 'drop' ? ' is-armed' : ''}`}
              data-testid={`decks-drop-${slot.slot}`}
              aria-pressed={slot.arm === 'drop'}
              disabled={empty || (slot.arm !== 'drop' && slot.mute)}
              title="Stop this deck once its clip has played its last beat"
              onClick={() => props.onArm(slot.arm === 'drop' ? 'none' : 'drop')}
            >
              {slot.arm === 'drop' ? 'Dropping' : 'Drop'}
            </button>
          </div>
          {/* Both steppers are the same four columns, so the label may be
              short (its title says the whole word) and the buttons still
              stand in one pair of lines down the strip. */}
          <div className="decks-step" data-testid={`decks-tail-${slot.slot}`}>
            <span className="decks-step-label" title="Silence: beats of rest after the clip">
              SIL
            </span>
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
            <span
              className="decks-step-label"
              title="Shift: where this deck sits on the bank's grid, in beats"
            >
              SFT
            </span>
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
