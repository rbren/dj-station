// Decks bank bridge over Tauri IPC: the eight clip slots the Decks tab
// draws, what is in them and how they are mixed. Mirrors
// `app/src-tauri/src/decks.rs`; like every client here it resolves to null
// outside Tauri so the UI stays testable headless (tests inject a mock).

import { IpcClient } from './ipc';
import type { BeatClipRef } from './beatClip';

/** The rack module a bank IS. */
export const DECKS_TYPE = 'builtin.decks';

/** Module types the Decks tab draws NO PANEL for: the bank (the chrome
 *  IS the bank) and the two output modules `decks_ensure` keeps its
 *  pairs wired to — where the bank comes out is implied, so an Audio
 *  Output or Monitor Output box in the decks rack is furniture. The
 *  modules stay in the patch and keep playing; only their panels are
 *  skipped. */
export const DECKS_HIDDEN_TYPES = new Set([DECKS_TYPE, 'builtin.audio_out', 'builtin.monitor_out']);

export const DECK_SLOTS = 8;

/** Full scale of a tone control: 0 kills the band, 1 is flat, 2 is +6 dB
 *  (mirrors `EQ_MAX` in crates/dj-engine/src/decks.rs). */
export const EQ_MAX = 2;

/** A slot's level, in gain: 1 is the clip exactly as imported and sits at
 *  the MIDDLE of the fader (like a tone control's flat), so the top half
 *  is up to +6 dB for a clip cut quiet. Double-clicking the fader comes
 *  back here. Mirrors `LEVEL_UNITY`/`LEVEL_MAX` in
 *  crates/dj-engine/src/decks.rs; a level saved before the travel opened
 *  up is the same multiplier and plays the same, its fader just sits
 *  lower. */
export const LEVEL_UNITY = 1;
export const LEVEL_MAX = 2;

export const MIN_BPM = 20;
export const MAX_BPM = 300;

/** How fast "smooth" walks the bank's ACTUAL tempo to the target the box
 *  asks for: a tempo change is a move, not a jump, so a floor is never
 *  asked to notice it. */
export const SMOOTH_BPM_PER_SEC = 1;

/** One step of that walk: where the actual tempo stands `secs` after it
 *  was at `actual`, moving toward `target` and never past it. */
export function rampBpm(actual: number, target: number, secs: number): number {
  const step = SMOOTH_BPM_PER_SEC * Math.max(0, secs);
  if (Math.abs(target - actual) <= step) return target;
  return actual + Math.sign(target - actual) * step;
}

/** One of a slot's controls: the six a Launch Control XL column carries,
 *  plus the two on the strip's insert row — how much of the insert is
 *  heard, and whether it is cued into the monitor. */
export type SlotControl =
  'level' | 'high' | 'mid' | 'low' | 'mute' | 'monitor' | 'wet' | 'insert_monitor';

/** The insert's mix knob, 0..1: 0 is the deck dry (whatever is in its
 *  loop effectively bypassed) and 1 is only what came back. */
export const WET_MAX = 1;

/** A quantized start or stop the bank's clock is still holding (mirrors
 *  `DeckArm` in crates/dj-engine/src/decks.rs): a queued deck comes in
 *  when its clip's own first beat next comes round, a dropping one plays
 *  its clip out first. */
export type DeckArm = 'none' | 'queue' | 'drop';

/** The bank's own jacks, by name (mirrors `decks_manifest`). A deck's
 *  SEND carries its audio out to the rack summed to mono and its RETURN
 *  brings the rack's answer back — one cable each way; the three tone
 *  controls each have a CV out. */
export const CLOCK_JACK = 'clock';
/** The bank's two output pairs: the room, and the headphones a deck's
 *  Monitor button cues into. Each carries a master fader; neither has a
 *  chrome jack (`audio_l/r` and `mon_l/r` stay wired to the implied
 *  output modules by `decks_ensure`). */
export const MASTER_BUSES = ['live', 'monitor'] as const;
export type MasterBus = (typeof MASTER_BUSES)[number];
export const sendJack = (slot: number) => `d${slot + 1}_out`;
export const returnJack = (slot: number) => `d${slot + 1}_in`;
/** The tone controls of a strip, top to bottom — the order the surface's
 *  three knob rows are in. */
export const TONES = ['high', 'mid', 'low'] as const;
export type Tone = (typeof TONES)[number];
/** The same three ACROSS a strip: that column of knobs laid on its side,
 *  so the row reads right to left — low, mid, high from the left, high
 *  still the one the surface's top row drives. */
export const TONES_ACROSS: readonly Tone[] = [...TONES].reverse();
export const toneJack = (slot: number, tone: Tone) => `d${slot + 1}_${tone}`;

export interface DeckSlotStatus {
  slot: number;
  clip: BeatClipRef | null;
  /** Whether the audio behind the binding is in hand yet. */
  loaded: boolean;
  /** The clip's length in the BANK's beats — its own beats over the
   *  deck's ratio, so a double-time deck's 8-beat clip is 4. */
  beats: number;
  tail: number;
  phase: number;
  /** The tempo the clip was rendered at. */
  source_bpm: number;
  /** How fast this deck runs against the rest of the bank: 1 is the clip
   *  on the bank's grid, 2 double time, 0.5 half time. */
  ratio: number;
  /** How fast the audio is actually read, the ratio included: bank tempo
   *  over the deck's baseline; 1 plays the clip as rendered. */
  stretch: number;
  /** Gain: `LEVEL_UNITY` is the clip as imported, `LEVEL_MAX` boosted. */
  level: number;
  low: number;
  mid: number;
  high: number;
  mute: boolean;
  /** On the monitor pair instead of the live mix (the cue button). */
  monitor: boolean;
  /** How much of the insert is heard: 0 is the deck dry, 1 only what
   *  came back. */
  wet: number;
  /** Whether what came back is cued into the monitor pair as well. */
  insert_monitor: boolean;
  /** Whether the deck's return is wired — the modules feeding it are its
   *  insert, and its wetness knob has something to fade into. */
  insert: boolean;
  /** Which tone controls have left the deck for the rack, in TONES
   *  order: a patched one is a CV source and stops cutting its band. */
  tone_patched: [boolean, boolean, boolean];
  duration_secs: number;
  position_secs: number;
  /** Beat of the slot's LOOP the playhead is on, silence included; -1
   *  when the slot holds nothing. */
  beat: number;
  /** Whether the playhead is inside the clip rather than its silence. */
  sounding: boolean;
  playing: boolean;
  /** How loud this deck's output has peaked over roughly the last second
   *  — a maximum in engine units, decayed exponentially by the engine, so
   *  a mute, a drop or a silent beat fades it to 0. */
  output_level: number;
  /** A queue or drop the bank's clock is still holding; the mute above is
   *  already where the deck is going. */
  arm: DeckArm;
}

export interface DecksStatus {
  bpm: number;
  /** Whether the bank's clock is running: a stopped bank is parked on
   *  beat 0 and silent, whatever its slots hold. */
  running: boolean;
  /** Fractional beats since the bank last restarted. */
  beat: number;
  /** Beats until every loaded slot comes round together. */
  cycle_beats: number;
  /** Whether this bank follows the Launch Control XL. */
  surface: boolean;
  /** Whether a surface is plugged in at all. */
  surface_connected: boolean;
  /** The fader on the live pair (1 = unity). */
  master_live: number;
  /** The fader on the monitor pair. */
  master_monitor: number;
  slots: DeckSlotStatus[];
}

/** What the Decks page needs; the Tauri client below implements it and
 *  tests substitute a mock. */
export interface DecksApi {
  banks(): Promise<string[] | null>;
  /** The bank the page drives, creating and wiring one if the patch has
   *  none. Resolves to its instance id. */
  ensure(): Promise<string | null>;
  status(instance: string): Promise<DecksStatus | null>;
  load(instance: string, slot: number, clipId: string): Promise<void | null>;
  clear(instance: string, slot: number): Promise<void | null>;
  setControl(
    instance: string,
    slot: number,
    control: SlotControl,
    value: number,
  ): Promise<void | null>;
  /** The fader on one of the bank's two output pairs. */
  setMaster(instance: string, bus: MasterBus, value: number): Promise<void | null>;
  /** Queue/drop a deck on the bank's grid; 'none' takes an arm back. */
  arm(instance: string, slot: number, arm: DeckArm): Promise<void | null>;
  setTail(instance: string, slot: number, tail: number): Promise<void | null>;
  setPhase(instance: string, slot: number, phase: number): Promise<void | null>;
  /** Run a deck at a ratio of the bank's grid (2 = double time). */
  setRatio(instance: string, slot: number, ratio: number): Promise<void | null>;
  setBpm(instance: string, bpm: number): Promise<void | null>;
  setSurface(instance: string, follow: boolean): Promise<void | null>;
  /** The transport: start the bank's clock, or stop it and park it back
   *  on beat 0 (so the next start comes in from the top of every clip). */
  setRunning(instance: string, running: boolean): Promise<void | null>;
  /** Assemble any slot still waiting for its audio; resolves to how many
   *  were filled. */
  rehydrate(): Promise<number | null>;
  endEdit(): Promise<void | null>;
}

export class DecksClient extends IpcClient implements DecksApi {
  banks() {
    return this.call<string[]>('decks_banks');
  }
  ensure() {
    return this.call<string>('decks_ensure');
  }
  status(instance: string) {
    // Polled while the tab is open: a bank the user just deleted is a
    // race, not news for the error banner.
    return this.call<DecksStatus>('decks_status', { instance }, { quiet: true });
  }
  load(instance: string, slot: number, clipId: string) {
    return this.call<void>('decks_load', { instance, slot, clipId });
  }
  clear(instance: string, slot: number) {
    return this.call<void>('decks_clear', { instance, slot });
  }
  setControl(instance: string, slot: number, control: SlotControl, value: number) {
    return this.call<void>('decks_set_control', { instance, slot, control, value });
  }
  setMaster(instance: string, bus: MasterBus, value: number) {
    return this.call<void>('decks_set_master', { instance, bus, value });
  }
  arm(instance: string, slot: number, arm: DeckArm) {
    return this.call<void>('decks_arm', { instance, slot, arm });
  }
  setTail(instance: string, slot: number, tail: number) {
    return this.call<void>('decks_set_tail', { instance, slot, tail });
  }
  setPhase(instance: string, slot: number, phase: number) {
    return this.call<void>('decks_set_phase', { instance, slot, phase });
  }
  setRatio(instance: string, slot: number, ratio: number) {
    return this.call<void>('decks_set_ratio', { instance, slot, ratio });
  }
  setBpm(instance: string, bpm: number) {
    return this.call<void>('decks_set_bpm', { instance, bpm });
  }
  setSurface(instance: string, follow: boolean) {
    return this.call<void>('decks_set_surface', { instance, follow });
  }
  setRunning(instance: string, running: boolean) {
    return this.call<void>('decks_set_running', { instance, running });
  }
  rehydrate() {
    return this.call<number>('decks_rehydrate');
  }
  /** Close the undo-coalescing window (fader drags, tempo drags). */
  endEdit() {
    return this.call<void>('end_edit');
  }
}

export const decks = new DecksClient();

/** How far a slot is being stretched, as a percentage a DJ reads the way
 *  a pitch fader reads: +6.7 % is "running 6.7 % fast". Under a tenth of
 *  a percent is not a stretch worth reporting. */
export function stretchLabel(stretch: number): string {
  const pct = (stretch - 1) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.05) return '±0.0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

/** The ratios a deck can be run at, fastest first — the BPM label's menu.
 *  A ratio is how often this deck's beats come round against everyone
 *  else's: 2 is double time, 1/2 half time, and 1 puts it back on the
 *  bank's own grid. Mirrors what `Engine::decks_set_ratio` accepts. */
export const DECK_RATIOS: readonly { value: number; label: string; hint: string }[] = [
  { value: 3, label: '3', hint: 'three times as fast' },
  { value: 2, label: '2', hint: 'double time' },
  { value: 1, label: '1', hint: "the bank's own grid" },
  { value: 2 / 3, label: '2/3', hint: 'two thirds as fast' },
  { value: 1 / 2, label: '1/2', hint: 'half time' },
  { value: 1 / 3, label: '1/3', hint: 'a third as fast' },
];

/** A deck's ratio as the menu spells it ('2', '1/2', …); an unlisted one
 *  (an older patch, a hand-edited file) falls back to a decimal. */
export function ratioLabel(ratio: number): string {
  const known = DECK_RATIOS.find((r) => Math.abs(r.value - ratio) < 1e-4);
  return known ? known.label : `${Number(ratio.toFixed(3))}`;
}

/** Whether a deck is on the bank's own grid — nothing to say about it. */
export function isNormalRatio(ratio: number): boolean {
  return !Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-4;
}

/** The deck's BASELINE tempo: the tempo its grid is read at, which is
 *  the clip's own over its ratio (double time takes a 140 bpm clip as
 *  70, so the bank's beat is worth two of the clip's). The stretch is
 *  measured against this, so baseline × stretch is always the tempo the
 *  clip's beats actually come out at. */
export function baselineBpm(sourceBpm: number, ratio: number): number {
  return isNormalRatio(ratio) ? sourceBpm : sourceBpm / ratio;
}

/** The BPM half of a strip's tempo line — the part it makes clickable,
 *  the stretch beside it coming from `stretchLabel`. It is the BASELINE
 *  the deck reads its grid at, with the ratio that put it there when
 *  that is not 1, and it drops a trailing `.0`: a clip cut at 140 on the
 *  bank's grid reads "140 bpm", the same clip in double time "70 bpm
 *  ×2". */
export function bpmLabel(sourceBpm: number, ratio = 1): string {
  const bpm = Number(baselineBpm(sourceBpm, ratio).toFixed(1));
  return isNormalRatio(ratio) ? `${bpm} bpm` : `${bpm} bpm ×${ratioLabel(ratio)}`;
}

/** The two halves a deck names its clip by, kept apart so a strip can
 *  give each of them a line and truncate it on its own: where the clip
 *  came from (falling back to the store id for a patch saved before clips
 *  carried the name) and the clip itself. Null when the deck holds
 *  nothing. */
export function clipParts(clip: BeatClipRef | null): { project: string; name: string } | null {
  if (!clip?.name) return null;
  return { project: clip.project_name || clip.project, name: clip.name };
}

/** What a deck calls what is in it, on one line: the project, then the
 *  clip. The strip gives the two halves a line each, so this is the form
 *  for somewhere a line is all there is — the load button's tooltip. */
export function clipTitle(clip: BeatClipRef | null): string {
  const parts = clipParts(clip);
  if (!parts) return 'empty';
  return parts.project ? `${parts.project} - ${parts.name}` : parts.name;
}

/** Total loop length of a slot, silence included. */
export function loopBeats(slot: DeckSlotStatus): number {
  return slot.beats === 0 ? 0 : slot.beats + slot.tail;
}

/** The FIELD the beat lamps are drawn in: the space a strip gives them
 *  whatever the clip's length, so nothing below the grid moves as clips
 *  come and go. 4:1, and sized so the longest loop worth reading —
 *  1024 beats — lands as 64 x 16 lamps of 2 px with nothing between
 *  them. */
export const BEAT_FIELD_WIDTH = 128;
export const BEAT_FIELD_HEIGHT = 32;

/** The most a lamp and its share of the spacing may grow to. Short loops
 *  are drawn generously, but a four-beat clip is not four big buttons:
 *  past this the field simply has room to spare. The spacing is a quarter
 *  of that pitch, up to this much — and nil below a 4 px pitch, where the
 *  lamps are 2 px and a gap would cost more than it tells. */
const BEAT_PITCH_MAX = 12;
const BEAT_GAP_MAX = 3;

export interface BeatGridLayout {
  /** Lamps across — always a power of two. */
  cols: number;
  rows: number;
  /** Side of one (square) lamp, in px. */
  cell: number;
  /** Space between lamps, in px; 0 once they are down to 2 px. */
  gap: number;
}

/** How a loop's beats are laid out in the field above: rows of a power of
 *  two, the first one that makes the block AT LEAST as wide as 4:1
 *  (`cols = 4 * rows` means `cols² = 4n`), with the lamps and the spacing
 *  between them grown or shrunk to fit — 8 beats read as one fat row,
 *  1024 as 64 x 16 of 2 px with nothing between them. Both take the SAME
 *  field, so the strip below never shifts.
 *
 *  Only the WIDTH ever binds: rounding the columns UP to a power of two
 *  keeps `rows <= cols / 4`, so a row of lamps a quarter of the field
 *  wide always leaves the field's height to spare. */
export function beatGridLayout(beats: number): BeatGridLayout {
  const n = Math.max(0, Math.floor(beats));
  // An empty deck still owns the field; there is simply nothing in it.
  if (n === 0) return { cols: 1, rows: 0, cell: 0, gap: 0 };
  const cols = 2 ** Math.ceil(Math.log2(2 * Math.sqrt(n)));
  const pitch = Math.min(BEAT_FIELD_WIDTH / cols, BEAT_PITCH_MAX);
  const gap = Math.min(BEAT_GAP_MAX, Math.floor(pitch / 4));
  return { cols, rows: Math.ceil(n / cols), cell: pitch - gap, gap };
}

/** The shift that lands a slot's FIRST beat on the beat NEAREST a moment
 *  on the bank's grid — what clicking a strip's SFT label sets, from
 *  where the bank's beat counter stood at the click. A slot's playhead is
 *  `beat - phase` wrapped by its loop, so its first beat comes round
 *  wherever the bank passes `phase`; the bank counts beats fractionally,
 *  so "nearest" is a round, and the answer is kept inside one loop length
 *  the way `decks_set_phase` keeps it. */
export function phaseForBeat(slot: DeckSlotStatus, beat: number): number {
  const len = loopBeats(slot);
  if (len <= 0 || !Number.isFinite(beat)) return 0;
  return ((Math.round(beat) % len) + len) % len;
}

/** Output peak a strip is as green as it gets at — a deck running hot,
 *  about −9 dBFS. Above it the tint simply stops, so a loud deck cannot
 *  keep getting greener and lose the difference between the others. */
export const DECK_GLOW_FULL = 0.35;

/** How lit a deck's strip is, 0..1: its output level against a hot deck.
 *  Linear in amplitude, so the tint follows what the ear calls loudness
 *  and near-silence is black rather than a permanent faint green — the
 *  fade itself is the engine's own decaying 1 s peak (`output_level`),
 *  not anything this side smooths. */
export function deckGlow(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(1, level / DECK_GLOW_FULL);
}
