// One deck: a channel strip for a beat clip. Reading down, it is the
// order a DJ's hand works in — what is loaded, what it costs to run it at
// the bank's tempo, where it sits on the grid, then the three tone
// controls, the fader, and mute/monitor — with queue/drop, the same mute
// taken on the bank's grid — at the bottom where the thumb is. The tone
// row is a mixer's EQ column laid on its side, so it reads RIGHT TO LEFT
// (low, mid, high from the left); the surface's rows stay high on top.
//
// THE BPM IS A BUTTON: clicking it runs this deck at a RATIO of the
// bank's grid (×2 double time, ×1/2 half time, ×1 back to normal). The
// ratio moves the deck's BASELINE tempo — the label shows the tempo its
// grid is read at, so a 140 bpm clip in double time reads "70 bpm ×2"
// and the stretch beside it is what the audio is really doing — and it
// is engine state, so it rides in the patch with the rest of the deck.
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
// and IN (its return), one mono cable each: wire the out through rack
// modules and back into the in, and those modules become the deck's
// insert. The WET knob beside them is how much of that insert is heard —
// 0 leaves the deck dry, which is a bypass in everything but name — and
// the small M cues what came back into the monitor, so the rack's answer
// can be auditioned while the room keeps the deck. Each tone knob
// carries a CV jack too; wiring one takes the knob OFF the band (it sits
// flat) and makes it drive the connected module instead, which the strip
// says out loud rather than leaving the knob looking broken. The jacks
// are the REAL bank jacks (`data-jack` on the bank instance) — the same
// wire overlay and click-to-wire grammar the Rack tab uses.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Knob } from './Knob';
import { LiveJack } from './Jack';
import { StemTags } from './StemTags';
import {
  baselineBpm,
  beatGridLayout,
  bpmLabel,
  clipParts,
  clipTitle,
  deckGlow,
  isNormalRatio,
  loopBeats,
  phaseForBeat,
  ratioLabel,
  returnJack,
  sendJack,
  stretchLabel,
  toneJack,
  BEAT_FIELD_HEIGHT,
  BEAT_FIELD_WIDTH,
  DECK_RATIOS,
  EQ_MAX,
  LEVEL_MAX,
  LEVEL_UNITY,
  TONES,
  TONES_ACROSS,
  WET_MAX,
  type DeckArm,
  type DeckSlotStatus,
} from '../decks';
import type { KnobConfig } from '../types';

const FADER_CONFIG: KnobConfig = { style: 'continuous', min: 0, max: LEVEL_MAX, curve: 'linear' };
const TONE_CONFIG: KnobConfig = { style: 'continuous', min: 0, max: EQ_MAX, curve: 'linear' };
const WET_CONFIG: KnobConfig = { style: 'continuous', min: 0, max: WET_MAX, curve: 'linear' };

export interface DecksSlotProps {
  slot: DeckSlotStatus;
  /** The bank this deck belongs to — its jacks are the bank's. */
  instance: string;
  onLoad(): void;
  onClear(): void;
  onControl(control: 'level' | 'high' | 'mid' | 'low' | 'wet', value: number): void;
  onToggle(control: 'mute' | 'monitor' | 'insert_monitor'): void;
  /** Queue or drop this deck on the bank's grid; 'none' takes it back. */
  onArm(arm: DeckArm): void;
  onTail(tail: number): void;
  onPhase(phase: number): void;
  /** Where the bank's beat counter stands AT THE MOMENT IT IS CALLED —
   *  the poll's reading carried forward at the bank's tempo, since a
   *  press means "now" and a reading can be a poll old. Clicking SFT
   *  turns it into a shift. */
  beatNow(): number;
  /** Run this deck at a ratio of the bank's grid (2 = double time). */
  onRatio(ratio: number): void;
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
  const grid = beatGridLayout(loop);
  // The clip's downbeats, as beats of the bank's grid — the engine has
  // already taken them through the deck's ratio, like the beat count.
  const ones = new Set(slot.ones);
  const parts = clipParts(slot.clip);
  // The ratio menu, the strip's one piece of local state: which deck is
  // in double time is the engine's, whether its menu is open is not. The
  // corner is taken off the label when it is clicked — the menu is a
  // portal, so it needs a place on the page rather than in the strip.
  const [ratioAt, setRatioAt] = useState<{ left: number; top: number } | null>(null);
  const ratioed = !isNormalRatio(slot.ratio);
  // The strip lights up with what this deck is putting out. The reading
  // is the ENGINE's — the deck's own peak over roughly the last second,
  // decaying — so the tint jumps with the music and falls back to the
  // strip's black on its own when the deck is muted, drops, or plays a
  // silent beat: nothing here has to decide when the green ends.
  const glow = deckGlow(slot.output_level);

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
      style={{ '--deck-level': glow.toFixed(3) } as CSSProperties}
    >
      {/* The deck's patch points, at the very top where the cables from
          the rack canvas arrive: OUT is the deck's audio (its send), IN
          brings the answer back and makes those modules the deck's
          insert — one cable each way. Beside them the two controls that
          say what happens to that answer: how much of it is heard, and
          whether it is cued into the monitor. */}
      <div className="decks-slot-io" data-testid={`decks-io-${slot.slot}`}>
        <span className="decks-io-label" title={`Deck ${n} out`}>
          ↑
        </span>
        {jack(sendJack(slot.slot), 'output')}
        <span className="decks-io-label" title={`Deck ${n} in`}>
          ↓
        </span>
        {jack(returnJack(slot.slot), 'input')}
        <span className="decks-io-wet">
          <Knob
            label={`${n} WET`}
            config={WET_CONFIG}
            position={slot.wet / WET_MAX}
            onPosition={(p) => props.onControl('wet', p * WET_MAX)}
            onRelease={props.onRelease}
          />
        </span>
        <button
          className={`decks-btn decks-btn-square decks-btn-monitor${
            slot.insert_monitor ? ' is-on' : ''
          }`}
          data-testid={`decks-insert-monitor-${slot.slot}`}
          aria-pressed={slot.insert_monitor}
          aria-label={`Cue deck ${n}'s insert into the monitor`}
          title="Hear what comes back in the monitor; the deck keeps playing where it was"
          onClick={() => props.onToggle('insert_monitor')}
        >
          M
        </button>
      </div>

      {/* What is in the deck, and nothing else on the lines: the project
          the clip was cut in ABOVE the clip's own name, plain text rather
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
                <span className="decks-slot-project" data-testid={`decks-project-${slot.slot}`}>
                  {parts.project}
                </span>
              )}
              <span className="decks-slot-clip" data-testid={`decks-clip-${slot.slot}`}>
                {parts.name}
              </span>
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
          {/* Short form: the spelled-out parts wrap in a 156 px column,
              and a wrapped tag row takes the eject button with it. */}
          <StemTags stems={slot.clip?.stems} testId={`decks-stems-${slot.slot}`} short />
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

      {/* What the clip costs at the bank's tempo: the baseline this deck
          reads its grid at and the stretch to get here, one line. The
          length is the lamp row below — counting it twice said nothing
          new. The BPM half is a button: clicking it runs the deck at a
          ratio of the bank's grid (double time and friends), which is
          the same number said differently — a deck at ×2 reads a 140 bpm
          clip as 70, so its beats come round twice as often. */}
      <p className="decks-slot-tempo mono" data-testid={`decks-tempo-${slot.slot}`}>
        {empty ? (
          '—'
        ) : (
          <>
            <button
              className={`decks-slot-bpm${ratioed ? ' is-ratioed' : ''}`}
              data-testid={`decks-bpm-${slot.slot}`}
              aria-haspopup="menu"
              aria-expanded={ratioAt !== null}
              title={
                ratioed
                  ? `Cut at ${Number(slot.source_bpm.toFixed(1))} bpm, run at ×${ratioLabel(
                      slot.ratio,
                    )} — its grid reads as ${Number(
                      baselineBpm(slot.source_bpm, slot.ratio).toFixed(1),
                    )} bpm, so its beats come round ×${ratioLabel(
                      slot.ratio,
                    )} as often as the other decks'`
                  : "Run this deck at a ratio of the bank's grid"
              }
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setRatioAt((open) => (open ? null : { left: box.left, top: box.bottom }));
              }}
            >
              {bpmLabel(slot.source_bpm, slot.ratio)}
            </button>{' '}
            {stretchLabel(slot.stretch)}
          </>
        )}
      </p>
      {ratioAt && !empty && (
        <RatioMenu
          deck={n}
          at={ratioAt}
          ratio={slot.ratio}
          onPick={props.onRatio}
          onClose={() => setRatioAt(null)}
        />
      )}

      {!empty && !slot.loaded && (
        <p
          className="decks-slot-note decks-slot-missing"
          data-testid={`decks-missing-${slot.slot}`}
        >
          clip could not be assembled
        </p>
      )}

      {/* Every beat of the loop, silence included, IN THE CLIP'S OWN
          ORDER: a lamp row that stopped at sixteen lied about where a
          long clip was, and one rotated by the shift would stop being a
          picture of the clip. The lamps fill a FIELD of fixed size — rows
          of a power of two, lamps grown or shrunk to fit it — so a 4-beat
          clip and a 1024-beat one take the same space and nothing below
          moves when one replaces the other. The bare number beside the
          field is the same total, silence included, for when the lamps
          are too small to count.

          The clip's ONES are marked in the row: every downbeat its grid
          knows about, and the one this deck is LINED UP BY in green. That
          is the clip's first one where a load left it — a load puts it on
          the bank's downbeat — and shifting the deck moves the green to
          whichever one now comes round first, because that is the one the
          rest of the bank is hearing it on. */}
      <div className="decks-beats-row">
        <div
          className="decks-beats"
          data-testid={`decks-dots-${slot.slot}`}
          aria-label={empty ? 'no clip' : `beat ${slot.beat + 1} of ${loop}`}
          style={
            {
              '--beat-field-w': `${BEAT_FIELD_WIDTH}px`,
              '--beat-field-h': `${BEAT_FIELD_HEIGHT}px`,
              '--beat-cols': grid.cols,
              '--beat-cell': `${grid.cell}px`,
              '--beat-gap': `${grid.gap}px`,
            } as CSSProperties
          }
        >
          {Array.from({ length: loop }, (_, i) => {
            const one = ones.has(i);
            const lead = i === slot.lead_one;
            return (
              <span
                key={i}
                className={`decks-beat-dot${i === slot.beat ? ' on' : ''}${
                  i >= slot.beats ? ' decks-beat-tail' : ''
                }${one ? ' decks-beat-one' : ''}${lead ? ' decks-beat-lead-one' : ''}`}
                data-one={one ? (lead ? 'lead' : 'yes') : undefined}
                title={
                  lead
                    ? `Beat ${i + 1}: the one this deck is lined up by`
                    : one
                      ? `Beat ${i + 1}: a one`
                      : undefined
                }
              />
            );
          })}
        </div>
        {!empty && (
          <span className="decks-beats-count" data-testid={`decks-beat-count-${slot.slot}`}>
            {loop}
          </span>
        )}
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
          {/* The label is the third way to shift a deck, and the one a
              hand can use in time: TAP IT ON THE BEAT the clip should
              start on and the deck's first beat moves to the nearest beat
              of the bank's grid — the arrows either side stay the beat-
              at-a-time trim. */}
          <div className="decks-step" data-testid={`decks-phase-${slot.slot}`}>
            <button
              className="decks-step-label"
              data-testid={`decks-phase-now-${slot.slot}`}
              disabled={empty}
              aria-label={`Put deck ${n}'s first beat on the beat nearest this click`}
              title="Shift: where this deck sits on the bank's grid, in beats — click on the beat you want this deck to start on"
              onClick={() => props.onPhase(phaseForBeat(slot, props.beatNow()))}
            >
              SFT
            </button>
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

/** The BPM label's menu: the ratios a deck can run at against the bank's
 *  grid, with the one it is on ticked. Rendered in a PORTAL at the
 *  label's own corner, because the strip row scrolls (`overflow: auto`)
 *  and an in-flow menu would be cut off at the dock's edge — the same
 *  reason the knob's config menu is a portal. Closes on Escape, on an
 *  outside press, and on a choice. */
function RatioMenu({
  deck,
  at,
  ratio,
  onPick,
  onClose,
}: {
  deck: number;
  /** The corner of the label the menu hangs under, in page coordinates. */
  at: { left: number; top: number };
  ratio: number;
  onPick(ratio: number): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [close]);

  return createPortal(
    <div
      ref={ref}
      className="decks-ratio-menu"
      role="menu"
      aria-label={`Tempo ratio for deck ${deck}`}
      data-testid={`decks-ratio-menu-${deck - 1}`}
      style={{ left: at.left, top: at.top }}
    >
      {DECK_RATIOS.map((option) => {
        const on = Math.abs(option.value - ratio) < 1e-4;
        return (
          <button
            key={option.label}
            role="menuitemradio"
            aria-checked={on}
            className={`decks-ratio-item${on ? ' is-on' : ''}`}
            data-testid={`decks-ratio-${deck - 1}-${option.label}`}
            title={`Deck ${deck}: ${option.hint}`}
            onClick={() => {
              onPick(option.value);
              close();
            }}
          >
            <span className="mono">×{option.label}</span>
            <span className="decks-ratio-hint">{option.hint}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
