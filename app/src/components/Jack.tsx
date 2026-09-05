// A patch jack with an activation indicator driven by telemetry (PRD §6).
// The signal value is not printed inline — it lives in the hover tooltip
// and in the indicator color. Clicking jacks is how wires are made
// (output → input). Input cells render the jack label themselves
// (showLabel=false); output groups keep the inline label.
//
// Indicator color language (both inputs and outputs):
// - near zero      → neutral GRAY (not a dim azure/amber)
// - positive value → ramps gray → saturated AZURE (hue 210°) at +10 V
// - negative value → ramps gray → saturated AMBER (hue 45°) at −10 V
// - volatile (>10 Hz fluctuation the smoothed display can't follow)
//   → PURE RED (hue 0°), saturation/depth scaled by telemetry.volatility,
//     plus a pulsing halo. The hue split (45° amber vs 0° red) and the
//     pulse keep "negative" and "too fast to display" visually distinct.
// The displayed level uses `telemetry.display`, which the engine low-pass
// smooths over its 100 ms (10 Hz) window.

import { formatDisplay } from '../display';
import { useRackHints } from '../rackKeys';
import { safeNumber } from '../format';
import { useLiveJackTelemetry } from '../rackStore';
import type { DisplaySpec, JackTelemetry, KnobConfig } from '../types';
import { angleFor } from './Knob';

/** Volatility below this renders as an ordinary value, not an alert. */
const VOLATILE_MIN = 0.05;

/** Shape of the live readout drawn above an output jack — the hardware
 *  control the value came off (see `OutputControl` in panelLayouts). */
export type JackReadout = 'knob' | 'fader' | 'button';

/** Readouts stand for PHYSICAL controls, which put out a unipolar 0..10 V
 *  (`SIGNAL_MAX`) sweep, so that is the scale they are drawn against; a
 *  negative reading simply sits at the bottom of the travel. */
export const READOUT_FULL_SCALE = 10;

/** Gate threshold — the engine's ≥ 1 V "on", the same law switches use. */
const GATE_VOLTS = 1;

export const readoutFraction = (volts: number): number =>
  Math.min(1, Math.max(0, volts / READOUT_FULL_SCALE));

/** The live value of an output jack drawn as the control it comes off: a
 *  dial for a knob, a cap on a track for a fader, a lit pad for a button.
 *  It reads the jack's OWN telemetry (the one `Jack` already has), so a
 *  panel of them costs one subscription per jack and no panel re-render.
 *  Every kind reads `display` — the smoothed field the rack store
 *  propagates; `instantaneous` is deliberately excluded from its equality
 *  check, so a visual driven by it would only update by coincidence. */
function JackReadoutVisual({
  id,
  kind,
  telemetry,
}: {
  id: string;
  kind: JackReadout;
  telemetry: JackTelemetry | undefined;
}) {
  const volts = safeNumber(telemetry?.display);
  if (kind === 'button') {
    const on = volts >= GATE_VOLTS;
    return (
      <span
        className={`jack-readout jack-readout-pad${on ? ' jack-readout-pad-on' : ''}`}
        data-testid={`jack-readout-${id}`}
        data-on={on ? 'yes' : 'no'}
      />
    );
  }
  const level = readoutFraction(volts);
  if (kind === 'fader') {
    return (
      <span
        className="jack-readout jack-readout-fader"
        data-testid={`jack-readout-${id}`}
        data-level={level.toFixed(3)}
      >
        <span className="jack-readout-track" />
        <span className="jack-readout-cap" style={{ bottom: `${level * 100}%` }} />
      </span>
    );
  }
  return (
    <span
      className="jack-readout jack-readout-dial"
      data-testid={`jack-readout-${id}`}
      data-level={level.toFixed(3)}
    >
      <span
        className="jack-readout-pointer"
        style={{ transform: `rotate(${angleFor(level)}deg)` }}
      />
    </span>
  );
}

/** Indicator color + halo for a telemetry reading (exported for tests). */
export function indicatorStyle(telemetry: JackTelemetry | undefined): {
  volatile: boolean;
  color: string;
  halo: string;
} {
  const display = safeNumber(telemetry?.display);
  const volatility = safeNumber(telemetry?.volatility);
  if (volatility > VOLATILE_MIN) {
    // Volatile: pure red, deeper/more saturated the faster it fluctuates.
    const s = Math.round(55 + 45 * volatility);
    const l = Math.round(66 - 22 * volatility);
    const color = `hsl(0, ${s}%, ${l}%)`;
    return { volatile: true, color, halo: `0 0 10px 2px ${color}` };
  }
  // Signed value: neutral gray at 0 ramping to a saturated hue at ±10 V
  // (azure for positive, amber for negative).
  const level = Math.min(1, Math.abs(display) / 10);
  const hue = display >= 0 ? 210 : 45;
  const s = Math.round(12 + 88 * level);
  const l = Math.round(64 - 12 * level);
  const color = `hsl(${hue}, ${s}%, ${l}%)`;
  return {
    volatile: false,
    color,
    halo: `0 0 ${Math.round(3 + 8 * level)}px ${Math.round(1 + 2 * level)}px ${color}`,
  };
}

export interface JackProps {
  instance: string;
  id: string;
  kind: 'input' | 'output';
  /** Display label (defaults to the jack id). */
  label?: string;
  telemetry?: JackTelemetry;
  /** Manifest display spec for the tooltip value; absent = Volts. */
  display?: DisplaySpec | null;
  /** Knob config, used to resolve step labels for stepped inputs. */
  knob?: KnobConfig | null;
  wired?: boolean;
  selected?: boolean;
  /** Outline color while armed — the pending wire's cable color. */
  selectedColor?: string;
  onClick?(shift: boolean): void;
  showLabel?: boolean;
  /** Draw the jack's live value as the hardware control it comes off
   *  (a control surface's knobs, faders and buttons). */
  readout?: JackReadout;
}

/** A Jack subscribed to its own live telemetry: a tick re-renders only the
 *  jacks that moved, never the panel around them. `telemetry` becomes the
 *  fallback for storeless renders (docs previews, unit tests). */
export function LiveJack(props: JackProps) {
  const telemetry = useLiveJackTelemetry(
    props.instance,
    props.kind === 'output' ? `out:${props.id}` : props.id,
    props.telemetry,
  );
  return <Jack {...props} telemetry={telemetry} />;
}

export function Jack({
  instance,
  id,
  kind,
  label,
  telemetry,
  display,
  knob,
  wired,
  selected,
  selectedColor,
  onClick,
  showLabel = true,
  readout,
}: JackProps) {
  // The letter to press for this jack, on screen only while a `:w` wire
  // command is asking which one — so the panel is never littered with
  // letters, and is fully labelled the moment they matter.
  const { jackPrompt } = useRackHints();
  const hint =
    jackPrompt && jackPrompt.instance === instance && jackPrompt.kind === kind
      ? jackPrompt.jacks[id]
      : undefined;
  // `display` is typed number but crosses IPC as JSON, where a non-finite
  // f32 becomes `null` — read it defensively.
  const style = telemetry ? indicatorStyle(telemetry) : null;
  const volatile = style?.volatile ?? false;
  const tooltip = telemetry
    ? `${id}: ${formatDisplay(display, telemetry.display, knob)}${
        telemetry.is_fast ? ' (rms)' : ''
      }${volatile ? ' ⚡ >10 Hz' : ''}`
    : id;
  return (
    <button
      type="button"
      className={`jack jack-${kind}${wired ? ' jack-wired' : ''}${selected ? ' jack-selected' : ''}${
        readout ? ' jack-with-readout' : ''
      }`}
      data-testid={`jack-${kind}-${id}`}
      data-tip={tooltip}
      style={selected && selectedColor ? { outlineColor: selectedColor } : undefined}
      onClick={(e) => onClick?.(e.shiftKey)}
    >
      {readout && <JackReadoutVisual id={id} kind={readout} telemetry={telemetry} />}
      {/* The socket is the wire anchor point (data-jack), styled like a
          hardware panel jack: metal ring around a dark bore. */}
      <span className="jack-socket" data-jack={`${instance}:${kind}:${id}`}>
        <span
          className={`jack-glow${volatile ? ' jack-glow-volatile' : ''}`}
          data-testid={`jack-glow-${id}`}
          data-indicator={style?.color}
          style={style ? { background: style.color, boxShadow: style.halo } : undefined}
        />
      </span>
      {hint && (
        <span className="jack-key mono" data-testid={`jack-key-${kind}-${id}`}>
          {hint}
        </span>
      )}
      {showLabel && <span className="jack-name">{label ?? id}</span>}
    </button>
  );
}
