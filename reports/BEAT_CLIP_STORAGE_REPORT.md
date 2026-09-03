# Beat clip storage — bleed sidecars vs. one FLAC + timestamps

Investigation only; nothing implemented. Question asked: beat clips file
their bleed in separate FLACs — should the whole captured area (bleed +
loop) be one FLAC with metadata timestamps marking loop start/end and the
beats?

## What is stored today

Store is `<data_dir>/beat-clips/`, ids minted `b<n>`
(`crates/dj-analysis/src/clip.rs:844-852`). Per clip:

- `b<n>.json` — `BeatClipMeta` (`clip.rs:889-930`): name, `bpm`, `beats`,
  `file`, `stems`, the `edit` that made it, and `leftBleedMs` /
  `rightBleedMs`.
- `b<n>.flac` — the LOOP only, cut/padded to exactly `beats` whole beats
  at `bpm` by `pad_to_beats` (`clip.rs:602-627`, written at
  `clip.rs:1173,1188`).
- `b<n>-bleed-l.flac` / `-r.flac` — the bleed bookends, written only when
  non-empty and deleted when a revision drops them (`clip.rs:962-964`,
  `1189-1196`). They are cut from the same rendered edit either side of
  the saved span (`app/src-tauri/src/clip.rs:584-596`).

Beat positions are **not** stored as timestamps and do not need to be:
the loop is exactly `beats` even beats at `bpm`, so beat *k* is
`k*60/bpm`. The only per-beat metadata is the downbeats, read out of the
saved edit's grid, itself cut to the clip at save time
(`app/src-tauri/src/clip.rs:622`, surfaced by `beat_clip.rs:84-90`).

**Why the bleed is a separate object at all** — and this is the part
worth keeping — is not the file layout, it is that the bleed is never
mixed into the loop so the player can gate it per pass: the right bleed
is silent on a clip's first pass, the left bleed on its last
(`crates/dj-engine/src/playback.rs:110-155` `ClipBleed::tap`, callers
`decks.rs:1563` and `beat_clip.rs:428`). The Grid does the same thing on
a timeline, laying each bookend where the material came from
(`app/src/gridTransport.ts:629-643`). The `*BleedMs` fields already are
the proposed timestamps; only the samples live elsewhere.

## Evaluating the proposal

The layout would be one FLAC `[left bleed | loop | right bleed]` plus
`startSecs`/`endSecs` in the record. Feasible — the write and read sides
are one module (`load_beat_clip` `clip.rs:1066-1087`, `write_beat_clip`
`clip.rs:1160-1202`), and only four call sites outside it read clip files
(`app/src-tauri/src/beat_clip.rs:179,268,317,342`).

What it buys:

1. **One fetch and one decode instead of three in the webview.** The
   Grid primes a clip's loop and then each bookend separately, per clip
   *and per tempo* (`gridTransport.ts:229-235,253-270`), keeping a second
   `#bleed` cache keyed by side. With one buffer, all three voices are
   offsets into it — `start(when, offset, duration)` is already how
   bookends are laid (`gridTransport.ts:634-640`).
2. **One stretch instead of three.** Loop and each bookend are WSOLA-ed
   to the grid tempo independently (`beat_clip.rs:405-419`); stretching
   the whole capture once keeps phase continuous across the seam, which
   is exactly the join the bleed exists to smooth.
3. Fewer files (3 → 1 + json); `beat_clip_rev` (`clip.rs:1019-1040`)
   stops ignoring bleed files (today it only fingerprints `.json` +
   `.flac`, and gets away with it because the json is always rewritten).

What it costs:

1. **It is not literally "the captured area".** `pad_to_beats` silence-
   fills a fractional tail or trims an overhang, so the loop's end is not
   the source position where the right bleed begins. The file is a
   container, and `endSecs - startSecs == beats*60/bpm` must stay the
   authority over the audio.
2. **Do not push offsets onto the RT thread.** `TrackData`/`ClipBleed`
   are whole buffers read by frame offset (`playback.rs:120-155`). Slice
   the decoded capture into the same three buffers inside
   `load_beat_clip`, and decks, the Beat Clip module and every golden are
   untouched. Teaching `TrackData` an offset+length view would put a
   storage change into the audio callback for no gain.
3. `beat_clip_peaks` (`beat_clip.rs:341-347`) peaks the whole decoded
   file — left as is it would draw the bleed into the Grid's waveforms.
4. The Clip editor is unaffected: it reopens a clip from its stored
   `edit` and re-renders from the source tracks
   (`app/src-tauri/src/clip.rs:707-762`), and ClipLive cuts its own bleed
   windows out of the live render (`app/src/clipLive.ts:150-166,609-648`).
   It never reads the stored bleed FLACs — only the two ms numbers.
5. Tests pin the current layout: `crates/dj-analysis/tests/clip_edit.rs`
   (sidecar name at :918, behaviour at :644,742,906-921) and
   `crates/dj-engine/tests/integration/track_fx.rs:141,174`. No e2e
   golden uses bleed, so goldens stay byte-identical as long as the
   decoded loop samples do.

Migration is cheap: the store is user-local and per-clip, and the records
already carry the bleed lengths. Prefer read-side compatibility (a record
with no `startSecs` means legacy sidecars) with conversion on the clip's
next save, over a startup rewrite like `migrate_beat_clips`
(`clip.rs:1045-1061`) — a rewrite would bump `beat_clip_rev` for every
clip (harmless: the Grid re-reads) but rewrites user audio for no
immediate benefit.

## Recommendation, in priority order

- **P1 — consolidate storage behind `load_beat_clip`.** Write one FLAC
  per clip, add `bleedLeftSecs`/loop-span fields, keep the
  `(meta, loop, BleedAudio)` return shape by slicing on read, and read
  legacy sidecars when the new fields are absent. Blast radius: two
  functions in `dj-analysis::clip` plus their tests. Nothing in the
  engine, the RT thread, the IPC surface or the Clip editor changes.
- **P2 — take the actual win in the webview.** Storage alone makes the
  Grid *worse* (three IPC calls that each decode the same file), so pair
  P1 with a `beat_clip_audio` that can return the capture plus its span,
  and collapse `gridTransport`'s `#bleed` map into offsets. This is where
  the fetch/decode/stretch savings and the continuous seam phase live —
  if only one of P1/P2 ships, it should be both or neither.
- **P3 — slice `beat_clip_peaks` to the loop span** as part of P1.
- **Do not** store per-beat timestamps. A beat clip is cut to an even
  grid by construction, and decks (`cycle_beats`, tempo stretching) and
  the Grid's one-column-per-beat model all assume `bpm` + `beats`; a
  `times[]` array would be a second source of truth that can disagree
  with them. Keep the downbeats where they are (the saved edit's grid).
- **Do not** move bleed gating or mixing anywhere: the head/tail rule
  (`playback.rs:126-155`) is the design, and it is orthogonal to how the
  bytes are filed.

Net: the proposal is sound and low-risk, but it is a plumbing
simplification (fewer files, fewer IPC round trips, one stretch), not a
correctness fix — the current split is deliberate and documented. Worth
one focused ticket doing P1+P2+P3 together; not urgent.

---
_This report was written by an AI agent (OpenHands) on behalf of the
repository owner._
