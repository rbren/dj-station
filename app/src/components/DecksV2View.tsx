// The Decks V2 page: one bank, TWO ARRANGEMENTS. Every loaded beat clip
// is a ROW; to the right of the row titles sit two beat grids — LIVE,
// exactly what the room is looping, and MONITOR, the editable copy in
// the headphones — drawn to the same width: the bank's whole cycle (the
// least common multiple of every row's loop), so the full path the loop
// walks is on screen in both. The two grids zoom and scroll on their
// own, one playhead walks both on the same beat, and the 100 px gap
// between them holds the two ways monitor becomes live: JUMP (swap at
// the loop's right edge) and CROSSFADE (blend over one whole cycle).
// Once a transition has played through, the page commits it — monitor
// is copied into live, the two sides are identical, and mucking around
// in monitor no longer touches the room.
//
// The top bar is the Decks tab's own — the tempo walk (bpm/min tick and
// rate), the BPM box and slider, the actual readout, the two output
// pairs with their faders and device pickers, Start/Stop — minus the
// clock jack and the Launch Control (this page has neither rack chrome
// nor a surface, for now; racks per deck, cue/drop and the tone knobs
// are also deliberately absent).
//
// The engine side is the SAME `builtin.decks` module flagged v2: the
// classic per-slot state is the monitor arrangement, `live_*` is the
// room's. Everything drawn comes from one `decks_status` poll, and
// drafts (a fader mid-drag, the tempo box) win until the engine's own
// reading agrees — the Decks page's discipline, copied not shared: the
// two pages already diverge (rows vs strips, two grids vs one), and a
// prop soup serving both would couple what the ticket says to keep
// apart.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioOutputsApi } from '../audioOutputs';
import { beatClip as defaultClips, type BeatClipApi, type BeatClipEntry } from '../beatClip';
import {
  clipTitle,
  DEFAULT_BPM_PER_MIN,
  LEVEL_MAX,
  loopBeats,
  MASTER_BUSES,
  MAX_BPM,
  MAX_BPM_PER_MIN,
  MIN_BPM,
  MIN_BPM_PER_MIN,
  rampBpm,
  type DecksStatus,
  type DeckSlotStatus,
  type MasterBus,
} from '../decks';
import {
  cellBeat,
  clampZoom,
  clipSong,
  decksV2 as defaultApi,
  freeSlot,
  songColor,
  songsOf,
  v2Rows,
  V2_ZOOM_DEFAULT,
  V2_ZOOMS,
  type DecksV2Api,
} from '../decksV2';
import { loadJson, saveJson } from '../rackStore';
import { AudioOutputSelect, useAudioOutputs } from './AudioOutputSelect';
import { DecksClipPicker } from './DecksClipPicker';

const POLL_MS = 100;
/** The walk's write cadence — the poll's, so the actual reading and the
 *  steps that move it land together. */
const SMOOTH_TICK_MS = 100;

/** The gap between the two grids that holds Jump and Crossfade. */
export const V2_GAP_PX = 100;

/** A cycle can be an absurd LCM (a 5 against a 7 against a 9); past this
 *  many columns the grids draw a truncation note instead of melting the
 *  DOM. The audio plays the whole cycle regardless. */
export const V2_MAX_COLS = 1024;

/** Per-side zoom, persisted like the rack's own zoom (cosmetic chrome,
 *  never patch state). */
const ZOOM_KEYS = { live: 'dj-decksv2-zoom-live', monitor: 'dj-decksv2-zoom-monitor' } as const;

export type V2Side = 'live' | 'monitor';
export const V2_SIDES: readonly V2Side[] = ['live', 'monitor'];

/** One side's reading of a row: which fader, mute and shift this grid
 *  draws — the monitor side is the slot's classic state, the live side
 *  its `live_*` twin. */
export function sideOf(slot: DeckSlotStatus, side: V2Side) {
  return side === 'live'
    ? {
        level: slot.live_level,
        mute: slot.live_mute,
        phase: slot.live_phase,
        leadOne: slot.live_lead_one,
      }
    : { level: slot.level, mute: slot.mute, phase: slot.phase, leadOne: slot.lead_one };
}

type DraftKey = `${number}:${V2Side}:${'level' | 'mute'}`;

export interface DecksV2ViewProps {
  api?: DecksV2Api;
  clips?: BeatClipApi;
  outputs?: AudioOutputsApi;
  /** The page keeps polling only while it is the open tab. */
  active?: boolean;
  pollMs?: number;
}

export function DecksV2View(props: DecksV2ViewProps) {
  const api = props.api ?? defaultApi;
  const clipApi = props.clips ?? defaultClips;
  const active = props.active ?? true;
  const { outputs, choose: chooseOutput } = useAudioOutputs(props.outputs);
  const [bank, setBank] = useState<string | null>(null);
  const [status, setStatus] = useState<DecksStatus | null>(null);
  const [clips, setClips] = useState<BeatClipEntry[]>([]);
  const [picking, setPicking] = useState<'clip' | 'song' | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<DraftKey, number>>>({});
  // The tempo target and walk: the Decks tab's own arrangement (see the
  // header comment there) — target as a self-clearing draft, walk writes
  // down the same setBpm path.
  const [bpmTarget, setBpmTarget] = useState<number | null>(null);
  const [smooth, setSmooth] = useState(true);
  const [perMin, setPerMin] = useState(DEFAULT_BPM_PER_MIN);
  const ramp = useRef<number | null>(null);
  const [masterDrafts, setMasterDrafts] = useState<Partial<Record<MasterBus, number>>>({});
  // What a side's output fader held before its mute button zeroed it, so
  // unmuting puts it back. Chrome memory, not engine state: the engine's
  // only master is the fader itself.
  const preMute = useRef<Partial<Record<MasterBus, number>>>({});
  // LIVE IS UNEDITABLE — unless disarmed: the little button on top of the
  // live grid that opens the room's own controls up.
  const [liveOpen, setLiveOpen] = useState(false);
  const [zoom, setZoom] = useState<Record<V2Side, number>>(() => ({
    live: clampZoom(loadJson(ZOOM_KEYS.live, V2_ZOOM_DEFAULT)),
    monitor: clampZoom(loadJson(ZOOM_KEYS.monitor, V2_ZOOM_DEFAULT)),
  }));
  const rehydrated = useRef(false);
  // One commit in flight at a time: the poll that saw `transition_done`
  // owes the copy, but the next poll must not owe it again.
  const committing = useRef(false);
  const clock = useRef<{ beat: number; bpm: number; running: boolean; at: number } | null>(null);

  const poll = useCallback(async () => {
    if (!bank) return;
    const st = await api.status(bank);
    if (!st) return;
    clock.current = { beat: st.beat, bpm: st.bpm, running: st.running, at: performance.now() };
    setStatus(st);
    setBpmTarget((t) => (t !== null && Math.abs(st.bpm - clampBpm(t)) < 1e-3 ? null : t));
    setDrafts((live) => {
      const settled = Object.fromEntries(
        (Object.entries(live) as [DraftKey, number][]).filter(([key, value]) => {
          const [slot, side, control] = key.split(':') as [string, V2Side, 'level' | 'mute'];
          const s = st.slots[Number(slot)];
          if (!s) return false;
          const held = sideOf(s, side);
          const now = control === 'mute' ? (held.mute ? 1 : 0) : held.level;
          return Math.abs(now - value) >= 1e-3;
        }),
      ) as Partial<Record<DraftKey, number>>;
      return Object.keys(settled).length === Object.keys(live).length ? live : settled;
    });
    // A fired transition owes its commit: what was in monitor has taken
    // the room over, so copy it into the live side. After the copy the
    // two arrangements are identical and monitor edits are monitor-only.
    if (st.transition_done && !committing.current) {
      committing.current = true;
      try {
        if (await api.commitTransition(bank)) {
          const after = await api.status(bank);
          if (after) setStatus(after);
        }
      } finally {
        committing.current = false;
      }
    }
  }, [api, bank]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      // Like the Decks tab: a bank already here still has to be able to
      // PLAY (ensureV2 re-wires lost outputs and edits nothing
      // otherwise); no bank means the empty state offers to make one.
      const found = await api.banksV2();
      const bank = found?.[0] ? ((await api.ensureV2()) ?? found[0]) : null;
      if (!cancelled && found) setBank(bank);
      const list = await clipApi.list();
      if (!cancelled && list) setClips(list);
      if (!cancelled && bank && !rehydrated.current) {
        rehydrated.current = true;
        await api.rehydrate();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, clipApi, active]);

  useEffect(() => {
    if (!active || !bank) return;
    const first = setTimeout(() => void poll(), 0);
    const timer = setInterval(() => void poll(), props.pollMs ?? POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active, bank, poll, props.pollMs]);

  const addBank = useCallback(async () => {
    setBusy(true);
    const created = await api.ensureV2();
    setBusy(false);
    if (created) setBank(created);
  }, [api]);

  const write = useCallback(
    async (fn: () => Promise<unknown>) => {
      await fn();
      void poll();
    },
    [poll],
  );

  // ---- the tempo, copied from the Decks tab -------------------------
  const setBpmTo = useCallback(
    (next: number) => {
      if (!bank || !Number.isFinite(next)) return;
      setBpmTarget(next);
      if (!smooth) void write(() => api.setBpm(bank, clampBpm(next)));
    },
    [api, bank, smooth, write],
  );

  const endBpmEdit = useCallback(() => {
    if (smooth) return;
    setBpmTarget(null);
    void api.endEdit();
  }, [api, smooth]);

  useEffect(() => {
    if (!bank || !smooth || bpmTarget === null) return;
    const goal = clampBpm(bpmTarget);
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const from = ramp.current ?? clock.current?.bpm ?? goal;
      const next = rampBpm(from, goal, (now - last) / 1000, perMin);
      last = now;
      void api.setBpm(bank, next);
      if (next === goal) {
        ramp.current = null;
        clearInterval(timer);
        void api.endEdit();
      } else {
        ramp.current = next;
      }
    }, SMOOTH_TICK_MS);
    return () => clearInterval(timer);
  }, [api, bank, bpmTarget, perMin, smooth]);

  const toggleSmooth = useCallback(
    (on: boolean) => {
      setSmooth(on);
      if (!on && bank && bpmTarget !== null) {
        ramp.current = null;
        void write(() => api.setBpm(bank, clampBpm(bpmTarget)));
        void api.endEdit();
      }
    },
    [api, bank, bpmTarget, write],
  );

  // ---- the two output pairs, also the Decks tab's -------------------
  const master = useCallback(
    (bus: MasterBus) =>
      masterDrafts[bus] ??
      (bus === 'live' ? (status?.master_live ?? 1) : (status?.master_monitor ?? 1)),
    [masterDrafts, status],
  );
  const setMaster = useCallback(
    (bus: MasterBus, value: number) => {
      if (!bank) return;
      setMasterDrafts((d) => ({ ...d, [bus]: value }));
      void write(() => api.setMaster(bank, bus, value));
    },
    [api, bank, write],
  );
  const releaseMaster = useCallback(
    (bus: MasterBus) => {
      setMasterDrafts((d) => ({ ...d, [bus]: undefined }));
      void api.endEdit();
    },
    [api],
  );
  // Each grid's own mute: the pair's fader driven to zero and back — one
  // knob in the engine, a button and a memory here.
  const toggleSideMute = useCallback(
    (bus: MasterBus) => {
      const now = master(bus);
      if (now > 0) {
        preMute.current[bus] = now;
        setMaster(bus, 0);
      } else {
        setMaster(bus, preMute.current[bus] ?? 1);
      }
      void api.endEdit();
    },
    [api, master, setMaster],
  );

  // ---- rows ----------------------------------------------------------
  const setSideControl = useCallback(
    (slot: number, side: V2Side, control: 'level' | 'mute', value: number) => {
      if (!bank) return;
      setDrafts((d) => ({ ...d, [`${slot}:${side}:${control}`]: value }));
      void write(() =>
        side === 'live'
          ? api.setLiveControl(bank, slot, control, value)
          : api.setControl(bank, slot, control, value),
      );
    },
    [api, bank, write],
  );

  const setSidePhase = useCallback(
    (slot: number, side: V2Side, phase: number) => {
      if (!bank) return;
      void write(() =>
        side === 'live' ? api.setLivePhase(bank, slot, phase) : api.setPhase(bank, slot, phase),
      );
    },
    [api, bank, write],
  );

  const addClip = useCallback(
    (clip: BeatClipEntry) => {
      if (!bank || !status) return;
      const slot = freeSlot(status.slots);
      setPicking(null);
      if (slot === null) return;
      // One clip on its own comes RIGHT IN on the monitor (a load lands
      // cued and audible there); only a batch starts muted.
      void write(() => api.loadV2(bank, slot, clip.clipId, false));
    },
    [api, bank, status, write],
  );

  const addSong = useCallback(
    async (songClips: BeatClipEntry[]) => {
      if (!bank || !status) return;
      setPicking(null);
      // Every clip of the song into consecutive free rows — ALL MUTED
      // (even in the monitor): a whole song landing at once is material
      // to pick from, not a wall of sound. What doesn't fit stays out.
      const open = status.slots.filter((s) => s.clip === null && s.beats === 0).map((s) => s.slot);
      const landing = songClips.slice(0, open.length);
      await write(async () => {
        for (let i = 0; i < landing.length; i++) {
          await api.loadV2(bank, open[i], landing[i].clipId, landing.length > 1);
        }
      });
    },
    [api, bank, status, write],
  );

  const bumpZoom = useCallback((side: V2Side, delta: number) => {
    setZoom((z) => {
      const next = { ...z, [side]: clampZoom(z[side] + delta) };
      saveJson(ZOOM_KEYS[side], next[side]);
      return next;
    });
  }, []);

  const beatNow = useCallback(() => {
    const c = clock.current;
    if (!c) return 0;
    if (!c.running) return c.beat;
    return c.beat + ((performance.now() - c.at) / 1000) * (c.bpm / 60);
  }, []);

  const bpm = bpmTarget ?? status?.bpm ?? 120;
  const actualBpm = status?.bpm ?? bpm;
  const running = status?.running ?? false;
  const slots = useMemo(() => status?.slots ?? [], [status]);
  const shownSlots = useMemo(() => slots.map((s) => withDrafts(s, drafts)), [slots, drafts]);
  const rows = useMemo(() => v2Rows(shownSlots), [shownSlots]);
  const cycle = status?.cycle_beats ?? 0;
  const nextSlot = status ? freeSlot(status.slots) : null;
  const clipsById = useMemo(() => new Map(clips.map((c) => [c.clipId, c])), [clips]);
  const songs = useMemo(() => songsOf(clips), [clips]);
  const transition = status?.transition ?? 'none';

  const arm = useCallback(
    (mode: 'jump' | 'crossfade') => {
      if (!bank) return;
      // The armed button pressed again takes the ask back.
      void write(() => api.transition(bank, transition === mode ? 'none' : mode));
    },
    [api, bank, transition, write],
  );

  if (!bank) {
    return (
      <div className="decksv2-view" data-testid="decksv2-view">
        <p className="empty-state decks-empty-bar" data-testid="decksv2-empty">
          Decks V2 plays two arrangements of the same rows: the room loops LIVE while you build the
          next pass in MONITOR, then jump or crossfade over.
          <br />
          <button
            className="is-primary decks-add"
            data-testid="decksv2-add-bank"
            disabled={busy}
            onClick={() => void addBank()}
          >
            Add the V2 deck bank
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="decksv2-view" data-testid="decksv2-view">
      <header className="decks-bar decksv2-bar">
        <div className="decks-tempo">
          <div className="decks-smooth" data-testid="decksv2-smooth">
            <label className="decks-smooth-tick">
              <input
                type="checkbox"
                checked={smooth}
                onChange={(e) => toggleSmooth(e.target.checked)}
              />
              bpm / min
            </label>
            <input
              className="decks-smooth-rate mono"
              data-testid="decksv2-smooth-rate"
              type="number"
              aria-label="Tempo walk, bpm per minute"
              min={MIN_BPM_PER_MIN}
              max={MAX_BPM_PER_MIN}
              step={1}
              value={perMin}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) setPerMin(next);
              }}
            />
          </div>
          <div className="decks-tempo-stack">
            <label className="decks-tempo-label" htmlFor="decksv2-bpm">
              BPM
            </label>
            <input
              id="decksv2-bpm"
              className="decks-bpm mono"
              data-testid="decksv2-bpm"
              type="number"
              min={MIN_BPM}
              max={MAX_BPM}
              step={0.5}
              value={Number(bpm.toFixed(2))}
              onChange={(e) => setBpmTo(Number(e.target.value))}
              onBlur={endBpmEdit}
            />
            <input
              className="decks-tempo-slider"
              data-testid="decksv2-bpm-slider"
              type="range"
              aria-label="Bank tempo"
              min={MIN_BPM}
              max={MAX_BPM}
              step={0.5}
              value={bpm}
              onChange={(e) => setBpmTo(Number(e.target.value))}
              onPointerUp={endBpmEdit}
            />
          </div>
          <span className="decks-bpm-actual" data-testid="decksv2-bpm-actual">
            <span className="decks-bpm-actual-label">actual</span>
            <span className="decks-bpm-actual-value mono">{actualBpm.toFixed(1)}</span>
          </span>
        </div>
        <div className="decks-readout">
          <span
            className="decks-beat mono"
            data-testid="decksv2-beat"
            data-state={running ? 'running' : 'stopped'}
          >
            beat {Math.floor(status?.beat ?? 0) + 1}
            {cycle > 0 ? `/${cycle}` : ''}
          </span>
          {cycle <= 0 && (
            <span className="decks-cycle" data-testid="decksv2-cycle">
              nothing loaded
            </span>
          )}
        </div>
        <div
          className="decks-outs"
          data-testid="decksv2-outs"
          data-state={outputs?.note ? 'adrift' : 'ok'}
        >
          {MASTER_BUSES.map((bus) => (
            <div className="decks-out" data-bus={bus} data-testid={`decksv2-out-${bus}`} key={bus}>
              <span className="decks-out-label">{bus}</span>
              <input
                className="decks-master"
                data-testid={`decksv2-master-${bus}`}
                type="range"
                aria-label={`${bus} master volume`}
                min={0}
                max={1}
                step={0.01}
                value={master(bus)}
                onChange={(e) => setMaster(bus, Number(e.target.value))}
                onPointerUp={() => releaseMaster(bus)}
              />
              <span className="decks-master-value mono">{Math.round(master(bus) * 100)}%</span>
              <AudioOutputSelect bus={bus} outputs={outputs} onChoose={chooseOutput} />
            </div>
          ))}
          {outputs?.note && (
            <span className="audio-output-note" data-testid="audio-output-note" role="status">
              {outputs.note}
            </span>
          )}
        </div>
        <div className="decks-bar-actions">
          <button
            className={`decks-btn decks-btn-start${running ? ' is-on' : ''}`}
            data-testid="decksv2-start"
            aria-pressed={running}
            onClick={() => void write(() => api.setRunning(bank, true))}
          >
            Start
          </button>
          <button
            className={`decks-btn${running ? '' : ' is-on'}`}
            data-testid="decksv2-stop"
            aria-pressed={!running}
            onClick={() => void write(() => api.setRunning(bank, false))}
          >
            Stop
          </button>
        </div>
      </header>

      <div className="decksv2-body">
        {/* The row titles: one line per loaded clip, its song's color on
            the chip — every clip cut from one song wears the same one. */}
        <div className="decksv2-titles" data-testid="decksv2-titles">
          <div className="decksv2-col-head decksv2-titles-head">rows</div>
          {rows.map((slot) => {
            const entry = slot.clip ? clipsById.get(slot.clip.clip) : undefined;
            const song = clipSong(entry);
            return (
              <div
                className="decksv2-title"
                data-testid={`decksv2-title-${slot.slot}`}
                key={slot.slot}
              >
                <span
                  className="decksv2-chip"
                  data-testid={`decksv2-chip-${slot.slot}`}
                  style={{ background: songColor(song?.hash ?? null) }}
                  title={song?.title}
                />
                <span className="decksv2-title-name" title={clipTitle(slot.clip)}>
                  {slot.clip?.name ?? '—'}
                </span>
                <button
                  className="decksv2-eject"
                  data-testid={`decksv2-eject-${slot.slot}`}
                  title="Remove this row"
                  onClick={() => void write(() => api.clear(bank, slot.slot))}
                >
                  ⏏
                </button>
              </div>
            );
          })}
          <div className="decksv2-adds">
            <button
              className="decks-btn"
              data-testid="decksv2-add-clip"
              disabled={nextSlot === null}
              onClick={() => setPicking('clip')}
            >
              + Clip
            </button>
            <button
              className="decks-btn"
              data-testid="decksv2-add-song"
              disabled={nextSlot === null || songs.length === 0}
              onClick={() => setPicking('song')}
            >
              + Song
            </button>
          </div>
        </div>

        <V2Grid
          side="live"
          rows={rows}
          cycle={cycle}
          zoom={zoom.live}
          beatNow={beatNow}
          running={running}
          locked={!liveOpen}
          pollMs={props.pollMs ?? POLL_MS}
          onZoom={(d) => bumpZoom('live', d)}
          onControl={setSideControl}
          onPhase={setSidePhase}
          onRelease={() => void api.endEdit()}
          head={
            <button
              className={`decks-btn decksv2-disarm${liveOpen ? ' is-on' : ''}`}
              data-testid="decksv2-disarm"
              aria-pressed={liveOpen}
              title={
                liveOpen ? 'Lock the live side again' : 'Disarm: open the live side up for editing'
              }
              onClick={() => setLiveOpen((v) => !v)}
            >
              {liveOpen ? 'disarmed' : 'disarm'}
            </button>
          }
          muteButton={
            <button
              className={`decks-btn decksv2-side-mute${master('live') === 0 ? ' is-on' : ''}`}
              data-testid="decksv2-side-mute-live"
              aria-pressed={master('live') === 0}
              onClick={() => toggleSideMute('live')}
            >
              mute
            </button>
          }
        />

        {/* THE GAP: 100 px between the room and the workbench, holding
            the two ways across it. An armed button pressed again takes
            the ask back; the crossfade shows how far across it is. */}
        <div className="decksv2-gap" data-testid="decksv2-gap">
          <button
            className={`decks-btn decksv2-transition${transition === 'jump' ? ' is-on' : ''}`}
            data-testid="decksv2-jump"
            aria-pressed={transition === 'jump'}
            title="At the live loop's right edge, jump onto what's in monitor"
            onClick={() => arm('jump')}
          >
            Jump
          </button>
          <button
            className={`decks-btn decksv2-transition${transition === 'crossfade' ? ' is-on' : ''}`}
            data-testid="decksv2-crossfade"
            aria-pressed={transition === 'crossfade'}
            title="From the live loop's right edge, blend onto monitor over one loop"
            onClick={() => arm('crossfade')}
          >
            Crossfade
          </button>
          {transition === 'crossfade' && (status?.xfade ?? 0) > 0 && (
            <span className="decksv2-xfade mono" data-testid="decksv2-xfade">
              {Math.round((status?.xfade ?? 0) * 100)}%
            </span>
          )}
        </div>

        <V2Grid
          side="monitor"
          rows={rows}
          cycle={cycle}
          zoom={zoom.monitor}
          beatNow={beatNow}
          running={running}
          locked={false}
          pollMs={props.pollMs ?? POLL_MS}
          onZoom={(d) => bumpZoom('monitor', d)}
          onControl={setSideControl}
          onPhase={setSidePhase}
          onRelease={() => void api.endEdit()}
          muteButton={
            <button
              className={`decks-btn decksv2-side-mute${master('monitor') === 0 ? ' is-on' : ''}`}
              data-testid="decksv2-side-mute-monitor"
              aria-pressed={master('monitor') === 0}
              onClick={() => toggleSideMute('monitor')}
            >
              mute
            </button>
          }
        />
      </div>

      {picking === 'clip' && nextSlot !== null && (
        <DecksClipPicker
          deck={nextSlot + 1}
          clips={clips}
          onClose={() => setPicking(null)}
          onPick={addClip}
        />
      )}
      {picking === 'song' && (
        <div
          className="file-dialog-backdrop"
          data-testid="decksv2-song-picker"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPicking(null);
          }}
        >
          <div className="file-dialog decksv2-song-list" role="dialog" aria-label="Add a song">
            <h3>
              Add every clip from a song{' '}
              <span className="decksv2-song-note">(they land muted, in the monitor)</span>
            </h3>
            <div className="decksv2-songs">
              {songs.map((song) => (
                <button
                  className="decksv2-song"
                  data-testid={`decksv2-song-${song.hash}`}
                  key={song.hash}
                  onClick={() => void addSong(song.clips)}
                >
                  <span
                    className="decksv2-chip"
                    style={{ background: songColor(song.hash) }}
                    aria-hidden="true"
                  />
                  <span className="decksv2-song-title">{song.title}</span>
                  {song.artist && <span className="decksv2-song-artist">{song.artist}</span>}
                  <span className="decksv2-song-count mono">
                    {song.clips.length} clip{song.clips.length === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </div>
            <button
              className="file-dialog-cancel"
              data-testid="decksv2-song-cancel"
              onClick={() => setPicking(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface V2GridProps {
  side: V2Side;
  rows: DeckSlotStatus[];
  cycle: number;
  /** Index into V2_ZOOMS: how many px one beat gets. */
  zoom: number;
  beatNow(): number;
  running: boolean;
  /** The live grid before its disarm button: controls read-only. */
  locked: boolean;
  pollMs: number;
  head?: React.ReactNode;
  muteButton?: React.ReactNode;
  onZoom(delta: number): void;
  onControl(slot: number, side: V2Side, control: 'level' | 'mute', value: number): void;
  onPhase(slot: number, side: V2Side, phase: number): void;
  onRelease(): void;
}

/** One of the two beat grids. Columns are BANK BEATS of the whole cycle
 *  (the LCM), so the two grids always draw the same width of musical
 *  time and a row's picture slides when it is shifted; the playhead
 *  walks both grids on the same path. Cells reuse the Decks strips'
 *  grammar: the first one beat green, other ones purple, the row's tail
 *  beats hollow. */
function V2Grid(props: V2GridProps) {
  const { side, rows, cycle, running } = props;
  const cellW = V2_ZOOMS[clampZoom(props.zoom)];
  const cols = Math.min(cycle, V2_MAX_COLS);
  // The playhead redraws on the poll's cadence and glides between
  // readings with a linear transition of the same length.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((n) => n + 1), props.pollMs);
    return () => clearInterval(timer);
  }, [running, props.pollMs]);
  const beat = cycle > 0 ? props.beatNow() % cycle : 0;
  const nowCol = Math.floor(beat);

  return (
    <section className="decksv2-side" data-side={side} data-testid={`decksv2-grid-${side}`}>
      <div className="decksv2-col-head decksv2-side-head">
        <span className="decksv2-side-name">{side}</span>
        {props.head}
        {props.muteButton}
        <span className="decksv2-zoom">
          <button
            className="decks-btn"
            data-testid={`decksv2-zoom-out-${side}`}
            aria-label={`Zoom the ${side} grid out`}
            onClick={() => props.onZoom(-1)}
          >
            −
          </button>
          <button
            className="decks-btn"
            data-testid={`decksv2-zoom-in-${side}`}
            aria-label={`Zoom the ${side} grid in`}
            onClick={() => props.onZoom(1)}
          >
            +
          </button>
        </span>
      </div>
      <div className="decksv2-side-body">
        <div className="decksv2-side-controls">
          {rows.map((slot) => {
            const held = sideOf(slot, side);
            return (
              <div
                className="decksv2-row-controls"
                data-testid={`decksv2-controls-${side}-${slot.slot}`}
                data-off={held.mute ? 'true' : 'false'}
                key={slot.slot}
              >
                <button
                  className={`decksv2-btn-mute${held.mute ? ' is-on' : ''}`}
                  data-testid={`decksv2-mute-${side}-${slot.slot}`}
                  aria-pressed={held.mute}
                  disabled={props.locked}
                  title={held.mute ? 'Unmute this row' : 'Mute this row'}
                  onClick={() => props.onControl(slot.slot, side, 'mute', held.mute ? 0 : 10)}
                >
                  M
                </button>
                <input
                  className="decksv2-level"
                  data-testid={`decksv2-level-${side}-${slot.slot}`}
                  type="range"
                  aria-label={`Row ${slot.slot + 1} ${side} level`}
                  min={0}
                  max={LEVEL_MAX}
                  step={0.01}
                  value={held.level}
                  disabled={props.locked}
                  onChange={(e) =>
                    props.onControl(slot.slot, side, 'level', Number(e.target.value))
                  }
                  onPointerUp={props.onRelease}
                />
                <span className="decksv2-shift">
                  <button
                    data-testid={`decksv2-shift-left-${side}-${slot.slot}`}
                    aria-label={`Shift row ${slot.slot + 1} ${side} one beat earlier`}
                    disabled={props.locked}
                    onClick={() => props.onPhase(slot.slot, side, held.phase - 1)}
                  >
                    ‹
                  </button>
                  <span className="mono" data-testid={`decksv2-phase-${side}-${slot.slot}`}>
                    {held.phase}
                  </span>
                  <button
                    data-testid={`decksv2-shift-right-${side}-${slot.slot}`}
                    aria-label={`Shift row ${slot.slot + 1} ${side} one beat later`}
                    disabled={props.locked}
                    onClick={() => props.onPhase(slot.slot, side, held.phase + 1)}
                  >
                    ›
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        <div className="decksv2-scroll" data-testid={`decksv2-scroll-${side}`}>
          <div className="decksv2-cells" style={{ width: cols * cellW }}>
            {rows.map((slot) => {
              const held = sideOf(slot, side);
              const len = loopBeats(slot);
              return (
                <div
                  className="decksv2-row-cells"
                  data-testid={`decksv2-cells-${side}-${slot.slot}`}
                  data-off={held.mute ? 'true' : 'false'}
                  key={slot.slot}
                >
                  {Array.from({ length: cols }, (_, col) => {
                    const b = cellBeat(slot, held.phase, col);
                    const inClip = len > 0 && b < slot.beats;
                    const one = inClip && slot.ones.includes(b);
                    const lead = one && held.leadOne !== null && b === held.leadOne;
                    return (
                      <span
                        className="decksv2-cell"
                        data-kind={!inClip ? 'tail' : lead ? 'lead' : one ? 'one' : 'beat'}
                        data-now={running && col === nowCol ? 'true' : 'false'}
                        key={col}
                        style={{ width: cellW }}
                      />
                    );
                  })}
                </div>
              );
            })}
            {running && cycle > 0 && (
              <div
                className="decksv2-playhead"
                data-testid={`decksv2-playhead-${side}`}
                style={{
                  left: (beat / cycle) * cols * cellW,
                  transitionDuration: `${props.pollMs}ms`,
                }}
              />
            )}
            {cycle > cols && (
              <div className="decksv2-truncated" data-testid={`decksv2-truncated-${side}`}>
                …{cycle - cols} more beats in the cycle
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

/** The slot as drawn: engine state with any still-held drag on top. */
function withDrafts(
  slot: DeckSlotStatus,
  drafts: Partial<Record<DraftKey, number>>,
): DeckSlotStatus {
  let out = slot;
  for (const side of V2_SIDES) {
    for (const control of ['level', 'mute'] as const) {
      const draft = drafts[`${slot.slot}:${side}:${control}`];
      if (draft === undefined) continue;
      if (out === slot) out = { ...slot };
      if (side === 'live') {
        if (control === 'mute') out.live_mute = draft >= 1;
        else out.live_level = draft;
      } else if (control === 'mute') out.mute = draft >= 1;
      else out.level = draft;
    }
  }
  return out;
}
