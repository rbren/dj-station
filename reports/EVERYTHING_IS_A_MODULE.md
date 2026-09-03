# "Everything is a module" — inventory and migration plan

> **Investigation only (2026-05-21).** No behaviour was changed. The ticket
> asked first for a survey of the components that generate or process a
> signal outside the module system, and for a migration plan to bring them
> in; this is that survey. Nothing below has been implemented.

The ask, verbatim: *anything that generates or processes a signal should be
a module* — built-in/native is fine, but all of them conform to the same
Rust APIs so they compose. Two examples were named: the Grid's BPM
controller should be a clock module, and a Grid track should be a module
taking a clip, a sequence and a clock and emitting audio.

## 1. What "a module" actually is today

A module is five things, and only the first two are uniform:

1. **A manifest** (`crates/dj-engine/src/manifest.rs:9-120`): id, category,
   input/output jacks with knob configs and display specs, params, bypass
   routes (`manifest.rs:33-47`), presets, latency.
2. **A `HostModule`** (`crates/dj-engine/src/module_host.rs:6-27`):
   `process(inputs, outputs, connected_mask, frames)` on the RT thread,
   `on_param`, `save_state`/`load_state`. WASM extensions and native
   built-ins both land here; `registry.rs:69-96` lists the instantiable
   set (14 built-ins + 44 extensions).
3. **Knob/param state**, uniform, persisted per instance
   (`patch.rs:53-57`).
4. **Bulk state**, NOT uniform. `ModuleFile` (`patch.rs:45-105`) carries one
   TYPED optional field per stateful built-in — `choreo`, `math`, `decks`,
   `track`, `clip`, `sync_to` — each with its own branch in save, load and
   the reconcile path (`patch.rs:856-882`, `1116-1159`).
5. **A control surface**, also NOT uniform: a bespoke `Engine::<module>_*`
   API per built-in (`engine/decks_api.rs` alone exports 22 methods) and a
   bespoke IPC file per domain (148 `#[tauri::command]`s total; 46 of them
   are per-module: deck 21, decks 15, choreo 10).

So the "same Rust APIs" the ticket wants exist for DSP and knobs, and do
NOT exist for bulk state and control. **Every component we migrate adds
another typed `ModuleFile` field and another dozen IPC commands unless
layer 4/5 is formalized first.** That is the single most useful piece of
groundwork this ticket can do, and it is cheap (see slice S0).

## 2. Inventory — signal work living outside the module system

### A. Missing primitives (nothing to port; they simply do not exist)

| # | Thing | Where it lives now | Proposed |
|---|-------|--------------------|----------|
| A1 | **Clock** (bpm → pulses) | reimplemented FIVE times: `audio.rs:50` (10 ms pulse), `deck.rs:49` (10 ms), `decks.rs:191` (1 ms), `track_io.rs:38` (1 ms), `builtin.rs:135` (MIDI clock, 48 samples) | `builtin.clock`: `bpm`/`run`/`reset` in, `clock`/`bar`/`phase`/`beat` out |
| A2 | **Breakpoint automation** (value over beats, ramped) | Grid master tempo `grid.ts:277-336`, Grid row levels `grid.ts:344-402`, Clip page level envelope `dj-analysis/src/clip.rs:386-426`, and again in the webview `clipLive.ts` (`levelSchedule`) | `builtin.automation`: clocked breakpoint envelope → CV |
| A3 | **Pan** | `StereoPannerNode` in the webview (`gridTransport.ts:665`); engine has pan only as jacks inside the mixer extensions (`com.dj.mixer{,4,8}`) | `builtin.pan` (or reuse `com.dj.mixer4`) |

A1 is the ticket's own example and is the highest value/lowest risk item in
the whole ticket: five private bpm→pulse implementations with three
different pulse widths is exactly the duplication "everything is a module"
is meant to remove, and a Clock module is independently useful in the Rack
(there is today no way to get a tempo into a patch without instantiating a
Deck, an Audio player or a Decks bank).

### B. The Grid page — the crux

The Grid plays in the WEBVIEW. What that means concretely:

- **Scheduling**: `app/src/gridTransport.ts` (826 lines) — a 250 ms
  lookahead re-run on a 100 ms timer, `AudioBufferSourceNode.start(when)`
  per copy, live re-scheduling on edit (`update`, `:355`), pass/loop
  bookkeeping (`#pump`, `#schedule`).
- **DSP in the webview**: one `GainNode` per voice with the row's level
  automation written as ramps (`:821-824`), an optional `StereoPannerNode`
  (`:665`), a dry/wet crossfade between two buffers whose gains split the
  row level by Wetness (`:601-640`, `#mix` `:645`), and the bleed laid as
  two extra voices per copy (`#layBleed` `:710`).
- **Tempo**: a breakpoint envelope integrated to seconds
  (`grid.ts:790-836`); the audio itself is pre-stretched per WHOLE bpm by
  the backend (`beat_clip_audio`, `app/src-tauri/src/beat_clip.rs:270-300`)
  and cached in the webview keyed by `clipId:bpm:fx`
  (`gridTransport.ts:201`).
- **Per-track FX**: cannot be in the live graph, so it is rendered OFFLINE
  through a throwaway headless `Engine` per clip per rack revision
  (`crates/dj-engine/src/track_fx.rs:1-27`) around a chrome stand-in module
  (`builtin.track_io`, `track_io.rs:1-18`, deliberately hidden from the
  picker) — the wet buffer is then shipped back to the webview to be
  crossfaded.
- **The arrangement** is frontend-owned JSON filed in `grids/<name>.json`
  (`app/src-tauri/src/beat_clip.rs:339-380`) — not patch state, not engine
  state.
- **Focus**: on the Grid tab the engine is told to go SILENT
  (`app/src/App.tsx:115-121`).

Proposed modules:

- **B1 `builtin.grid_track`** — the ticket's second example. Holds a clip
  binding (like `builtin.beat_clip`, `beat_clip.rs:30-33`), a placement
  lane (the "sequence"), a level lane, and `level`/`pan`/`wet` controls;
  inputs `clock`, `reset`, `level`, `pan`, `ret_l`, `ret_r`; outputs
  `audio_l`, `audio_r`, `send_l`, `send_r`. The send/return pair makes the
  per-track rack a LIVE insert, exactly the shape a Decks slot already has
  (`decks.rs:12-26`).
- **B2 master transport** = `builtin.clock` (A1) + `builtin.automation`
  (A2) driving its `bpm`, plus `Workspace::Grid` and `AudioFocus::Grid`
  alongside the existing Rack/Decks pair (`engine.rs:78-105`,
  `set_module_workspace` `engine.rs:712`).
- **B3 retirement**: `builtin.track_io` and `track_fx.rs`'s offline render
  disappear once B1 exists — roughly 400 lines of engine code plus the
  `fx` argument on `beat_clip_audio` and the wet-buffer half of the
  transport (`gridTransport.ts:601-650`).
- **B4** the three chrome controls Level/Pan/Wetness
  (`gridFx.ts:68-74`, today explicitly "outside the graph on purpose",
  `gridFx.ts:153-154`) become real jacks on B1 — wireable, automatable,
  MIDI-mappable, which they cannot be today.

### C. The Clip page

- **C1 Live tone chain in the webview** (`app/src/clipLive.ts`, 853 lines):
  peaking-bell `BiquadFilterNode`s, scheduled level automation, 20 ms
  crossfades between voices, bleed voices. This is a THIRD implementation
  of the same EQ: the rack's `com.dj.eq` (wasm), the offline renderer's
  RBJ biquads (`dj-analysis/src/clip.rs:306-385`, whose own comment says
  "the same RBJ filters as the rack's EQ module"), and this one.
- **C2 Offline clip render** (`dj-analysis/src/clip.rs:1-26`): assemble
  regions → EQ → level automation → WSOLA warp. It is a fixed pipeline, not
  a graph; `track_fx.rs` already proves an offline headless `Engine` render
  is a viable substitute (and `render_offline` exists,
  `engine/lifecycle.rs:436`).
- **C3 Stem source selection** (`app/src-tauri/src/clip.rs:29-75`): "which
  stems are summed" is a mixer, expressed as a decode-time set.

### D. Decomposition INSIDE existing modules (real, low value)

- **D1** Deck stem gains — four gains applied in the deck's RT loop
  (`deck/rt.rs:365-380`, params at `:503`) rather than four VCAs.
- **D2** Decks bank internals: per-slot fader/tone/mute/monitor plus the
  live and monitor `MasterBus` (`decks.rs:414`, `:664-667`, `:745`) — a
  private mixer that mirrors `com.dj.mixer8`'s `lvl/pan/mute/solo`.
- **D3** `builtin.audio`'s internal clock (`audio.rs:1-17`) — would be
  `builtin.clock` once A1 exists.

These are *inside* modules already, so they cost composability, not
conformance. Splitting them is a rack-authoring nicety and a golden-audio
risk (D2 especially: the bank's mix is pinned by
`e2e_suite/e2e_decks.rs`). **Recommend not doing them in this ticket.**

### E. Correctly NOT modules (stated so the sweep is closed)

Analysis and library work — tempo/key detection (`dj-analysis/src/tempo.rs`,
`key.rs`), stem separation jobs (`stems.rs`, `demucs.rs`, `scnet.rs`),
waveform peaks, the library DB, file/patch IO — is offline batch work over
whole files with no jacks and no clock. The webview's gapless-loop plumbing
(`clipAudio.ts`) is a browser workaround, not DSP. Cosmetic UI state stays
app-layer per AGENTS.md.

## 3. The crux, argued: Grid in the webview vs. Grid as engine modules

**What moving it buys**

1. *Tempo ramps become real.* Today a copy that straddles a tempo ramp
   "rides the tempo it started on — the honest thing a fixed buffer can do"
   (`grid.ts:874-880`). Engine-side the clip is stretched live by the
   shared WSOLA path (`stretch.rs`, as `builtin.beat_clip` does), so the
   playhead tracks a moving clock exactly.
2. *Tempo changes stop costing a render.* Every whole-bpm value is a
   separate backend stretch + WAV + IPC + `decodeAudioData` + cache entry
   (`gridTransport.ts:201`, `#fetch:253`). Dragging the BPM box today walks
   that path per bpm per clip. Engine-side, one decoded copy per clip
   serves every tempo.
3. *Track FX becomes live.* No offline render per clip per rack revision,
   no stale-wet-buffer invalidation (`gridTransport.ts:525-540`), and
   stateful modules (delay, reverb, LFO) stop restarting from silence at
   every clip boundary — which today is not just slow but musically wrong.
4. *The Grid joins the patch.* Rows become wireable: a row's level from an
   LFO, its pan from the Launch Control, its clock multiplied, its output
   through the rack's master chain. None of that is expressible now.
5. *Grid arrangements become goldenable* — a Grid render is an
   `e2e_suite` case like any other patch; today the Grid has zero
   golden-audio coverage and is tested only through jsdom fakes.
6. Deletes duplicated logic: bleed placement, level ramping, panning and
   the wet crossfade exist once in Rust instead of once more in TS.

**What it costs**

1. *A large, subtle rewrite.* `gridTransport.ts` is 826 lines of scheduling
   with hard-won semantics (first pass from the cursor, edit splicing by
   copy key, bleed gating per pass edge, loop seams). Re-deriving that
   RT-side is the bulk of the work and the bulk of the risk.
2. *Test surface.* `GridTransport.test.ts` (767), `GridView.test.tsx`
   (1472), `Grid.test.ts` (813), `GridTransportFx.test.ts`, plus the
   `GridPerf.test.tsx` benchmark just landed on main. The transport suites
   drive REAL scheduling headless with `performance.now()`; against an
   engine transport they can only assert IPC calls. Coverage has to move to
   Rust E2E goldens, and the perf harness has to be re-pointed rather than
   deleted.
3. *Headless/browser dev stops making sound.* The webview transport works
   with no Tauri backend at all (`gridTransport.ts:193-199`).
4. *Persistence question.* The arrangement is app-owned JSON in `grids/`.
   Engine-side state must round-trip through the patch to satisfy
   self-containment — so either grids become patch state (a big product
   decision: a grid is currently a document you save under its own name,
   independent of the rack patch) or the Grid module holds a compiled
   program installed over the API and the patch keeps a binding, the way a
   Decks slot keeps a clip ref while the audio is re-supplied by the app.
5. *Memory.* All clips in an arrangement must be resident in engine RAM.
   Probably an improvement (one copy per clip instead of one per clip×bpm),
   but it is a new failure mode for a 60-row grid.
6. *Focus/gating work*: a third `AudioFocus` and a third `Workspace`, plus
   the Grid tab no longer silencing the engine.

**Recommendation.** Do it, but as a strangler, not a swap:

- Land the primitives (A1–A3) and the Grid module (B1) with Rust E2E
  goldens FIRST, driven only by tests — the app keeps playing in the
  webview and nothing user-visible changes.
- Introduce a `GridPlayer` port on the frontend with the transport's
  current surface (`play/pause/stop/seek/update/status/prime/forget`,
  `gridTransport.ts:142-546`) and two implementations: the existing
  webview one and a thin engine-backed one.
- Flip the default only when the engine path passes the same behavioural
  suites, keeping the webview implementation as the no-backend fallback
  until it can be deleted deliberately.

If the user would rather not move Grid playback at all, slices S0–S2 still
pay for themselves (they remove the clock duplication and give the Rack a
Clock and an Automation module), and S3 can stop at "the Grid's BPM box
drives a real `builtin.clock` whose pulses the webview merely reads".

## 4. Proposed slices

Each slice keeps the app building, keeps existing goldens byte-identical
(new serde fields `#[serde(default)]`), and ships its own golden case.

- **S0 — module spec, layer 4/5** *(no behaviour change)*. Add a
  `ModuleState` trait (`state_json`/`set_state_json`) implemented by
  choreo/math/decks/beat-clip over their existing typed structs, one
  generic `module_state_get/set` IPC pair, and keep the typed `ModuleFile`
  fields as-is so patch bytes do not move. Everything later plugs into one
  path instead of adding a sixth field. ~1 day. Risk: low.
- **S1 — `builtin.clock`**. New native module + manifest + picker entry +
  `e2e_clock` golden (clock → beat clip, pinned). Optionally refactor the
  five private pulse counters onto one shared `ClockCore` struct, keeping
  each caller's pulse width so goldens do not move. Risk: low.
- **S2 — `builtin.automation`**. Clocked breakpoint envelope → CV, state
  via S0. Golden: automation → VCA → tone. Risk: low.
- **S3 — Grid master tempo on the engine**. `Workspace::Grid`,
  `AudioFocus::Grid`, the Grid's BPM box and tempo lane writing a real
  clock+automation pair. Webview still schedules audio, now against the
  engine's clock readout. Risk: medium (this is where the focus/gating
  plumbing lands).
- **S4 — `builtin.grid_track`** (clip + placements + level lane +
  level/pan/wet + send/return), engine-side only, exercised by Rust E2E
  goldens: one row, two rows against one clock, bleed at a join, a tempo
  ramp under a clip. No app change. Risk: medium-high; this is the big one.
- **S5 — `GridPlayer` port + engine-backed implementation**, default OFF.
  Behavioural parity run of the existing Grid suites against both. Risk:
  medium.
- **S6 — flip the default; retire `track_io`/`track_fx`** and the `fx`
  argument on `beat_clip_audio`; per-track racks become live inserts.
  Risk: medium; the payoff slice.
- **S7 (optional, separate ticket) — Clip page**: collapse the three EQ
  implementations onto one (C1/C2), then consider an engine-side clip
  preview module and `AudioFocus::Clip`.

D1–D3 are explicitly out of scope.

## 5. Verification each slice owes

`cargo test -p dj-engine --release --test e2e_suite <case>` for the new
golden; `--test integration <name>` for the module's unit behaviour;
`cargo fmt`; `cargo clippy -p dj-engine --all-targets --release`. Frontend
slices run the single affected vitest file. S3/S5/S6 additionally need the
Grid suites and the `GridPerf` benchmark green, and S6 needs every existing
golden re-verified byte-identical (it deletes a render path).

## 6. Open questions for the user

1. **Does a Grid arrangement become patch state?** Or does the engine hold
   a compiled program while `grids/*.json` stays the saved-document format
   (the Decks pattern)? This decides S4's persistence design.
2. **Is the webview Grid path allowed to disappear**, or must the page keep
   working with no backend (browser/jsdom)?
3. **How much Grid behaviour is negotiable** in the port — e.g. is
   "first pass plays from the parked cursor" a rule to preserve exactly?
4. **Clip page in or out?** S7 is a ticket-sized piece of work on its own.

## 7. What landed (execution log)

The plan above was executed as far as S6. Deviations from it are recorded
here rather than rewritten above, so the reasoning and the outcome can be
read against each other.

- **S0 (`ModuleState` trait) — NOT done, and dropped for now.** It buys
  uniformity for the IPC layer, not for the audio spec, and the two
  modules added here needed nothing from it: a clock's lane and a row's
  arrangement are PROGRAMS shipped over a ring, not patch state, so they
  never touch the `ModuleFile` typed fields S0 was meant to generalize.
  Doing it would have moved patch-facing code (and risked golden bytes)
  for no behaviour. It stays worth doing on its own, when a fifth
  module-with-state arrives.
- **S1 `builtin.clock` + S4 `builtin.grid_track`** — landed together
  (`965a812`): the two new native modules, their manifests, picker
  entries, unit tests and the `grid-two-rows` golden. Bypass routes are
  manifest-declared, programs ride the SPSC ring as `Arc`s with a
  garbage return ring, and both modules allocate nothing on the RT
  thread.
- **S2 `builtin.automation`** — NOT done as a separate module. The Grid's
  master tempo is breakpoint automation, but the only consumer it has is
  the clock, and the clock already reads its own lane (a `ClockProgram`)
  so that a tempo RAMP is integrated exactly rather than sampled per
  block. A generic automation module would have to hand the clock a
  sampled CV, which is strictly worse for the one case that exists.
  Deferred until a second consumer wants an envelope.
- **S3 + S5 + S6 collapsed into two slices**, because the intermediate
  states were less safe than the move itself: a
  webview scheduling audio against an engine clock it polls over IPC is
  a THIRD timing model to keep correct, and a "default OFF" port means
  two live playback paths whose divergence is only visible by ear.
  - *The backend* — `Workspace::Grid` / `AudioFocus::Grid`, the
    Grid session (`app/src-tauri/src/grid.rs`) that `grid_sync` keeps in
    step with the document, transport/playhead commands, and integration
    tests for cueing, focus gating, a live edit under a running
    transport, the play range wrapping, and the session staying out of
    saved patches. Clock and row programs were re-cut to speak ABSOLUTE
    grid columns here (`loop_start`/`loop_end`), which is what lets the
    page's playhead be the clock's own position.
  - *The frontend* — `app/src/gridEngine.ts` (document to sync
    payload, engine-polled playhead), and the deletion of
    `GridTransport`, its two test files, and the offline clip-audio path
    that fed it (`beat_clip_audio` with its stretch, capture framing and
    rack render, plus `BeatClipApi.audio`/`capture`). Nothing in a
    webview plays audio any more.

### Known gaps

1. **A row's effects RACK is not compiled into the session.** The row
   module has `send_l/r` and `ret_l/r` and a Wetness knob, and Level and
   Pan are live, but nothing builds the rack's modules inside the grid
   workspace yet — so a row plays dry whatever its Wetness says (the
   module's own insert rule: wetness means nothing when nothing came
   back). The Track Rack modal still edits and stores the rack; it is
   simply not heard. This is the next slice, and it is the one that pays
   off the offline-render deletion: `dj-engine/src/track_fx.rs` and
   `track_io` can go once a rack is a live insert.
2. **Sends and returns aside, the session is flat**: rows go straight to
   an audio out. Per-row monitor/live routing (the Decks distinction) is
   not modelled.
3. **The Clip page (C1-C3) is untouched**, as scoped: its three EQ
   implementations and its webview transport remain a ticket of their
   own.
