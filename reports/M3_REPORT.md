# Milestone M3 Report — Intelligence

Built on `main`, on headless Linux (no display, no audio device, no GPU,
no large model downloads). All [A] criteria below are wired into the
existing CI surface (`cargo test --workspace --release` + frontend
vitest); the two [H] criteria need a human with ears and real-world
material and are left unchecked. The one machine-bound clause (stemming
≤ 1× realtime on M4 hardware) is also left unchecked — see
"Placeholder vs production-ready".

## What was built

### `crates/dj-analysis` — the analysis pipeline (PRD §8.2)

- **Decode** (`decode.rs`): symphonia-based decode of anything the
  library imports (wav/flac/mp3/aac/aiff) into planar f32
  (`AudioData`), plus a mono mixdown helper.
- **BPM + auto-beatgrid** (`tempo.rs`, pure Rust DSP): spectral-flux
  onset envelope (STFT via rustfft, `stft.rs`) → comb-filter/
  autocorrelation tempo estimation over 60–180 BPM with octave
  disambiguation → beat phase fit; returns `bpm` + `anchor_secs`
  (a beat position), which is exactly the deck's grid model from M2.
- **Key detection** (`key.rs`, pure Rust DSP): chromagram folded from
  the STFT, correlated against Krumhansl–Schmuckler major/minor
  profiles over all 24 rotations; output format matches the UI ("Am",
  "F#", "C").
- **Stem separation** (`stems.rs`): a `StemSeparator` trait
  (`separate(&AudioData) -> Stems` — vocals/drums/bass/other) with two
  implementations:
  - `BandSeparator` (default, deterministic, always available): an
    HPSS-style frequency/transient split — bass = low band, drums =
    percussive/transient component, vocals = mid-band harmonic
    emphasis, other = residual — built so the four stems sum back to
    the original within tolerance (energy conservation is tested).
  - `OnnxSeparator` (`onnx.rs`, behind the `onnx` cargo feature): ORT
    2.0 runtime plumbing that loads an htdemucs-class model file
    (`f32[1,2,N] -> f32[1,4,2,N]`) from `DJ_STEMS_ONNX_MODEL`, with the
    execution provider selected per platform: **CoreML EP on macOS, CPU
    EP elsewhere**. No weights are bundled or downloaded.
- **Stem cache**: stems are written as **FLAC** under
  `<data_dir>/stems/<content_hash>/{vocals,drums,bass,other}.flac`.
  `ensure_stems` is compute-if-missing; the cache key is the library's
  content hash, so identical content never recomputes.
- **Background worker** (`worker.rs`): a dedicated thread drains the
  library's analysis queue (`analysis_status = 'queued'`, set by every
  import path since M1 — watch folder, drag/drop, provider download).
  Per track: decode → BPM/key → write `tracks.bpm/musical_key` →
  upsert the beatgrid → ensure the stem cache → mark `done` (or
  `failed`, without wedging the queue). Analysis never touches the RT
  thread; results land in the DB and are re-applied to decks through
  the existing app-layer metadata path.
- **Labeled synthetic test set** (`testset.rs`, in the library so both
  crates' tests can use it): deterministic (seeded splitmix64)
  electronic-style tracks — four-on-the-floor kick, offbeat hats,
  eighth-note bassline on tonic/fifth, sustained tonic-triad pad — with
  ground-truth BPM (84–172, 0.1 steps), first-beat anchor, and key.

### Engine: stem playback on the deck (`crates/dj-engine/src/deck.rs`)

- Four new output jacks on `builtin.deck`: `stem_vocals`, `stem_drums`,
  `stem_bass`, `stem_other` (post-gain, independently routable through
  the graph like any other jack).
- Four new params `stem_vocals/drums/bass/other` (0..1, default 1) —
  ordinary module params, so they persist in patches and round-trip
  save/load like everything else.
- `DeckCmd::LoadStems(Arc<StemData>)` over the existing bounded SPSC
  command ring; the RT thread swaps a pointer and returns the old data
  on the garbage ring (`DeckGarbage::{Track,Stems}`) — **zero
  allocation/locks on the RT path**. Stems are decoded off-RT
  (`Engine::deck_load_stems`, which validates stem sample rate against
  the loaded track) and dropped automatically when a new track loads.
- With stems loaded, the deck's main `audio_l/r` outputs become the
  gain-weighted stem sum — in both the plain playback path and the
  keylock (WSOLA) grain path, so muting a stem works under time-stretch
  and loops too. With no stems loaded the deck plays the original mix
  exactly as before (all six pre-M3 E2E goldens byte-identical).
- `Engine::deck_clear_stems`, `DeckStatus.stems_loaded`.

### App layer (Tauri) and frontend

- The shell starts the analysis worker at boot; importing a track from
  any source auto-queues analysis with no user action.
- New IPC: `analysis_status` (current track, queued ids, status
  counts), `analyze_track` (re-queue; cached stems are reused),
  `deck_load_stems` (loads the content-hash-keyed cache for the deck's
  current track), `deck_clear_stems`.
- `apply_deck_metadata` (runs on `deck_load` and patch load) now also
  auto-loads cached stems, alongside grids/cues/loops — stems stay
  canonical in app storage, not in patches, per the M2 convention.
- Library view: BPM and Key columns, a status tag per track
  (queued/analyzing/done/failed) with a re-run button, and a batch
  progress banner ("Analyzing N tracks… (done/total)") polled while the
  queue is busy; rows refresh as results land.
- Deck panel: a stems row — per-stem mute button + gain slider driving
  the `stem_*` params — plus a "Stems" load button when a cache exists
  but isn't loaded yet.

## Acceptance criteria — evidence

1. **Auto-queue + BPM/key accuracy** — ✅
   - `dj-analysis/tests/worker_queue.rs::import_auto_queues_and_results_land_in_the_db`:
     imports a synthetic track into a real `Library`, starts the worker,
     and observes `bpm`/`musical_key`/beatgrid/stems appear in the DB and
     stem cache with no further calls.
   - `dj-analysis/tests/accuracy.rs` on the 20-track labeled set:
     **BPM 20/20 exact** (trivially ≥ 95 % within the ×/÷2 family),
     **key 20/20 correct** (≥ 80 % required).
2. **Auto-beatgrid drives M2 sync with no manual adjustment** — ✅
   - `dj-analysis/tests/accuracy.rs::auto_beatgrid_aligns_to_annotated_beats`:
     worst grid-vs-ground-truth beat offset ≈ **1.2 ms** across the set.
   - `dj-engine/tests/analysis_sync.rs::auto_beatgrids_drive_deck_sync_within_1ms`:
     two labeled tracks at different tempos, grids taken **directly from
     `analyze_audio` output**, deck B synced to deck A, 61 s offline
     render: every beat after the first second aligns within **±1 ms**
     (the M2 phase criterion), no manual grid adjustment anywhere.
3. **Caching** — ✅ (the two verifiable clauses)
   - `worker_queue.rs::rerun_recomputes_bpm_key_but_reuses_cached_stems`:
     a counting `StemSeparator` proves an explicit re-run performs
     **zero** stem recomputation (compute counter stays at 1) — the
     cache hit does no work beyond an existence check.
   - `worker_queue.rs::import_auto_queues_and_results_land_in_the_db`
     (second half): re-importing the byte-identical file returns
     `ImportOutcome::Duplicate` and the track is never re-queued —
     content-hash keyed, as required.
   - `stem_separation.rs::cached_stems_decode_back_to_the_same_audio`:
     the FLAC cache round-trips losslessly.
   - The "≤ 1× realtime on M4 hardware" clause is **not** verified here
     (no M4 hardware, no real model) — left unchecked in the PRD.
4. **Stem gains + routability** — ✅
   - `dj-engine/tests/deck_stems.rs::muting_each_stem_removes_its_energy_and_only_its_energy`:
     four single-tone stems; muting each drops its tone by > 40 dB
     (< 1 % of full amplitude) in the offline render while the other
     three stay within 2 %.
   - `::stem_jacks_are_independently_routable`: the four stem jacks
     routed to four separate master channels; each channel carries only
     its own stem (leakage < 1 %), and the jack level follows the
     stem's own gain (post-gain verified at 0.5).
   - `::stem_gains_scale_continuously_and_round_trip_through_patch`:
     gains 0.25/0.5/0.75/1.0 measured within 2 % in the render, params
     survive `save_patch`/`load_patch`, and a reloaded engine renders
     the same gains once stems are re-applied (app-layer state, like
     grids/cues).
   - `::clearing_stems_reverts_to_the_original_mix` and
     `::stems_track_keylock_and_loops_like_the_mix` (the stems path is
     compared against the mix path under keylock + loop rather than
     against absolute amplitudes, since WSOLA smears tones identically
     in both).
   - New E2E golden case `deck-stems-gains` (bass muted, drums at 0.5,
     drums stem jack on ch2) — serialized patch + sidecar; all six
     existing goldens verified byte-identical.
5. **[H] criteria + M4-hardware timing** — ⬜ not verifiable in this
   environment (no ears, no real-world library, no M4). Every feature
   they exercise is implemented and reachable from the UI.

## Test counts (added by M3)

| Suite | Tests |
| --- | --- |
| `dj-analysis` `accuracy.rs` | 3 |
| `dj-analysis` `stem_separation.rs` | 5 |
| `dj-analysis` `worker_queue.rs` | 3 |
| `dj-analysis` `onnx_smoke.rs` (`--features onnx`; skips w/o model) | 1 |
| `dj-engine` `deck_stems.rs` | 5 |
| `dj-engine` `analysis_sync.rs` | 1 |
| `dj-engine` `e2e_golden.rs` (new case) | +1 (7 total) |
| frontend `DeckPanel.test.tsx` (new) | +2 (10 total) |
| frontend `LibraryView.test.tsx` (new) | +3 (12 total) |

## Placeholder vs production-ready

**Production-ready as shipped:**
- BPM / key / auto-beatgrid: pure-Rust DSP, no models, deterministic,
  meets the PRD accuracy bars on the labeled set. (The PRD suggested
  Essentia/ONNX; pure DSP was chosen because it needs no model
  distribution, is trivially deterministic for golden tests, and the
  synthetic-set numbers left large margins. Real-world robustness is
  the [H] criterion and may motivate a model later — the plumbing
  wouldn't change: same `AnalysisResult`, same worker.)
- Worker queue, DB writes, content-hash caching, FLAC stem storage,
  IPC, UI: production paths, fully tested.
- Deck stem playback (jacks, gains, RT handoff, patch persistence):
  production path, fully tested, golden-locked.

**Placeholder-for-real-model:**
- `BandSeparator` is a deterministic DSP fallback, not a
  source-separation model. It guarantees the *contract* (4 stems, sum ≈
  original, cache format, deck behavior) but not musical separation
  quality — that's what htdemucs is for.
- Swap-in plan for macOS/M4: export htdemucs to ONNX
  (`f32[1,2,N] -> f32[1,4,2,N]`, or add chunked inference in
  `OnnxSeparator::separate` for long tracks), build with
  `--features onnx`, set `DJ_STEMS_ONNX_MODEL=/path/to/htdemucs.onnx`,
  and pass `AnalysisSettings { separator: Arc::new(onnx_sep), .. }` in
  `app/src-tauri/src/main.rs`. The CoreML EP is already selected on
  macOS in `onnx.rs`; `onnx_smoke.rs` exercises the real runtime path
  when the env var points at a model (CI-safe: unset/empty ⇒ skip, the
  provider-smoke-test pattern). Then time the M4 CI run to check the
  remaining [A] clause.

## Deviations from the PRD (with rationale)

- **No Essentia/madmom/ONNX for BPM/key** — pure-Rust DSP instead (see
  above; sandbox has no GPU / model downloads, and the accuracy bars
  are met with margin).
- **No demucs weights bundled** — multi-GB download, not
  redistributable here; the ONNX runtime path ships and is smoke-tested
  behind an opt-in feature + env var instead. The tested default is the
  deterministic fallback separator.
- **Stems in E2E sidecars** — like grids/cues in M2, stems are
  app-layer state keyed by library content hash, so the golden case
  carries stem files in `events.json` rather than in the patch. Patches
  persist only the stem *gain params*.
