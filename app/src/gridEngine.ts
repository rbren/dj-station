// The Grid page's transport, played BY THE ENGINE.
//
// The page used to schedule its clips itself, through Web Audio. It does
// not any more: an arrangement is a clock module and one Grid Track
// module per row (`app/src-tauri/src/grid.rs`), and this file is the
// page's end of that — it compiles the document the page already owns
// into what the engine takes, and reads the playhead back off the
// engine's clock.
//
// WHAT THE PAGE SENDS IS THE DOCUMENT, not a schedule. There is no
// lookahead here, no pass, no re-scheduling on an edit: the modules hold
// the whole arrangement and play it against the clock, so a clip placed
// while the music runs is simply part of the next sync. That is the
// point of moving it — a webview timer cannot be trusted with a beat,
// and the engine is already the thing that owns the audio clock.
//
// THE PLAYHEAD IS POLLED, not counted. `status()` is synchronous (the
// page reads it on a timer, inside a render) so it answers with the last
// reading and asks for a fresh one; between a command and the reading
// that reflects it, the local intent wins, which is what keeps the
// highlight from flickering back a beat the moment play is pressed.
//
// Outside Tauri every call resolves to null and the page runs silent —
// the same headless behaviour every other client here has.

import type { BeatClipEntry } from './beatClip';
import { bpmAt, playRange, type GridState } from './grid';
import { fxOrDefault } from './gridFx';
import { IpcClient } from './ipc';

/** Where the playhead is, as the page draws it. */
export interface GridPlayback {
  playing: boolean;
  /** Fractional grid column. */
  column: number;
}

/** What the Grid page asks of whatever is playing it. The engine-backed
 *  player below is the one the app uses; tests substitute their own. */
export interface GridPlayer {
  /** The arrangement changed: bring the engine in line with it. */
  update(state: GridState, clips: ReadonlyMap<string, BeatClipEntry>, columns: number): void;
  /** Play from a column. */
  play(
    state: GridState,
    clips: ReadonlyMap<string, BeatClipEntry>,
    columns: number,
    from: number,
  ): Promise<void>;
  /** Stop, and answer where the playhead was left. */
  pause(): number;
  stop(): void;
  seek(column: number): void;
  status(): GridPlayback;
  /** These clips have been re-cut: whatever is held of them is stale. */
  forget(clipIds: Iterable<string>): void;
  dispose(): void;
}

/** One row of the sync payload — the wire shape of
 *  `app/src-tauri/src/grid.rs`'s `GridSyncRow`. */
interface SyncRow {
  id: string;
  clipId: string;
  rev: string;
  placements: number[];
  clipBeats: number;
  levels: { beat: number; level: number }[];
  level: number;
  pan: number;
  wet: number;
}

interface SyncDoc {
  rows: SyncRow[];
  bpm: number;
  tempoPoints: { beat: number; bpm: number }[];
  rangeStart: number;
  rangeEnd: number;
}

/** The document as the engine takes it. Rows whose clip is not in the
 *  store are dropped: the page still draws them (the clip may come back)
 *  but there is nothing for a module to play. */
export function syncDoc(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  columns: number,
): SyncDoc {
  const range = playRange(state, columns);
  const rows: SyncRow[] = [];
  for (const row of state.rows) {
    const clip = clips.get(row.clipId);
    if (!clip || clip.bpm <= 0) continue;
    const fx = fxOrDefault(row.fx);
    rows.push({
      id: row.id,
      clipId: row.clipId,
      rev: clip.rev ?? '',
      placements: [...row.placements].sort((a, b) => a - b),
      clipBeats: Math.max(1, clip.beats),
      // A resting row sends no points at all: the module reads that as
      // unity, and the Level knob below is the baseline it rides.
      levels: row.levels.length === 0 ? [] : row.levels.map((p) => ({ ...p })),
      level: fx.level,
      pan: fx.pan,
      wet: fx.wet,
    });
  }
  return {
    rows,
    bpm: state.tempo.bpm,
    tempoPoints: state.tempo.points.map((p) => ({ ...p })),
    rangeStart: range.start,
    rangeEnd: range.end,
  };
}

export class EngineGridPlayer extends IpcClient implements GridPlayer {
  /** The last document the engine was given, to skip a sync that says
   *  nothing new — the page calls `update` after every keystroke. */
  #synced = '';
  /** Every session command shares this queue. Sync can decode and take the
   *  engine lock, so a pause must wait behind the play it cancels rather
   *  than overtake it and leave the clock running. */
  #commands: Promise<void> = Promise.resolve();
  /** What the page has ASKED for, which wins over a status reading taken
   *  before the command landed. */
  #playing = false;
  #column = 0;
  /** Every transport gesture invalidates a delayed play or status reading. */
  #intent = 0;
  #polling = false;
  #disposed = false;

  #enqueue(command: () => Promise<unknown>): Promise<void> {
    const next = this.#commands.then(command).then(
      () => undefined,
      () => undefined,
    );
    this.#commands = next;
    return next;
  }

  update(state: GridState, clips: ReadonlyMap<string, BeatClipEntry>, columns: number): void {
    void this.#sync(state, clips, columns);
  }

  #sync(
    state: GridState,
    clips: ReadonlyMap<string, BeatClipEntry>,
    columns: number,
  ): Promise<void> {
    if (this.#disposed) return this.#commands;
    const doc = syncDoc(state, clips, columns);
    const json = JSON.stringify(doc);
    if (json === this.#synced) return this.#commands;
    this.#synced = json;
    return this.#enqueue(() => this.call<null>('grid_sync', { doc }));
  }

  async play(
    state: GridState,
    clips: ReadonlyMap<string, BeatClipEntry>,
    columns: number,
    from: number,
  ): Promise<void> {
    this.#playing = true;
    this.#column = from;
    const intent = ++this.#intent;
    await this.#sync(state, clips, columns);
    if (this.#disposed || intent !== this.#intent || !this.#playing) return;
    await this.#enqueue(() =>
      this.call<null>('grid_transport', {
        playing: true,
        from,
        // The tempo the cue sits at, read off the same envelope the lane
        // draws: it is what lets every row come in ON the first beat.
        startBpm: bpmAt(state.tempo, from),
      }),
    );
  }

  pause(): number {
    const at = this.status().column;
    this.#playing = false;
    this.#column = at;
    ++this.#intent;
    void this.#enqueue(() => this.call<null>('grid_transport', { playing: false }));
    return at;
  }

  stop(): void {
    this.#playing = false;
    ++this.#intent;
    void this.#enqueue(() => this.call<null>('grid_transport', { playing: false }));
  }

  seek(column: number): void {
    const at = Math.max(0, column);
    this.#column = at;
    const playing = this.#playing;
    ++this.#intent;
    void this.#enqueue(() => this.call<null>('grid_transport', { playing, from: at }));
  }

  status(): GridPlayback {
    void this.#poll();
    return { playing: this.#playing, column: this.#column };
  }

  /** One reading, at most one in flight. A reading superseded by a
   *  transport gesture, or one that disagrees about whether it is running,
   *  is from before the command landed and is dropped. */
  async #poll(): Promise<void> {
    if (this.#polling || this.#disposed) return;
    this.#polling = true;
    const intent = this.#intent;
    try {
      const status = await this.call<{ beat: number; playing: boolean }>('grid_status', undefined, {
        quiet: true,
      });
      if (!status || intent !== this.#intent || status.playing !== this.#playing) return;
      this.#column = status.beat;
    } finally {
      this.#polling = false;
    }
  }

  /** Nothing: the engine holds a row's audio keyed by the clip's
   *  revision, so a re-cut clip is re-loaded by the next sync without
   *  anyone having to forget anything. */
  forget(): void {}

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
    void this.#enqueue(() => this.call<null>('grid_teardown'));
  }
}
