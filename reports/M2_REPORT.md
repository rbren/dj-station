# Milestone M2 Report — DJ Deck

Built on `main`, on headless Linux (no display, no audio device). All [A]
criteria are wired into the existing GitHub Actions CI
(`cargo test --workspace --release` + frontend vitest); the [H] criteria
need a human with ears/hardware and are left unchecked, but every feature
they exercise is implemented and reachable from the UI.

## What was built

### `builtin.deck` (crates/dj-engine/src/deck.rs)

The full DJ deck module per PRD §7, RT-safe throughout:

- **Transport / pitch fader**: `play_gate` (≥ 1.0 plays, low pauses;
  rising edge after track end restarts), `speed` (±10 → ±`pitch_range`,
  a param defaulting to 0.08 = ±8 %, up to ±0.5), `phase_nudge` (±10
  bends the rate ±50 % while held — jog/scratch input), `reverse` param.
- **Hot cues**: 8 slots. `cue_trig1..8` input jacks jump to the slot's
  position on a rising edge (gate high ≥ 1.0); position set/cleared via
  the control API. With **slip mode** on (param `slip`), a held cue plays
  from the cue point while the ghost playhead keeps advancing; releasing
  the trigger returns to where the track "would have been".
- **Loops**: an active region (start/end secs) with enable/disable,
  halve/double, and a `loop_toggle` input jack (rising edge toggles).
  Loop exits under slip also return to the ghost position. Saved loops
  are named library rows (see below).
- **Manual beatgrid**: `(bpm, anchor_secs)` per deck. Built by tap tempo
  (≥ 2 taps average the inter-tap interval and anchor on the first tap;
  a stale tap run > 2 s resets), shifted by nudge (±delta secs), and
  re-anchored at the playhead (`anchor_here`). The grid extends in both
  directions from the anchor.
- **Clock outputs**: `beat_clock` / `bar_clock` (10 ms, +10.0 pulses when
  the playhead crosses a grid line; 4 beats/bar), `beat_phase` (0→10
  saw within each beat), `bpm_cv` (effective BPM = grid BPM × |rate|,
  scaled 1.0 per 120 BPM). Pulses are emitted at the exact crossing
  sample, so they land within one block by construction.
- **Keylock**: two-voice granular time-stretch (40 ms Hann grains, 50 %
  hop) reading at the virtual (tempo-scaled) position while pitch stays
  1:1 — with **WSOLA alignment**: each new grain start is searched within
  ±4 ms of the ideal position to maximize cross-correlation (5 ms window)
  against the natural continuation of the running grain, keeping joins
  phase-coherent. Bounded work, no allocation (scratch preallocated at
  construction). Without the alignment step, naive OLA showed a
  systematic ~−15 Hz drift on a 440 Hz tone at +8 % (measured during
  development); with it, pitch holds well within ±10 cents.
- **Beat-sync**: `Engine::deck_sync(b, Some(a))`. Decks publish
  position/rate/grid/playing atomically (`DeckShared`, seqlock-style
  even/odd stamp; single RT thread reads a consistent snapshot and
  extrapolates the master's position by the block-time delta). The
  follower applies: rate = master_rate × (master_bpm / own_bpm), plus a
  proportional phase correction (gain 4.0 per beat of error, clamped to
  ±5 % of rate). On sync engage a one-shot **phase snap** aligns
  `fract(beat)`; the snap is deferred until the master is actually
  playing/publishing (masters can be later in graph order or start
  later), then the P-controller holds the lock. Pitch-fader/nudge input
  is ignored while synced (master's tempo wins); nudge still works on
  the master and the follower tracks it.
- **RT discipline**: the RT module owns plain state; control → RT via a
  bounded SPSC `rtrb` ring of `DeckCmd` (load/seek/cue/loop/grid/sync);
  replaced `Arc<TrackData>`s are shipped back over a garbage ring and
  dropped on the control thread (same pattern as `playback.rs`). Decode +
  sample-rate conversion happen off the RT thread at `deck_load` time.
  Waveform peaks (`deck_waveform`, N buckets of |peak|) are computed
  control-side from the decoded copy the control half retains.

### `builtin.crossfader` (crates/dj-engine/src/mixer.rs)

Stock two-channel stereo crossfader: `a_l/a_r/b_l/b_r` in, `xfade` in
(−10 = full A, +10 = full B, attenuverter-capable like any input),
`out_l/out_r`. Equal-power law: gain_a = cos(x·π/2), gain_b = sin(x·π/2)
for x ∈ [0, 1], so the center sits at −3 dB per side.

### Library: DJ metadata (crates/dj-library)

New tables + API, all keyed by track id: `track_cues` (slot 0–7, position
secs, label; upsert per slot), `track_loops` (named saved loops), and
`track_beatgrids` (bpm + anchor, one per track). Validation (slot range,
loop start < end, bpm > 0) and round-trip/persistence tests included.
Per PRD §7 these are **track metadata in the library DB** — they survive
across patches; the patch only persists the deck's loaded track path and
sync partner (plus knob/param state as for any module).

### App layer

- **Tauri IPC** (app/src-tauri/src/main.rs): `deck_load` (loads by
  library track id, then re-applies stored grid/cues/first saved loop),
  `deck_status`, `deck_waveform`, `deck_seek`, `deck_set_cue` (writes
  through to the library), `deck_set_loop` / `deck_loop_enable` /
  `deck_loop_halve` / `deck_loop_double` / `deck_save_loop` /
  `deck_saved_loops`, `deck_set_beatgrid` / `deck_tap_tempo` /
  `deck_nudge_beatgrid` / `deck_anchor_here` (all persist the resulting
  grid), and `deck_sync`. `load_patch` re-applies library metadata to
  every deck in the loaded patch.
- **Frontend**: `src/deck.ts` (typed IPC client, mockable `DeckApi`);
  `WaveformView` (SVG overview + 8 s zoom strip around the playhead,
  peaks, playhead, numbered cue markers, loop shading, click-to-seek);
  `DeckPanel` (track selector, time/BPM readout, play/pause via the
  `play_gate` knob, keylock/slip/reverse toggles, sync selector over the
  other deck instances, 8 hot-cue buttons — set on empty / jump on set /
  right-click clears — loop in/out/toggle/halve/double/save + saved-loop
  buttons, tap/nudge/anchor grid controls), registered as the
  `builtin.deck` custom UI through a stable context-fed wrapper so the
  rack's generated panel (jacks + knobs) still renders around it.

## Acceptance criteria — evidence

All engine tests below live in `crates/dj-engine/tests/deck.rs` /
`deck_library.rs` and run in CI via `cargo test --workspace --release`.

1. **Two decks + crossfader gain curves** —
   `two_decks_through_crossfader_follow_equal_power_gain_curves`: two
   deck instances (480 Hz / 1200 Hz tones) into `builtin.crossfader`,
   offline render; the `xfade` input is swept −10 → +10 in 11 steps and
   each deck's contribution is measured by DFT at its frequency. Every
   point matches cos/sin equal-power gains within 2 %, center at −3 dB.
   Both decks render and play simultaneously in the same graph.
2. **Cues/loops persist in the library, reappear in a fresh patch** —
   `cues_and_loops_set_via_api_reappear_in_a_fresh_patch`: session 1
   imports a ramp WAV into a real `Library`, sets cues 1/5, a saved
   loop, and a beatgrid via the API (engine + library write-through as
   the shell does), then everything is dropped. Session 2 opens a fresh
   `Library` handle on the same data dir, a fresh engine and a fresh
   patch, reloads the track — cues/grid/loop reappear, and firing the
   restored cue jack audibly jumps playback to 3.25 s (verified in the
   rendered ramp samples); the restored loop region loops.
3. **Beat-sync ±1 ms over 60 s** —
   `syncing_deck_b_to_deck_a_aligns_phase_within_1ms_over_60s`: manual
   grids 128 BPM/0.1 s (A) and 120 BPM/0.3 s (B), B synced to A, 61 s
   offline render of both decks' `beat_clock`s. Every one of A's ~130
   beats after t = 1 s has a matching B pulse within 48 samples (1 ms) —
   typical worst offset in the run is < 0.2 ms — and total beat counts
   match (tempo aligned, sustained to the end of the render).
4. **beat_clock on the grid, ADSR envelopes at beats** —
   `beat_clock_lands_on_beatgrid_and_drives_adsr_envelopes`: 120 BPM
   grid anchored at 0.25 s; all pulses in a 3 s render land within one
   128-sample block of the grid timestamps; `beat_clock → adsr.gate`
   with `osc → vca` produces an envelope onset (> 2× the pre-beat
   level) right after every beat.
5. **Keylock ±10 cents at ±8 %** —
   `keylock_holds_pitch_within_10_cents_at_plus_minus_8_percent`:
   440 Hz tone rendered at rate 1.08 and 0.92 with keylock on;
   zero-crossing pitch tracking over 3 s reads within ±2.55 Hz
   (= 10 cents) of 440. Tempo is verified real (track ends at 10 s/rate,
   ±window), and the no-keylock control reads ~475 Hz at +8 %.

Plus non-criterion coverage: hot cue jump + slip ghost return
(`hot_cue_trigger_jumps_and_slip_returns_to_ghost`), loop wrap /
halve/double / slip loop exit / `loop_toggle` jack
(`loop_wraps_slip_loop_exit_returns_to_ghost_and_jack_toggles`), reverse
(`reverse_plays_backward`), tap/nudge/anchor grid building
(`tap_tempo_nudge_and_anchor_build_a_beatgrid`), and patch persistence of
track + sync + params
(`deck_track_sync_and_params_persist_through_patch_save_load`).

**[H] criteria** (left unchecked, ready to try): keylock listening test,
hand beat-matching with pitch fader + phase nudge + waveforms, and
`MIDI.jog → deck.phase_nudge` (the deck has no MIDI code; map a jog CC in
the MIDI module and wire it to `phase_nudge`).

## E2E golden audio cases

Two new serialized-patch cases (committed under
`crates/dj-engine/tests/e2e/`), regenerable via
`./scripts/regen-goldens.sh`:

- `deck-loop-keylock` — one deck, keylock on at +8 %, looping 0.5–1.5 s,
  125 BPM grid; ch1 audio, ch2 beat_clock.
- `deck-crossfader-sync` — two decks, different grids, B synced to A,
  crossfader at −5 into a mono master.

The sidecar `events.json` gained an optional `decks` section (grid, cues,
loop) since that state intentionally lives outside the patch; existing
cases are unchanged. **The four M0/M1 goldens remained byte-identical**
(verified via `git status` after a full regen — only the two new cases
appeared).

## RT safety

`rt_safety.rs`'s stress patch now additionally runs two decks — tracks
loaded, loops enabled, one deck keylocked at +8 % **and** beat-synced —
through the crossfader. The allocation tripwire (panicking global
allocator armed on the RT thread) and the xrun stress test pass with the
decks active; keylock's WSOLA search is bounded work on preallocated
buffers.

## Verification (full CI-equivalent pass)

- `cargo test --workspace --release` — 62 tests, all passing
  (dj-engine 40 across 10 integration suites incl. the new `deck` (9)
  and `deck_library` (1) suites and 6 golden cases; dj-library 22 across
  4 suites incl. the new DJ-metadata round-trip tests).
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
- `cargo fmt --all --check` — clean.
- `app`: `npm run lint` (ESLint + Prettier) clean; `npm test` — 60
  vitest tests passing (14 new: WaveformView 6, DeckPanel 8);
  `npm run build` clean.
- `cargo build --manifest-path app/src-tauri/Cargo.toml` (frontend built
  first, matching CI order) — clean.

## Deviations / notes

- **Loop persistence semantics**: PRD §7 says cues/loops/beatgrids are
  library track metadata. The deck's *active* loop region is engine
  state (persists across save/load of the patch only as long as the
  library rows exist); "saved loops" are explicit named library rows
  (`deck_save_loop`), and the app re-applies the first saved loop as the
  active region on load. This matches DJ software conventions (active
  loop vs. saved loop banks).
- **Sync while keylocked** follows the PRD's resolved decision (§12):
  rate changes come from the master; keylock only decouples pitch.
- **Keylock quality**: WSOLA with a 4 ms search window aligns periodic
  content with fundamentals ≳ 250 Hz exactly; lower fundamentals still
  crossfade smoothly (40 ms grains) but with more phasiness — acceptable
  for v1 per PRD ("keylock v1" quality bar is the [H] listen test).
- **Zoomed waveform** reuses the overview's 800-bucket peak resolution
  (≈ 0.25 s/bucket on a 3–4 min track); a per-zoom-level peak pyramid is
  a straightforward follow-up if the [H] review wants finer detail.
- The deck UI polls `deck_status` at 100 ms (same cadence as the
  existing telemetry poll); no push channel was added.
