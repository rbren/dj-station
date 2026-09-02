# Cleanup audit — analysis only, nothing executed

> **Execution status (2026-05-21).** P0 and everything the follow-up
> session judged worth doing has landed on `main`:
>
> - **P0 Decks V2 deleted** — frontend, CSS, engine state, tauri
>   commands, fixtures (`5ef8e21`).
> - **P1.1 dead code** — dead symbols, orphan CSS, unused cargo deps
>   (`41c4e7d`).
> - **P1.2 one decoder** — `playback::decode_file` now delegates to
>   `dj_analysis::decode_audio`; dj-engine drops its symphonia dep; all
>   54 e2e goldens byte-identical (`18a5aca`).
> - **P1.3 moot** — the shared Decks transport strip was only shared
>   with V2, which no longer exists.
> - **P1.4 done differently** — the two pickers share the dialog shell
>   and the query matcher but *nothing else* (multi-add disclosure list
>   vs. two-step keyboard flow); merging them would make a flag-driven
>   fork. The real duplication — five copies of the words-split search
>   filter — is now one `matchesQuery` in `src/search.ts` (`663e384`).
> - **P2.6 main.rs split** — library/deck/choreo/macros modules;
>   main.rs 3,163 → 2,042 lines, pure code motion (`96abf56`).
> - **P2.7 styles.css split** — an `@import` index over `src/styles/`,
>   cut on the file's own banners (`a7f0bac`). The 23 verbatim-dup rule
>   bodies were *left alone*: nearly all pair unrelated pages, and
>   comma-merging them would couple pages on a coincidence.
> - **P3.11 usePoll** — the six identical panel poll effects
>   (`39b940d`).
>
> **Deliberately deferred:** P2.5 (App.tsx split — 28 `useState` hooks
> in one component; needs its own ticket with designed state
> boundaries), P2.8 (row-layer/levelLane extractions — do alongside
> feature work in those views), P3.9/10 (export hygiene — per-file when
> touched), P3.12 (transport core — highest regression risk, only with
> planned feature work).

Audit of the whole tree (engine crates, extensions, frontend, Tauri shell)
for dead code, duplication, oversized files and smells. Every claim below
was measured on this checkout; numbers are exact where stated.

## 1. Aggregate stats

Source LOC by area (rs/ts/tsx/css):

| Area | LOC |
|---|---|
| crates/dj-engine | 40,547 |
| app/src (frontend) | 36,459 |
| app/tests | 24,092 |
| crates/dj-analysis | 10,542 |
| crates/dj-library | 5,640 |
| app/src-tauri/src | 5,040 |
| extensions/ (45 modules) | ~10,600 |
| markdown (repo total) | 2,696 |

Largest files: `app/src/styles.css` 6,629 · `app/src-tauri/src/main.rs`
3,174 (111 `#[tauri::command]`s) · `crates/dj-engine/src/decks.rs` 3,138 ·
`app/src/App.tsx` 2,513 · `components/ClipView.tsx` 2,309 ·
`components/GridView.tsx` 2,174 · `dj-engine/src/engine.rs` 1,928 ·
`app/src/moduleDocs.ts` 1,525 (in-app docs, fine).

Comment-to-code ratios: 0.16 (dj-library) to 0.26 (dj-analysis).
**Zero TODO/FIXME/HACK markers anywhere.** The comment volume is the
house style — why-focused design commentary (ClipView's header, decks.rs)
— not narration. A mass comment purge is NOT recommended; see §4.

## 2. Dead code (small — the tree is unusually clean)

- **Rust: zero compiler warnings** on a forced full `cargo check
  --workspace --release`; the only `#[allow(dead_code)]`s are test-helper
  modules. No Beatify leftovers anywhere (name absent from the tree).
  All 55 e2e goldens are referenced by tests — no orphaned fixtures.
- **Likely-unused Cargo deps** (name absent from the crate's src):
  `thiserror` in dj-engine, dj-analysis AND dj-library; `serde_json` in
  dj-cli. ~5 Cargo.toml lines + build time. Verify with a check build.
- **Truly dead frontend symbols** (unreferenced even in their own file
  and tests), 6 total: `clip.ts: removeRegion`, `DecksV2View.tsx:
  V2_GAP_PX`, `decks.ts: DECK_SLOTS`, `grid.ts: GRID_GROW_BEATS`,
  `grid.ts: clearTempo`, `grid.ts: inSelection`. ~40–60 lines.
- **Orphan CSS selectors** (~10 of 651 classes; rest resolve via
  extension `ui-src/` or template literals): `clip-clock`, `clip-grid`,
  `clip-regions`, `clip-sel-peaks-bleed-left/right`, `grid-bpm-here`,
  `grid-loop-readout`, `param-name`, `input-cell-hfader`,
  `input-group-column`. ~40–70 CSS lines; verify each before deleting.
- **Export hygiene, not deletions**: 169 exported symbols in `app/src`
  are never imported outside their own file (mostly `*Props` interfaces
  and constants exported "just in case"), and a further **61 exports are
  referenced ONLY by tests** (e.g. GridView's `zoomBy`/`bpmTicks`/
  `__rowRenderCount`, gridFx's `FX_*`, clip.ts's edit ops). The former is
  a mechanical `export` removal; the latter is a smell (tests reaching
  into internals) to shrink opportunistically, not a purge.
- **`com.dj.mixer`** is `deprecated: true` but intentionally kept so old
  patches load (house rule). Keep.

## 3. Duplication (the real cleanup meat)

Measured with normalized-line diffing / 10-line window hashing:

1. **DecksView.tsx ↔ DecksV2View.tsx — 136 identical lines in 11
   blocks** (49 dup windows, the worst pair in the repo): the transport
   strip (BPM number inputs, `decks-smooth-tick`, `setBpmTo`, bpm-target
   effect) plus private helpers `clampBpm` and `withDrafts` copied
   verbatim. V2 also does NOT reuse `DecksSlot` (578 lines) — its
   `V2Grid` (782-line component) re-renders slots its own way.
2. **dj-analysis/src/decode.rs ↔ dj-engine/src/playback.rs — 76
   identical lines**: two parallel symphonia decode pipelines
   (`decode_audio` vs `decode_file`: probe, codec loop, error-tolerant
   packet loop, `frames()`/mono-mix helpers). One shared decode fn would
   fix bugs once.
3. **GridClipPicker.tsx (184) ↔ DecksClipPicker.tsx (263)**: two modal
   beat-clip pickers with the same structure (search, stem filter, pick/
   close), diverging only in grouping (tracks vs songs-by-bpm).
4. **ClipTransport (862 lines) ↔ GridTransport (657 lines)**: two
   webview audio transports with overlapping scheduling/looping logic.
   Highest-effort merge; only worth it when next touching either.
5. **Engine-internal**: `engine.rs` (20 dup windows), `decks.rs` (19),
   `main.rs` (19) repeat their own boilerplate (command plumbing,
   per-slot loops); smaller cross-file dups `audio.rs↔beat_clip.rs`,
   `beat_clip.rs↔choreo.rs`, `launch_control.rs↔qwerty.rs` (shared
   "device panel" shape).
6. **CSS**: 17 rule bodies duplicated verbatim (~78 declaration lines),
   e.g. `.trigseq-ui/.eq-ui/.scope-ui`, `.deck-btn.active/.clip-toggle-on/
   .decks-btn.is-on`, `.library-tracks th,td/.beat-clip-table th,td` —
   parallel per-page button/table families that want shared classes.
7. **Per-view 100 ms poll loop** re-implemented in DecksView, DecksV2View
   (×3), GridView, BeatClipPanel, LaunchControlPanel — a `usePoll` hook
   would delete ~10 small blocks.

## 4. Comments & docs

- Comments are deliberate why-docs (0.21–0.26 ratio). Heaviest:
  `decks.rs` 766 comment lines, `styles.css` 719, `ClipView.tsx` 545,
  `main.rs` 494. Recommendation: leave the style alone; trim only where
  a comment restates an adjacent AGENTS.md rule or moduleDocs entry.
- Markdown is lean (2.7k lines). `reports/M0–M4_REPORT.md` (910 lines)
  are historical milestone reports — harmless; archive only if the
  reports dir gets noisy. `DESIGN_OVERHAUL.md` is the live design
  tracker per AGENTS.md; keep.

## 5. Smells

- **App.tsx (2,513)** — god component: view routing, patch load/save for
  two workspaces, rack canvas, zoom/pan persistence, macro flows, deck UI
  context, wire overlay hosting. One inline block spans ~540 lines.
- **GridView.tsx (2,174)** — one ~665-line component body; page-level
  state and row rendering interleaved (perf counters exported for tests).
- **ClipView.tsx (2,309)** — `levelLane` is a single ~523-line JSX
  expression.
- **decks.rs (3,138)** — v1 bank, v2 arrangements, manifest and RT
  process paths in one file (process/process_v2 are distinct logic, not
  copies — a split is layout, not dedup).
- **main.rs (3,174 / 111 commands)** — the split pattern already exists
  (`src-tauri/src/{beat_clip,clip,decks,launch_control}.rs`); the
  remaining ~70 commands haven't followed it.
- **styles.css (6,629)** — every page's styles in one file; sections are
  marked but several separator comments are anonymous (`/* ---- */`).
- **61 test-only exports** — vitest suites pin internals (render
  counters, zoom math) instead of behavior.

## 6. Prioritized plan (impact / risk / effort)

**P1 — low risk, do first**
1. Delete truly dead code: 6 frontend symbols, ~10 orphan CSS selectors,
   4 unused Cargo deps. ~150 lines. Risk: trivial. Effort: <1 ticket.
2. Extract one shared symphonia decode helper (dj-analysis already
   depends on nothing engine-side; move the pipeline there or into a tiny
   shared crate) and use it from `playback.rs`. Removes ~80–120 lines,
   unifies error handling. Goldens pin behavior. Effort: S–M.
3. Extract the shared Decks transport strip + `clampBpm`/`withDrafts`
   into a shared module used by DecksView and DecksV2View. Removes
   ~150–200 lines. DecksView/DecksV2 vitest suites guard it. Effort: M.
4. Merge GridClipPicker/DecksClipPicker into one picker with a grouping
   prop. Removes ~150 lines. Effort: M, risk: M (subtle UX diffs).

**P2 — structural, medium risk**
5. Split App.tsx: patch management, macro flows and the rack canvas out
   of the shell (~2.5k → 4–5 files). No LOC removed, big maintainability
   win. Effort: M–L.
6. Finish the main.rs command split into the existing per-domain files
   (~1.5–2k lines moved). Mechanical. Effort: M.
7. Split styles.css per page/feature (vite handles multiple imports) and
   fold the 17 verbatim-dup rule bodies into shared classes (~78 lines
   removed + real navigability). Effort: M.
8. Extract `V2Grid` from DecksV2View and the row layer from GridView;
   pull ClipView's `levelLane` into a component. Effort: M each.

**P3 — hygiene, opportunistic**
9. Un-export the 169 never-imported symbols (keep them file-local).
   Mechanical, shrinks the API surface tests can creep into.
10. Reduce the 61 test-only exports where a behavioral assertion exists
    (do this per-file when touching each view, not as a sweep).
11. `usePoll` hook for the repeated 100 ms status polls (~10 call sites).
12. ClipTransport/GridTransport shared scheduling core — only alongside
    planned feature work there; highest regression risk in the list.

Rough deletable total from P1 alone: ~500 lines with near-zero risk;
P2 moves ~10k lines into saner shapes without changing behavior.
