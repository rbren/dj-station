# Milestone M4 Report — Macros, Native Escape Hatch & Polish

Built on `main`, on headless Linux (no display, no audio device, no GPU).
The two collapse-to-macro / native-module [A] criteria are fully verified
by tests wired into the existing CI surface (`cargo test --workspace
--release` + frontend vitest). The perf [A] criterion is verified in its
offline-scalable adaptation; the literal on-M4-hardware run and the [H]
"overall feel" pass are left unchecked (see "Open items").

## What was built

### Collapse-to-macro (PRD §6)

- **`crates/dj-engine/src/macros.rs`** — macro modules as pure data:
  `MacroDef` (stable id, name, monotonically bumped version, saved
  subgraph of `ModuleFile`s + `WireFile`s, and a `MacroInterface` mapping
  of promoted inputs/outputs/params), `MacroLibrary`, `MacroInstance`
  (expanded control-side state), and `MacroConflict`/`MacroResolution`
  (the update-vs-fork prompt logic).
- **Engine API** (`engine.rs`): `collapse_to_macro(selection, …)`
  validates that every wire crossing the selection boundary passes
  through a promoted interface jack, extracts the subgraph, registers the
  def, and replaces the selection with an instance. `add_module` with a
  macro id **expands** the subgraph (internal nodes get `/`-prefixed
  instance ids — `/` is now reserved in user instance ids); external
  jack/param access resolves through the interface mapping, so wiring,
  knobs, telemetry, and MIDI mapping treat a macro instance like any
  module. `update_macro` bumps the version and re-expands every live
  instance. Macros nest arbitrarily (nested expansion flattens ids).
- **Persistence** (`patch.rs`): patches persist macro instances as
  references (`ext = <macro id>`, `macro_version = N`) and embed the used
  definitions under `macros/*.json` as a lockfile.
  `PatchDoc::macro_conflicts(lib)` reports version mismatches against a
  library; `resolve_macro_conflict` implements the two prompt buttons:
  **update** (patch adopts the library def) or **fork** (patch's saved
  def re-registered under a new id at version 1; all references —
  including nested ones inside other embedded defs — rewritten).
- **Library storage** (`dj-library`): a `macros` table (id, name,
  version, JSON definition) with `save_macro`/`macros`/`delete_macro`;
  definitions are canonical here, per the same DB-vs-patch split as deck
  metadata.
- **App layer** (`app/src-tauri/src/main.rs`): `collapse_macro` command
  (auto-derives the interface: boundary wires are promoted mandatorily,
  every other unwired input jack of the selection is promoted so
  instances keep their knobs), `list_macros`, macros included in
  `list_modules` via synthesized manifests (`abi = "macro-1"`),
  macro-aware `engine_nodes`/`engine_wires` (internals hidden, boundary
  wires shown at promoted jacks), DB macros registered at startup and
  after undo/redo restores, and `load_patch` now returns unresolved
  version conflicts (engine untouched) and accepts
  `(macro_id, "update" | "fork")` resolutions, persisting forks.
- **Frontend**: shift-click multi-select on module panels, a
  "Collapse to Module" button + naming form, and a "Macros" section in
  the module library sidebar (click/drag to instantiate).

### Native (dylib) module backend (PRD §5)

- **`crates/dj-module-sdk`**: a versioned `native-1` C ABI —
  `NativeVTableV1` (create/destroy/set_param/process/save/load, ABI
  version field) exported through a `dj_module_entry_v1` symbol, plus an
  `export_native_module!` macro so a module implements the *same*
  `Module` trait as wasm-1 modules and picks its backend in one line.
- **`crates/dj-engine/src/native_host.rs`**: libloading-based host with
  a per-path library cache; ABI version checked at load; `process()`
  uses preallocated pointer tables (no allocations/locks on the RT
  thread). The **trust model** is documented at the top of the file:
  native modules are UNSANDBOXED, fully trusted code with the app's
  privileges — the escape hatch for perf-critical DSP, not a
  distribution format (WASM remains the sandboxed default).
- **Manifest/registry**: same `manifest.json` format; `abi: "native-1"`
  with `dsp.dylib`/`dsp.so`/`dsp.dll` next to it; `Engine::instantiate`
  dispatches on abi.
- **Sample**: `extensions/gain-native`, a cdylib with the same DSP as
  the WASM VCA, in a standalone cargo workspace (host-target; own
  `target/` so test-time rebuilds don't fight the locked root target
  dir), built by `scripts/build-native-extensions.sh`.

### MIDI LED feedback (PRD §7.1)

- The built-in MIDI module now has **input** jacks (preallocated table,
  `MAX_MIDI_LED_JACKS = 16`): `add_midi_led_mapping(kind, num, name)`
  binds a named jack to a note or CC. On the RT thread the module
  converts jack signal into controller messages — CC: value scaled to
  0–127, emitted **on change only**; note: gate semantics (≥ 1.0 → note
  on velocity 127, ≤ 0.0 → note off) — pushed into a lock-free SPSC ring
  (no allocation on the RT side).
- Off-RT, `Engine::drain_midi_out` / `pump_midi_out(sink)` forward the
  events to a `MidiOutSink`: `MockMidiSink` (tests), or
  `HardwareMidiSink` (feature `midi-hw`, midir output port).
- LED mappings + their wires round-trip through patch save/load.
- App layer: `add/remove_midi_led_mapping` commands, LED jacks surface
  on the MIDI panel by mapping name, a "LED out" editor section in the
  panel UI, and a background pump thread (enabled by `DJ_MIDI_OUT_PORT`)
  forwarding messages to real hardware at control rate.

### rekordbox XML import (PRD §8.1 — data layer)

- **`crates/dj-library/src/rekordbox.rs`**: roxmltree-based parser for
  `DJ_PLAYLISTS` exports — title/artist/album/BPM/`Tonality`,
  percent-decoded `Location` paths, first `TEMPO` entry as the beatgrid
  (bpm + anchor), `POSITION_MARK` Type=0 → hot cues (slots 0–7),
  Type=4 → named loops. `Library::import_rekordbox_xml` inserts into the
  library DB with dedupe by path/content-hash; grids/cues/loops land in
  the same tables the deck metadata path reads, so imported cues appear
  on deck load with no extra plumbing. Fixture:
  `crates/dj-library/tests/fixtures/rekordbox.xml`. App command:
  `import_rekordbox(path)`.

### Perf pass (PRD §10)

- **`crates/dj-engine/tests/perf_m4.rs`** builds the PRD [A] patch
  programmatically: 4 decks with stems loaded (one keylocked and synced
  to another), two crossfaders, and exactly **50 WASM module instances**
  (16 osc→vca→adsr voices + 2 FM LFOs, MIDI-gated), all mixed to the
  audio out. Part 1 renders `STRESS_SECONDS` of audio offline
  (CI = 600 s, the 10-minute equivalent) and asserts faster-than-realtime
  throughput and the RT allocation tripwire. Part 2 runs a live
  null-backend segment and asserts the callback deadline behavior
  (see "Open items" for the strict-zero caveat).

## Acceptance criteria → evidence

1. **Collapse/instantiate×2/edit-propagates/version-prompt** — VERIFIED.
   `crates/dj-engine/tests/macros.rs` (8 tests):
   `collapsed_macro_renders_identically_to_the_flat_patch` (collapse via
   API, byte-identical audio),
   `instantiate_twice_and_edit_internals_updates_both_instances` (two
   instances, `update_macro`, both change in memory AND on next patch
   load), `version_mismatch_prompt_logic_update_and_fork` (both prompt
   buttons, including reference rewriting and fork persistence),
   `macros_nest_arbitrarily`, save/load byte-stability, SQLite
   round-trip, boundary-wire validation, promoted params/manifest.
   Plus `e2e_macro_tone_collapse` in `e2e_golden.rs` (a serialized patch
   containing a macro instance renders byte-identically to its golden
   WAV) and `dj-library/tests/macro_store.rs`. UI flow covered by
   `app/tests/MacroCollapse.test.tsx` (5 tests).
2. **Native module = same manifest, same conformance suite, RT thread** —
   VERIFIED. `crates/dj-engine/tests/conformance.rs` (8 tests) runs
   identical batteries over the WASM VCA and `com.dj.gain_native`:
   manifest pipeline, **byte-identical audio between backends**, silence,
   reload/state round-trip across the C ABI, params,
   `native_module_runs_on_rt_thread_without_allocations` (allocation
   tripwire + a null-realtime run with the native module in the graph),
   and ABI version mismatch rejection.
3. **Perf stress** — VERIFIED in the offline-scalable adaptation
   (`perf_m4.rs`, 1 test: zero xruns/underruns over the full rendered
   duration, faster-than-realtime, allocation tripwire, live null-backend
   segment). The literal 10-minute wall-clock zero-xrun run **on M4
   hardware** remains open — PRD checkbox left unchecked with a note.
4. **[H] overall feel** — needs a human; unchecked.

Also shipped under M4 scope: MIDI LED feedback
(`crates/dj-engine/tests/midi_led.rs`, 6 tests: CC change-only emission,
note gate on/off, mock sink, save/load round-trip, mapping removal drops
wires, emission while running realtime) and rekordbox import
(`crates/dj-library/tests/rekordbox_import.rs`, 3 tests: parse
tracks/grids/cues/loops, DB import + dedupe, non-rekordbox rejection).

## Test counts (new in M4)

| Suite | Tests |
| --- | --- |
| `dj-engine --test macros` | 8 |
| `dj-engine --test conformance` | 8 |
| `dj-engine --test midi_led` | 6 |
| `dj-engine --test e2e_golden` | 8 (7 existing byte-identical + `e2e_macro_tone_collapse`) |
| `dj-engine --test perf_m4` | 1 |
| `dj-library --test rekordbox_import` | 3 |
| `dj-library --test macro_store` | 2 |
| frontend vitest | 97 total (8 new: 5 MacroCollapse + 3 MidiPanel LED) |

## Placeholder vs production-ready

- **Production-ready**: macro engine API/persistence/versioning, the
  native-1 ABI + host, MIDI LED engine path, rekordbox parser/DB import,
  macro UI flow.
- **Trust model (by design, not a placeholder)**: native modules are
  unsandboxed trusted code — documented in `native_host.rs` and
  AGENTS.md. There is no signature/permission system; only in-repo
  samples are loaded by default (extension discovery just reads
  manifest dirs). If third-party native distribution ever lands, a
  consent UI must come first.
- **Open items**:
  - PRD §10 perf checkbox: the on-M4-hardware, real-audio-device,
    10-minute zero-xrun run cannot be performed here (headless, no audio
    device). The offline equivalent runs at CI's `STRESS_SECONDS=600`.
    The live null-backend segment tolerates ≤ 1 % callback CPU-time
    spikes because shared CI hosts can't guarantee scheduling; on target
    hardware the criterion is strict zero.
  - LED hardware pump and `HardwareMidiSink` compile everywhere but have
    only been exercised against the mock sink (no MIDI hardware here).
  - rekordbox import is data-layer + a Tauri command; there is no file
    picker UI for it yet (marked v1.x in the PRD).
