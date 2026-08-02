# Milestone M1 Report — Sound Library + Playback

Built directly on `main` (per process change mid-milestone), on headless
Linux (no display, no audio device). All [A] criteria are wired into the
existing GitHub Actions CI (`cargo test --workspace --release` + frontend
vitest suite); network-dependent paths are covered by local mock HTTP
servers so CI stays deterministic.

## What was built

- **`crates/dj-library`** — the sound library (PRD §8.1):
  - **SQLite DB** (rusqlite, bundled) under the single per-user data
    directory (`$DJ_STATION_DATA` override, else platform data dir +
    `dj-station`): `tracks` (title/artist/album, file path, SHA-256
    content hash, format, duration/sample-rate/channels, source +
    source_ref, license kind/name/URL/attribution, `analysis_status` +
    `bpm`/`musical_key` placeholders for M3), `tags`, `crates` +
    `crate_tracks` (playlists), `watch_folders`. Thread-safe behind an
    `Arc` (internal mutex) so the watcher, downloads, and IPC share one
    handle.
  - **Programmatic import** (`Library::import_file`): streams a SHA-256
    content hash (byte-identical files dedupe to one row), best-effort
    symphonia metadata probe (tags, duration, SR, channels; filename
    fallback), license + source stored per track, new tracks queued for
    analysis. This is the API drag-and-drop will call later.
  - **Watch-folder auto-import**: polling scanner (250 ms default,
    consistent with the engine's hot-reload watcher — no native deps),
    recursive, imports mp3/m4a/aac/flac/wav/aiff. A file is imported once
    its size+mtime are stable across two consecutive scans (no hashing of
    half-copied files). Folders are re-read from the DB every pass, so
    `add_watch_folder` takes effect live.
  - **Acquisition provider framework** (PRD §8.3): the
    `AcquisitionProvider` trait (search / acquire / license) with
    `Acquire::Download { url, headers, filename } | DeepLink { url }`, and
    an `AcquisitionHub` that fans a query out across all enabled providers
    in parallel (per-provider failures are collected, not fatal), tags
    every result with source + license, downloads straight into
    `<data-dir>/downloads/` + imports with the provider's license, and
    resolves deep links through an injectable dispatcher (system browser
    in the app, a recorder in tests).
    - **iTunes Search** (keyless): commercial catalog, 30 s previews,
      `DeepLink` to `trackViewUrl`.
    - **Freesound** (`FREESOUND_API_KEY`): token-authenticated search +
      download; imports the HQ-MP3 preview rendition (full-quality
      originals need the interactive OAuth2 flow — documented fast-follow;
      the preview is the complete sound as MP3). CC license URL → kind
      classification, attribution string built per Freesound norms.
    - **Jamendo** (`JAMENDO_CLIENT_ID`): full CC songs, direct
      `audiodownload` MP3.
    - **Internet Archive** (keyless): `advancedsearch.php` search;
      `acquire` resolves the item's file list via the metadata API and
      picks the best audio file (MP3 > FLAC > other).
    - **Musopen**: documented fast-follow — its API requires
      manually-approved accounts, so it can't be exercised in CI at all.
- **`crates/dj-engine`** — **Playback module** (`builtin.playback`):
  - Inputs `play_gate` (≥ 1.0 plays, low pauses in place; rising edge
    after a finished track restarts) and `speed` (pitch-style, +1.0 =
    double rate, −1.0 = half). Outputs `audio_l`/`audio_r` (mono files
    feed both). `loop` toggle param.
  - Decoding (symphonia: mp3/aac/m4a/flac/wav/aiff) happens fully on the
    control thread; sample-rate conversion to the engine rate is folded
    into the linearly-interpolated playback increment, so a file at the
    engine rate with `speed = 0` reproduces its samples exactly (bit-exact
    null path). Track handoff to the RT thread is an SPSC ring of
    `Arc<TrackData>`; replaced tracks return on a garbage ring and are
    dropped off-RT — no allocation/locks/IO on the RT path.
  - Patch persistence: a Playback node's loaded track path is saved in its
    module file and reloaded with the patch.
- **Tauri shell** — library + hub in app state, watch-folder scanner
  started at boot; new IPC commands: `library_tracks`, `library_search`,
  `provider_search`, `import_track`, `download_track`, `open_store_page`
  (opens the system browser and returns the URL), `add_watch_folder`,
  `watch_folders`, `playback_load` (by library track id).
- **Frontend** — `LibraryView` (new Library tab next to the Rack): one
  search box fanning out to the local library and all enabled providers;
  provider results with source tags, license tags, preview links, and
  Download / Open Store actions; local track table (title/artist/length/
  source/license/analysis status); provider errors surfaced inline.
  `LibraryClient` mirrors the M0 `EngineClient` pattern (Tauri IPC with a
  headless fallback; tests inject a mock).
- **CI** — the new crate rides the existing `cargo test --workspace
  --release` job; optional `FREESOUND_API_KEY`/`JAMENDO_CLIENT_ID` secrets
  are plumbed through to enable the real-network smokes (which skip
  gracefully when absent). A fourth serialized-patch E2E golden case
  (`playback-tone-vca`) joins the M0 three.

## Acceptance criteria → verification

Run everything: `cargo test --workspace && (cd app && npm ci && npm test)`
or `./run.sh --no-launch`.

| # | Criterion | Verified by |
|---|-----------|-------------|
| 1 | **[A]** File copied into watch folder lands in the library DB within seconds | `cargo test -p dj-library --test watch` — `file_copied_into_watch_folder_is_imported_within_seconds` (registers a folder, starts the watcher, copies a WAV in, asserts it appears with `source = "watch"` and `analysis_status = "queued"` well inside 5 s). Plus subfolder/non-audio/duplicate handling and folders added at runtime. |
| 2 | **[A]** Search fans out across enabled providers; results carry source + license tags; preview URLs resolve | `cargo test -p dj-library --test providers` — `unified_search_fans_out_across_enabled_providers_and_isolates_failures` (4 mock providers, one returning 500: results from the other 3 all tagged with source + license kind; the failure lands in `errors`, not a panic) and `itunes_search_results_carry_source_license_and_resolvable_preview` (preview URL fetched from the mock server, HTTP 200 asserted). UI side: `app/tests/LibraryView.test.tsx` (tags + preview links rendered, errors surfaced). Real-network smokes: `--test real_network` (keyless iTunes/IA run by default, soft-skip on network failure; "and play" is inherently the [H] half — headless CI verifies resolution, not audition). |
| 3 | **[A]** Freesound/Jamendo result downloads directly into the library | Same suite — `freesound_result_downloads_directly_into_the_library` (mock server; asserts the real client sends `Authorization: Token …`, the file lands in `<data>/downloads/`, and the DB row carries source `freesound`, the CC-BY license, and the provider track id) and `jamendo_result_downloads_directly_into_the_library`; `downloading_the_same_content_twice_deduplicates` covers the re-download path; `internet_archive_resolves_best_audio_file_and_downloads` covers IA. **No Freesound/Jamendo credentials exist in this environment**, so CI's authoritative coverage is these mocks exercising the identical download-import code path; `real_network.rs` upgrades to live APIs automatically when the env keys are present (now plumbed through CI secrets). |
| 4 | **[A]** iTunes result triggers a deep-link open of the correct store URL | `itunes_result_dispatches_deep_link_to_the_store_url` — asserts `acquire` is `DeepLink`, the URL equals the mock result's `trackViewUrl`, and the (recorded) dispatcher was invoked with exactly that URL. No browser is opened headless; the app dispatches via the `open` crate in `open_store_page`. UI: `LibraryView` "Open Store" test. |
| 5 | **[A]** Playback: null test; speed +1 doubles rate (duration + pitch); VCA attenuation | `cargo test -p dj-engine --test playback` — `null_test_render_matches_source_file` (offline render == source samples within 1e-6, then silence), `speed_plus_one_doubles_playback_rate` (1 s file finishes by 0.55 s; zero-crossing pitch reads ~880 Hz vs the 440 Hz control), `output_through_vca_attenuates_correctly` (VCA at 0.5 gain halves every sample vs a reference render). Extras: stereo routing, gate pause/resume, loop wrap, patch save/load round-trip. E2E: `cargo test -p dj-engine --test e2e_golden` — new `playback-tone-vca` case (committed test tone → Playback → VCA → Audio Out vs committed golden). |
| 6 | **[A]** Library and licenses persist across an app restart | `cargo test -p dj-library --test library` — `library_and_licenses_persist_across_restart` (import with a CC-BY license + tag + crate + watch folder, drop the `Library`, reopen the same data dir, assert everything — including the exact license — is intact). |

## Decisions & known gaps / deviations

- **Freesound downloads use the HQ-MP3 preview rendition**, not the
  original file: original downloads require Freesound's interactive OAuth2
  authorization-code flow (browser round-trip), which can't run in CI and
  wasn't needed to prove the download-import path. The preview is the
  complete sound as a usable MP3. Original-quality OAuth2 download is a
  documented fast-follow.
- **Musopen is not implemented** (fast-follow, per the PRD's "if
  straightforward" clause): its API issues keys only via manually-approved
  requests, so it cannot be integrated or tested from this environment.
  The provider framework makes adding it mechanical.
- **"Preview URLs resolve and play"**: resolution is asserted (mock-served
  bytes fetched over HTTP; keyless real-network smokes when the network
  allows); actually *playing* a preview is audition, i.e. the [H] side of
  that criterion. Preview links are rendered in the UI.
- **Real-network tests**: keyless (iTunes, Internet Archive) run by
  default and soft-skip on any network/API failure (deterministic CI);
  keyed (Freesound, Jamendo) run only when `FREESOUND_API_KEY` /
  `JAMENDO_CLIENT_ID` are set — no such credentials exist here, so those
  paths were validated against mocks only.
- **Watch folder**: no default folders are auto-registered (PRD suggests
  `~/Downloads`); registration is explicit via `add_watch_folder` — a
  deliberate choice to avoid surprise bulk imports on first launch.
  Polling (250 ms) rather than inotify/FSEvents, matching the M0
  hot-reload watcher's no-extra-native-deps approach.
- **Analysis pipeline** is M3: imports set `analysis_status = "queued"`
  and `bpm`/`musical_key` stay NULL; `Library::analysis_queue()` is the
  hook the M3 workers will consume.
- **Playback speed** is a raw rate multiplier (2^speed) — no keylock
  time-stretch; that's the M2 deck's job per the PRD.
- **process env mutation** in `hub_from_env_enables_keyed_providers_only_with_keys`
  (sets/removes the two key vars): Rust runs tests in one process, but the
  test is self-contained and the other provider tests construct providers
  explicitly, so ordering can't change outcomes.
- GUI-level flows (as in M0) are verified at component level (vitest +
  jsdom with an injected mock client), not by driving a real Tauri window;
  the shell compiles in CI and the IPC commands are thin wrappers over the
  tested library APIs.

## For the verifier

```sh
git clone ssh://git@github.com/rbren/dj-station.git && cd dj-station
./run.sh --no-launch     # full build + all tests + lint
```

Piecemeal:

```sh
cargo test -p dj-library                 # 20 tests: DB, watch, providers (mock), smokes
cargo test -p dj-engine --test playback  # 7 Playback module tests
cargo test -p dj-engine --test e2e_golden  # 4 golden cases incl. playback-tone-vca
cd app && npm ci && npm test             # 26 UI tests incl. LibraryView (6)
```

Optional live-API checks: set `FREESOUND_API_KEY` and/or
`JAMENDO_CLIENT_ID` and re-run `cargo test -p dj-library --test
real_network -- --nocapture`.
