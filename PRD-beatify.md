# PRD: Beatify — dj-station tab

**Status:** Draft v1
**Scope:** One tab in the existing dj-station app. Takes a raw audio file in, produces a tempo-locked track with an exact beat grid, and lets the user browse and audition it. Clip building is a separate surface and is out of scope here.

---

## 1. What Beatify is

Three screens' worth of work, one job: **turn an arbitrary audio file into material with mathematically perfect beats.**

1. **Analyze** — detect beats, fit a grid, warp the audio onto it.
2. **Confirm** — an import modal where the user checks the grid is right before committing.
3. **Browse** — the track, gridded, with transport, zoom, beat-snapped selection, and looping.

The output is a *beatified track*: a **selected region** of the source, rendered at constant tempo, plus a two-number grid that describes it exactly. Everything downstream in dj-station consumes that and never re-analyzes.

**There are no bars.** Beatify knows about beats and nothing else — no meter, no downbeats, no time signature. Bar-like grouping exists only as a ruler setting for the eye (§4.1). Nothing in the analysis, the warp, or any cut depends on it.

**The region is the import.** Whatever the user selects becomes the track; everything outside it is discarded. There is no extrapolation, no partially-trusted span, no grid applying to audio it was never fitted against.

**Not in scope:** stem separation, clip building, racks, performance mode.

---

## 2. Analysis pipeline

### 2.1 Beat detection — Beat This!

**Use [`beat_this`](https://github.com/CPJKU/beat_this) (CPJKU, ISMIR 2024) as the primary tracker.** <cite index="13-1">Install with `pip install beat-this`; it needs PyTorch 2.0+ plus `tqdm einops soxr rotary-embedding-torch`, and ffmpeg for non-wav input.</cite> <cite index="13-1">Code and weights are MIT.</cite>

Two reasons it wins here over madmom:

- <cite index="9-1">It's a transformer-based tracker with high accuracy and generality, and because it drops DBN postprocessing it handles time-signature changes and high tempo variation</cite> — a DBN imposes a tempo prior that smooths over exactly the drift we need to see in order to remove it.
- <cite index="13-1">It ships three independently-seeded checkpoints (`final0/1/2`).</cite> Running all three gives a free song-level confidence signal with no training and no second library.

```python
from beat_this.inference import File2Beats

def detect(path):
    runs = []
    for ckpt in ("final0", "final1", "final2"):
        f2b = File2Beats(checkpoint_path=ckpt, device="cuda", dbn=False)
        runs.append(f2b(path)[0])       # beats only — downbeats discarded
    return runs
```

**ANL-1.** Run all three seeds. Compare fitted tempo across them.
**ANL-2.** Score agreement on three axes — tempo spread, phase agreement, metrical relationship — per MOD-A4. They fail differently and must not be collapsed into one number before the user sees them.
**ANL-2a.** Detection can be re-run scoped to a contiguous region (MOD-A8). Re-run with a few beats of context beyond the region edges, then discard the context beats; the model reads surrounding audio and a hard boundary distorts the edges.
**ANL-3.** **Discard the downbeats.** `File2Beats` returns them; Beatify ignores them. Meter, time signature, and bar numbering are not computed, not stored, and not used.

Nothing needs them. The grid is `phase + n × period` over beats. The warp aligns beats. Cuts land on beats. Layering works because two clips share a beat period. Meter was only ever a label sitting on top of that, and downbeat detection is the least reliable output the tracker produces — roughly 15 points of F-measure below beats on ordinary 4/4, worse on anything unusual. Dropping it removes the weakest link in the chain and costs nothing.

**ANL-3a.** Odd meters therefore need no handling at all. 7/4, 3/4, 5/8, and material that changes meter mid-track all run the identical code path with identical guarantees, because none of them are distinguishable from Beatify's point of view. They are all just beats.
**ANL-3b.** The one genuine pulse question — is a compound-meter track felt at the fast pulse or the slow one? — is the ×2/÷2 problem wearing a different hat. It changes clip lengths, never alignment, and the reading controls in §3.8 already cover it.
**ANL-4.** Use `Audio2Frames` — not just `File2Beats` — to keep the frame-level activation curve. <cite index="13-1">The package exposes `Audio2Beats` for tensors plus `Audio2Frames` for framewise logits and `Spect2Frames` for spectrograms.</cite> The default call discards confidence, and confidence is what drives the density rendering in §4 and §5.
**ANL-5.** Small model (`small0/1/2`, ~8 MB) is the fallback for constrained installs. Don't ship it as default.

**Not used:** madmom (kept only as an optional cross-check if seed disagreement is common in practice), Essentia, librosa. One tracker, three seeds, is enough.

### 2.2 Grid fit

**ANL-6.** Least-squares fit `t = phase + n × period` over the detected beats, with iterative outlier rejection — a doubled or missed beat is a large residual and must not drag the line.
**ANL-7.** Target tempo = median of a smooth tempo curve fitted to the detections. Optionally snap to the nearest 0.5 BPM. **Do not force integer BPM** — it buys a rounder number at the cost of warping the entire track.
**ANL-8.** Model frames are ~20 ms, so single detections carry roughly 5.8 ms of quantization noise. Never treat one detection as ground truth.

### 2.3 Warp

**ANL-9.** Fit a **smooth tempo curve**, place anchors every *k* beats where each anchor is a local least-squares fit over its window, and time-stretch between anchors so every beat lands on its grid line exactly.
**ANL-9a.** Anchors go every *k* beats, full stop. No downbeat preference, since there are no downbeats.

Anchor noise falls as `1/√k`; drift-tracking error grows with `k²`. The minimum between them is real, it is material-dependent, and it is what the modal's slider exposes.

**ANL-10.** Stretch with **Rubber Band** (R3 engine, transient-preserving mode). Corrections are ~1–2%, transparent at that size.
**ANL-11.** **Never resample.** 1.7% is ~29 cents — plainly audible on tonal content. Pitch-preserving only.
**ANL-12.** Render the warped audio once at import. Nothing is stretched at playback time.
**ANL-13.** Keep the original file and the warp map. If the grid is ever edited, re-warp **from the original** — never warp already-warped audio.

### 2.4 Cost

Analysis is a few seconds on GPU, tens of seconds on CPU; warp render is roughly realtime. The modal shows progress and is not dismissible mid-analysis.

---

## 3. Import modal

Reference implementation: `clip-builder-v2-import-modal.html`. The modal's job is **inspection, not configuration** — it exists so the user can prove the grid is right before committing to it. Every control is a bailout; the common case is open, glance, commit.

### 3.0 Flow

The modal runs in **two phases**, and they are sequential because the second is meaningless until the first settles. Detection answers *where are the beats*. Alignment answers *how hard do we force them*. Getting a warp slider before you trust the detections is just moving a number.

```
  ┌─ PHASE 1 · DETECTION ──────────────────────────────┐
  │  auto-run on open (3 seeds, whole track)           │
  │  → agreement score                                 │
  │  → play, listen, select a cleaner region, re-run   │
  │  → ÷2 ×2 ½ ↻ corrections                           │
  └────────────────────────────────────────────────────┘
                          ↓ detections settled
  ┌─ PHASE 2 · ALIGNMENT ──────────────────────────────┐
  │  warp slider → flam / stretch                      │
  │  cut-point scope, lead-in                          │
  │  click track, sync check                           │
  └────────────────────────────────────────────────────┘
                          ↓
                    [ Cut into beats ]
```

**MOD-A1.** Analysis starts **automatically on open**, whole track, all three seeds. No "Analyze" button — the common case should present a finished result, not a form.
**MOD-A2.** Phase 2 controls are visible but inert until phase 1 has a result. They don't hide; hiding controls that will appear later is disorienting. They dim.
**MOD-A3.** Re-running detection **resets phase 2** to the recommended default and says so. A warp strength tuned against old detections is meaningless against new ones.

### 3.0.1 Agreement score

<cite index="13-1">Three independently-seeded checkpoints ship with the package</cite>, so a confidence signal costs one extra inference pass each and no extra library.

**MOD-A4.** Compute and display three things, because they fail differently:
   - **Tempo spread** — max minus min of the three fitted BPMs. Under 0.1 BPM is unanimous.
   - **Phase agreement** — percentage of beats where all three seeds land within ±20 ms of each other.
   - **Metrical agreement** — whether any seed's tempo is a 2:1 or 1:2 relative of the others. This is a *different* failure from jitter and must be named separately; averaging it away would be wrong.

**MOD-A5.** Roll up to a verdict, but keep the components visible:

| Verdict | Condition | Presentation |
|---|---|---|
| **Unanimous** | spread < 0.1 BPM, phase > 98% | One line, collapsed. Move on. |
| **Mostly agreed** | spread < 0.5 BPM, phase > 90% | Score shown, disagreeing spans marked on the waveform |
| **Split** | anything worse | Expanded panel, all three readings listed, region selection prompted |
| **Metrical split** | a seed reads 2× or ½× | Called out by name, `÷2`/`×2` highlighted — this is a one-click fix, not a re-run |

**MOD-A6.** When agreement is below unanimous, **mark the disagreeing spans on the waveform**. The user's next action is choosing a better region, and that decision needs to be spatial, not a number.
**MOD-A7.** The agreement score is displayed at all times once computed, not just on failure. It's the provenance of everything downstream.

### 3.0.2 Import region

**The region is not an analysis window. It is the import.** Whatever the user selects becomes the track; the head and tail outside it are discarded and never enter the project.

This collapses a whole family of problems that earlier drafts spent effort on. There is no extrapolation, because the grid is only ever applied to the audio it was fitted against. There is no partially-warped span, because everything imported is inside the region. There is no "clips from this part carry uncorrected drift," no tinting for untrusted spans, no `warpedSpan` to propagate downstream. The grid describes the track, entirely and exactly.

**MOD-A8.** Drag on the waveform to select **one contiguous region**. Detection re-runs on it, and it defines the boundaries of the imported track. Exactly one region — no multi-select, no exclusion painting.
**MOD-A9.** Region edges snap to beats.
**MOD-A10.** The region is **always drawn**, whether or not it's being edited, so what's on screen is never separable from what produced it.
**MOD-A11.** Default region is the whole file. The initial auto-run (MOD-A1) analyzes the whole file so the user has a provisional grid to navigate and audition against — that pass is for orientation, not for the final grid.
**MOD-A12.** Re-run detection on the region **plus a few beats of context on each side**, then discard the context beats. The model reads surrounding audio; a hard boundary distorts the outermost detections.
**MOD-A13.** No minimum-length warning. Since the fit is only applied within the span it was measured over, error stays bounded — a 32-beat region fitted and used across those same 32 beats has worst-case residual under 2 ms. Short regions are a legitimate thing to want.
**MOD-A14.** **Trimming is beat-exact, with one beat of padding at each end.** The rendered file starts one beat before the region's first beat and ends one beat after its last, using real source audio where it exists and silence where it doesn't. That guarantees the lead-in (§3.7) always has audio to reach back into, including at beat 0, and gives clips ending on the final beat somewhere to decay. `phase` is therefore one period, not zero.
**MOD-A15.** Record the source offset in the metadata for provenance — which part of which file this came from. It is provenance only; nothing reads it back.

### 3.0.3 Playback inside the modal

Choosing a region by looking at a waveform is guesswork. The user needs to hear it.

**MOD-A16.** Full transport in the modal: spacebar play/pause, click to seek, playback continues through every other interaction (same continuity rule as TV-24).
**MOD-A17.** Seeking snaps to the nearest beat once a provisional grid exists, which is immediately after the auto-run.
**MOD-A18.** **Loop the selection** while adjusting it, so the user hears the region they're about to analyze, repeatedly, while dragging its edges.
**MOD-A19.** The click track (MOD-27) plays over this. Listening to the metronome against a candidate region is the single most useful thing available here — it catches the half-beat phase error that no plot can show.
**MOD-A20.** Playback is on the **original, unwarped audio** during phase 1. There is nothing to warp yet, and hearing the source is the point.
**MOD-A21.** In phase 2, an **A/B toggle** switches playback between original and warp-previewed audio. Only the currently-audible beats are rendered through Rubber Band, on demand — see MOD-A23.

### 3.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Beatify · Import    boys.wav        3 seeds · UNANIMOUS 99%  │
├──────────────────────────────────────────────────────────────┤
│  WHOLE TRACK — waveform + grid, analysis region bracketed,    │
│                outside the region dimmed — it gets discarded  │
│  ▶ ⏸  ──────●────────────────  loop [x]   1:04 / 2:09        │
│  ERROR STRIP — per-beat residual, same x-axis, ±40 ms         │
├────────────────────────────┬─────────────────────────────────┤
│  CUT POINT — 12 beats      │  1 · DETECTION                  │
│  overlaid, persistence     │    region 64–1152 · re-run      │
│  scope                     │    agreement 99% · 118.4±0.02   │
│                            │    reading  ÷2 ×2 ½             │
│                            │  ─────────────────────────────  │
│                            │  2 · ALIGNMENT                  │
│                            │    warp strength [slider]       │
│                            │    ├ worst flam / peak stretch  │
│                            │    lead-in       [slider]       │
├────────────────────────────┴─────────────────────────────────┤
│ ● verdict   rms · in-band · beats · len [Click][A/B][Sync][Cut]│
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Colour semantics

**MOD-1.** **Amber = what was played** (detections, waveform, attacks — human, drifting). **Teal = what the math says** (grid lines, cut points — exact). Warping is the act of pulling amber onto teal, so the palette states the process. Hold this convention through the rest of dj-station.

### 3.3 Whole-track view

**MOD-2.** Waveform silhouette with grid lines drawn from the fitted grid, emphasized every 4th beat purely as a visual ruler.
**MOD-3.** Spans where the source tempo departs from the target are tinted and labelled with the deviation ("BAND PUSHES +2.2"). This is the evidence that warping is doing something.
**MOD-3a.** Three things overlay this waveform and must stay distinct: the **import region** (bracketed, everything outside it dimmed to show it's being discarded), **seed disagreement** spans (hatched), and **drift** spans (tinted). Disagreement and drift can become toggles if it reads as clutter. The region cannot — it's the most consequential thing on screen, since it determines what survives the import.

### 3.4 Error strip

**MOD-4.** Signed per-beat residual — mapped true beat minus grid line — on a fixed ±40 ms scale, x-aligned with the waveform above. Shaded ±5 ms band marks inaudible.
**MOD-5.** Colour by magnitude: teal inside ±5 ms, amber to ±15 ms, red beyond.
**MOD-6.** Anchor positions ticked along the bottom edge, so anchor density is visible rather than abstract.
**MOD-7.** Shape is diagnostic and the verdict text should translate it: flat scatter = good; ramp = tempo slightly off; step = a real tempo change; widening fan = progressive drift; isolated spikes = rejected outliers, ignorable.

### 3.5 Cut point inspector — the signature

**MOD-8.** A high-zoom oscilloscope window, roughly −40 ms to +70 ms around the grid line, with **12 beats sampled across the whole song drawn on top of each other** in persistence style.
**MOD-9.** Traces converge into one as warp strength rises and smear apart as it falls. This is the single clearest statement of whether the track is locked, and it's checkable at a glance in a way a residual number is not.
**MOD-10.** Overlaid: the grid line (teal), the cut line (dashed, white), the region before the cut shaded out, and a band marking where attacks begin across all traces.
**MOD-11.** Readouts: attack lead, cut clearance, and **spread** — the horizontal smear across traces, which is the flam number expressed in the same units the user is looking at.

### 3.6 Warp strength

**MOD-12.** One slider, "keep the groove" → "force the grid", labelled live with anchor density ("anchor every 8 beats").
**MOD-13.** **Two competing meters**, and the tension between them is the point:
   - **Worst flam (ms)** — maximum misalignment between any two clips. Falls as anchors get denser.
   - **Peak stretch (%)** — how far any segment is bent. Rises as anchors get denser.
**MOD-14.** Both colour-code against thresholds: flam green under 5 ms, stretch green under ~1.2%.
**MOD-15.** A **recommended zone** is shaded on the slider track, computed at load by sweeping the range and finding where both meters pass. The slider gets a real answer, not a vibe.
**MOD-16.** Pushed fully right the user gets a green flam and an amber stretch — correctly, because at that density the warp is chasing the 20 ms detection lattice rather than the band. The verdict says so in words.
**MOD-17.** Far left is the no-warp case: a straight grid through a drifting song. Left reachable deliberately, because it's the right answer for anything already produced to a click.

### 3.7 Lead-in

**MOD-18.** The lead-in is **measured, not chosen**: the median offset between grid line and actual transient onset across all beats, plus a small safety pad. On typical material this lands near 12–16 ms, not 100 ms.
**MOD-19.** One global value, applied at every cut. Uniformity is what keeps it sync-safe — per-beat onset snapping would be more precise per cut and would quietly break the layering guarantee.
**MOD-20.** Adjustable 0–250 ms (raised from 40 ms: material with a long swell in front of the beat needs more room than a drum hit does) with the cut line moving live in the inspector, so the user can see they're clearing the attack rather than trusting a number. Past ~30 ms the cut leaves the inspector's 40 ms window, so the window widens in 25 ms steps to keep it in view.
**MOD-21.** Optional zero-crossing snap on the final cut point (sub-0.1 ms adjustment, kills clicks).
**MOD-22.** Stored as project metadata, **separate from the grid**, applied at cut time. Beat 0 stays beat 0 and the value stays changeable.

### 3.8 Reading corrections

**MOD-23.** `÷2` / `×2` — metrical level, with the resulting BPM shown on the button. Auto-flagged when the inter-beat-interval histogram is bimodal at 2:1.
**MOD-24.** `Shift ½ beat` — offbeat phase. The failure the error strip structurally cannot show, since an offbeat grid fits perfectly. The modal should prompt for a click-track check rather than hiding this.
**MOD-25.** *(`Rotate bar 1` is gone with meter. There are no bars to rotate.)*
**MOD-26.** Both surviving controls are transforms on the fitted grid. Neither re-runs the tracker.

### 3.9 Audition and commit

**MOD-27.** **Click track** — metronome at the fitted grid over the source. The fastest human check for metrical level and phase.
**MOD-28.** **Sync check** — layers 4 beats from two far-apart parts of the track and loops them. This is the acceptance test as a button: clean means commit, flam means the warp is wrong.
**MOD-29.** **Cut into beats** commits: warp renders, grid freezes, modal closes into the track view.
**MOD-30.** Verdict line (green/amber/red) plus rms, percent-in-band, bar count, length. The verdict must be readable without interpreting any plot.
**MOD-31.** The header carries seed agreement at all times — it's the provenance of everything below it and should never require a click to see.

### 3.10 Ephemeral until Save

**Nothing in this modal persists.** No draft, no autosave, no partial state. Close it and the track is exactly as it was.

This is a deliberate simplification and it has a useful consequence for the implementation:

**MOD-A22.** **The warp slider does not render audio.** Flam and stretch are computed from anchor arithmetic — local least-squares fits over already-detected beat times. That's milliseconds of maths, which is why the slider can be continuous and live. Rendering audio per slider position would make it unusable.
**MOD-A23.** Audio is warped on demand, in small pieces, and only for auditioning: the A/B toggle and the sync check render **only the beats currently being heard**. A couple of seconds of Rubber Band, not a full track.
**MOD-A24.** **The full warp render happens on Save, once.** Show progress; it's roughly realtime. This is the only expensive operation in the modal and it sits behind an explicit, deliberate action.
**MOD-A25.** Cancel or dismiss discards everything: no metadata written, no warped audio, no cache entry. Nothing to clean up because nothing was created.
**MOD-A26.** Because there's no draft state, re-opening the modal on an un-saved track always restarts from the automatic whole-file analysis. That's acceptable — analysis is seconds, and the alternative is a state-restoration problem that buys very little.

### 3.11 What Save writes

**MOD-A27.** Save produces exactly two artifacts, plus a cache entry:
   - the **warped audio** (`boys.beatified.wav`)
   - the **metadata record** (§5 payload)

**MOD-A28.** Key the record by **content hash of the source audio**, not by file path. Files get renamed and moved; hashes don't. Store under the app's data directory:

```
~/.dj-station/beatify/<sha256[:16]>/
    meta.json          ← the §5 payload
    warped.wav         ← constant-tempo render
```

**MOD-A29.** Optionally also drop a sidecar (`boys.beatify.json`) next to the source for portability. The hash-keyed store is authoritative; the sidecar is a convenience and is re-derivable.
**MOD-A30.** The record includes everything needed to reproduce the render: source file, source offset, region, seed agreement, warp strength, anchor stride, grid, lead-in. Re-opening a beatified track restores the modal to its saved state rather than re-analyzing.
**MOD-A31.** **Loading an already-beatified track skips the modal entirely** and goes straight to the track view. The modal is reachable from there via a "Re-beatify" action, which warns that re-saving invalidates anything already cut from the old grid.

---

## 4. Track view

What the user lands in after import. The track, gridded, playable.

### 4.1 Display

**TV-1.** Full waveform with the beat grid overlaid. Because the audio is warped, grid lines are pure arithmetic — `phase + n × period` — and need no per-beat storage.
**TV-2.** **Level-of-detail by zoom.** Drawing every beat at whole-track zoom is unreadable noise. Thresholds are in beats, and emphasis follows the ruler grouping (TV-4a) rather than any detected structure:

| Visible span | Grid lines drawn |
|---|---|
| > 256 beats | every 16th group |
| 64–256 beats | every 4th group |
| 16–64 beats | every group, emphasized |
| 4–16 beats | every beat |
| < 4 beats | every beat + density band + subdivisions |

**TV-3.** Precompute a **peak pyramid** at import (min/max per bucket at ~256 / 1k / 4k / 16k samples) so zoom is instant and never re-reads the buffer.
**TV-4.** **Beat numbers** along the top ruler; time in the corner. Beats are the only unit — this is a musical surface, not a video editor, but it's also not a notation editor.
**TV-4a.** **Ruler grouping** is a display setting, not an analysis result. The user picks a number — default 4 — and it controls line emphasis, numbering intervals, and the step size for grouped navigation. Nothing else reads it. Someone working with a 7-feel track sets it to 7 and the emphasized lines land where they want; someone who doesn't care leaves it at 4. It is a preference about a ruler, with no claim about the music, and it can be changed at any time without touching a single sample.
**TV-5.** Density band rendering (per-beat confidence from ANL-4) appears only at the closest zoom levels.

### 4.2 Cursor and clicking

**TV-6.** Clicking the track moves the playhead to the **nearest beat** to the mouse position — not the raw sample position. Beats are the atomic unit everywhere in Beatify.
**TV-7.** Because the audio is warped, seeking to any beat is phase-correct by construction. There is no glitch and no "which beat is this really" question.
**TV-8.** Clicking during playback seeks and playback continues from the new position. It does not stop, and it does not require a re-trigger.
**TV-9.** A modifier (⌘) suspends beat snapping for free positioning. Rare, but it's the escape hatch.

### 4.3 Zoom

**TV-10.** Zoom levels snap to powers of two in beats: whole track / 512 / 128 / 32 / 8 / 2 / 1 beat.
**TV-11.** `+` / `−` zoom around the **playhead**. Scroll-wheel zoom (or trackpad pinch) centres on the **mouse**. Both behaviours are expected and they're expected in those places.
**TV-12.** **Zoom to fit** (whole track) and **zoom to selection** as single keys.
**TV-13.** ~~**Follow playhead** toggle for auto-scroll during playback~~ — WITHDRAWN after use: the view never scrolls itself. Where the track is zoomed and scrolled to is the user's, and moving it under a playing playhead makes the waveform impossible to work against.

### 4.4 Selection

**TV-14.** Drag selects a range. Edges snap **outward** to enclosing beats, so a selection is always an integer number of beats.
**TV-15.** Selection readout shows beats, plus groups when the count divides evenly ("12 beats · 3 groups").
**TV-16.** Shift-click extends the selection to the nearest beat.
**TV-17.** Drag the selection edges to resize, still beat-snapped.
**TV-18.** Double-click selects the group under the cursor; double-click on the ruler selects 16 groups.
**TV-19.** Selection persists across zoom changes and playback. Escape clears it.

### 4.5 Transport and loop

**TV-20.** Spacebar plays/pauses from the playhead. Playing from a paused state resumes where it stopped.
**TV-21.** Arrow keys step the playhead by a beat, shift-arrow by a group. Works while playing — it seeks.
**TV-22.** **Loop toggle.** Loops the selection when there is one, the whole track when there isn't.
**TV-23.** Loop points update live from the selection. Changing the selection while looping changes the loop.

### 4.6 The continuity rule

**TV-24.** **Nothing in this view stops playback.** Zooming, selecting, resizing a selection, toggling loop, changing follow-mode, seeking — audio continues throughout. This is an architectural requirement, not a polish item, and it constrains the implementation:

- The audio graph is **decoupled from UI state**. UI changes mutate scheduling parameters; they never tear down and rebuild the source node. Stopping and restarting an `AudioBufferSourceNode` for a UI change is how this requirement gets violated, and it produces audible clicks.
- Loop bounds are changed live via `loopStart` / `loopEnd` on the playing source.
- Playhead position derives from `AudioContext.currentTime`, compensated by `baseLatency` + `outputLatency`, and is rendered on `requestAnimationFrame`. Never `setInterval`.

**TV-25.** **Loop changed while the playhead is outside the new region:** playback continues linearly and wraps to loop start at the **next group boundary**. Immediate jumping is jarring; waiting for a loop end the playhead may never reach is a hang. Group-quantized wrapping always terminates and lands somewhere musical. *(Alternative worth prototyping: wrap at the next beat. Faster response, slightly less settled.)*

### 4.7 Keyboard

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` `→` | Playhead ± 1 beat |
| `⇧←` `⇧→` | Playhead ± 1 group |
| `⇧` + click | Extend selection |
| `L` | Loop on/off |
| `+` `−` | Zoom around playhead |
| `F` | Zoom to fit |
| `S` | Zoom to selection |
| `Esc` | Clear selection |
| `⌘` + click/drag | Suspend beat snapping |
| `Home` `End` | Playhead to start / end |

---

## 5. What Beatify emits

The contract with the rest of dj-station.

```jsonc
{
  "source":     "boys.wav",            // original, untouched
  "sourceSpan": [31.84, 161.20],       // provenance only — nothing reads it back
  "warped":     "boys.beatified.wav",  // constant tempo — this IS the track
  "grid":       { "bpm": 118.4, "period": 0.506757, "phase": 0.506757, "beats": 256 },
  "leadIn":     0.014,                 // seconds, applied at cut time
  "ruler":      { "group": 4 },        // display only. no claim about the music.
  "warp":       { "strength": 0.52, "anchorStride": 8, "map": [[src, dst], ...] },
  "quality":    { "worstFlamMs": 2.1, "peakStretchPct": 0.84, "rmsMs": 0.7 },
  "analysis":   { "tracker": "beat_this/final0+1+2",
                  "agreement": { "verdict": "unanimous",
                                 "tempoSpreadBpm": 0.02,
                                 "phaseAgreementPct": 99.2,
                                 "metricalSplit": false },
                  "confidence": "…frame activations…" }
}
```

**OUT-1.** Beat *n* is at `phase + n × period`. Exactly. No beat array is ever stored or trusted.
**OUT-1a.** `phase` equals one period — the beat of head padding from MOD-A14 — so beat 0 always has audio behind it for the lead-in to reach into.
**OUT-1b.** **No meter, no downbeats, no bars.** Three numbers describe the entire rhythmic content of a beatified track: `bpm`, `phase`, `beats`. `ruler.group` is a display preference and carries no claim about the music; anything wanting bar-like grouping reads it and owns the consequences locally.
**OUT-2.** Consumers use `warped`. `source` exists only for re-warping.
**OUT-3.** `quality` and `analysis.agreement` travel with the track so downstream surfaces can warn when material was imported with a known-loose grid.
**OUT-4.** The whole track is warped and the whole track is trusted. No partially-valid span propagates anywhere, and no clip ever needs a caveat attached.
**OUT-5.** Records are keyed by source content hash (MOD-A28), so the store survives renames and moves. `sourceSpan` distinguishes two regions imported from the same file.

---

## 5a. Projects and seeds

A **project** is a tempo and the material beatified onto it. It is created
empty — a name and nothing else — and tracks are imported into it one at a
time, each proved in the import modal (§3).

**PRJ-1.** The FIRST seed imported sets the project's BPM. Every seed after
it is conformed to that BPM: its warp map's output times are scaled by
`projectPeriod / itsOwnPeriod` and re-rendered in ONE pass from the source,
so there is no generation loss from stacking a stretch on a stretch.
**PRJ-2.** Every seed's render therefore satisfies OUT-1 against the SAME
`period` and `phase`. Beat *n* of any seed is the same instant as beat *n*
of any other, which is what lets one clip hold runs from two records.
**PRJ-3.** A seed keeps its own `sourceBpm` (what it was played at) and
`speed` (the ratio it now runs at). Speed is a fact about the seed, not a
setting: it falls out of the two tempos.
**PRJ-4.** The project's BPM is editable. Changing it re-renders every
seed and touches no clip — a placement is a run of BEATS, and a beat is a
beat at any tempo. A seed whose source has left the library is re-rendered
by stretching its existing render instead.
**PRJ-5.** Re-beatifying a seed keeps its id, so the clips that point at
it keep pointing at it (MOD-A31's warning still applies to its grid).
Deleting a seed leaves the project, its tempo and its clips alone: what a
clip loses is audio, not arithmetic.
**PRJ-6.** A clip source names the seed AND the parts of it that were
playing — `seed:s2/drums+bass`. A stem is not a source of its own: it is a
seed with some of its parts switched off, and all parts on is the render
itself rather than four stems summed.
**PRJ-7.** On disk: `<data_dir>/beatify/<project-id>/project.json` holds
the envelope (name, bpm, seeds); each seed owns
`seeds/<seed-id>/{meta.json,warped.wav,stems/}`. A project written before
seeds existed keeps its artifacts in the project root and is adopted,
read-only, as a project with exactly one seed.
**PRJ-8.** A project's name is its own, given by the user: a new one is
called "project N" until it is typed over, never the title of the track
imported into it first (a project holds any number of seeds, and each
seed already carries its track's title). It is renamed in place — from
the shelf's pencil, or by clicking the name in the open project's header
— and a project just created opens with that box already live, so it can
be named at birth. A project cannot be left nameless. There is no Save:
the name, the tempo, the seeds and the clips are written as they change.

---

## 6. Open questions

1. **Loop wrap quantization** — next group (recommended) or next beat? See TV-25.
2. **Click-to-seek vs. click-to-cursor.** Spec assumes click seeks during playback. If the user wants an edit cursor independent of the playhead, that's a second concept and needs its own affordance.
3. **Warp strength default.** The sweep finds a zone; should the slider land at the zone's midpoint, or at its left edge (least intervention that passes)? Left edge is the more conservative default.
4. ~~**Non-4/4 material.**~~ **Resolved by deleting meter.** Odd and mixed meters are indistinguishable from 4/4 to Beatify, because it only ever sees beats.
5. ~~**Clips cut from outside the analysis region.**~~ **Resolved by making the region the import.** There is no outside.
6. **Ruler grouping default.** 4 is the obvious default. Per-track (stored in metadata) or a global app preference? Per-track is more useful and costs one field.
7. **Overlay density.** Three things share the waveform (MOD-3a). Prototype before deciding which become toggles.
8. **Re-beatify on a track with existing clips.** MOD-A31 warns. Re-render affected clips against the new grid, or just invalidate them? Note this now also covers *re-trimming* — a re-beatify can change the track's boundaries, not only its grid, so a clip can lose its source audio outright.
9. ~~**Two regions from one file.**~~ **Resolved by projects (§5a).** Two regions imported into ONE project are conformed to that project's tempo and phase, so they layer by construction. Two imported into different projects still will not — a project is the unit that shares a grid.

---

## 7. Build order

1. **Headless pipeline.** `beat_this` → discard downbeats → fit → tempo curve → trim to region → Rubber Band warp → emit the §5 payload. Validate on 10–15 tracks including at least one genuinely drifting live recording. Acceptance: two clips from opposite ends of a track layer with no audible flam, and the warped audio doesn't sound degraded.
2. **Track view.** Waveform, peak pyramid, grid LOD, transport, beat-snapped click, zoom, selection, loop. Build this before the modal — it's where the user spends time, and it's how you evaluate step 1 by ear.
3. **Import modal, phase 1.** Auto-run on open, agreement scoring, region selection, modal transport with loop, click track, reading corrections. This half is usable on its own — it already tells you whether a track is trackable.
4. **Import modal, phase 2.** Error strip, cut-point scope, warp slider with both meters, lead-in, A/B and sync-check preview rendering, Save.
5. **Wire into dj-station** as the Beatify tab; publish the §5 payload to the hash-keyed store and the app's track state.

Step 1 carries all the risk. Steps 2 and 3 exist so a human can catch it failing.
