# DESIGN_OVERHAUL — the visual overhaul of the dj-station frontend

A design review of the React/Vite app in `app/`, judged against the
[frontend-design skill](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)
(distinctive visual identity, typography as personality, restraint,
deliberate motion, and a real quality floor).

**Scope rule for this document:** it lists only work that is *visual* —
tokens, typography, color, spacing, states, motion — and that can be done
in `app/src/styles.css` plus a handful of class/copy touch-ups. Anything
that would need a structural refactor, a markup rewrite, new controls, or a
behavior change was deliberately cut, because the risk of introducing bugs
outweighs the design win. The cut list is at the bottom so the reasoning is
not lost.

## How this was reviewed

Screenshots were captured in headless Chrome against `npm run dev`, with a
fake backend installed through the same hook the dev stress harness uses
(`window.__DJ_STRESS_INVOKE__`, see `app/src/ipc.ts`), fed with real module
manifests and plausible DJ data: two loaded decks, a crossfader / LFO /
delay / beat-clip / Launch Control patch, seven library tracks in mixed
analysis states, store search results, a two-source clip edit, and a
Beatify project with two seeds, two clips and a full analysis payload.

Screens reviewed: rack at 100 % and 60 % zoom; deck, choreography, grid
sequencer, MIDI, QWERTY, ADSR, EQ, Turing panels; Add Module modal
(Modules tab, Clips tab, no hits); context menu; knob popover; docs panel;
Save As / Open Patch / Unsaved Changes dialogs; wiring-in-progress; jack
tooltip; Library (local, stores, empty); Clip (empty, loaded, selection);
Beatify (shelf, import dialog, analysis modal, track view, clip builder);
900 px viewport.

## Verdict

The rack is impressive engineering with **no design point of view**. Not
one of the AI-default looks the SKILL warns about — the state *before* a
direction is chosen: 145 `font-size` declarations across ~26 values, 607
hex literals (176 distinct) against 45 variable uses, no focus ring
anywhere, no reduced-motion escape, and every screen laid out as
"controls, in the order the data model lists them".

The subject is a gift and it is being ignored. This is a **modular DJ
instrument**: patch cables, panels, hot cues, loop rolls, beatgrids, the
amber glow of a mixer's cue lamp, VU ballistics. None of that vocabulary
shows up in the type or the palette. The one place the product's own world
*does* surface — waveform, cue markers, jack telemetry — is rendered at
11 px in gray, while the largest thing on screen is a 1.9 rem module title
repeating what the user already knows.

Beatify, the newest surface, shows the problem is systemic rather than
historical: a brand-new feature that re-picks the waveform color,
re-invents the buttons, and hides its Save button below the fold. Until
there are tokens and a quality floor, every new feature adds entropy faster
than a redesign can remove it.

Priority levels used below:

- **P0** — breaks usability or credibility; fix first.
- **P1** — major identity/hierarchy problems; the substance of the overhaul.
- **P2** — significant but local.

## Status

This document doubles as the tracker for the overhaul: **a struck-through
heading means the fix has landed**, and the body text is kept as the record
of what was wrong and why it changed. Items with no strike are still open;
items marked *partial* landed in part, with the remainder spelled out.

Everything so far is in `app/src/styles.css` plus small class/copy touch-ups
in `App.tsx`, `ClipEqUI.tsx` and `LibraryView.tsx`. Behaviour is untouched:
the full frontend suite (881 tests, including the ones that pin copy and
measured layout) passes unchanged, no transition or animation added here
touches a layout property, and every screen below was re-shot and re-read
after the change.

Later additions to the palette are listed here so the set stays a
decision: `--bypass` (module bypass — a dark red title bar), deliberately
its own token rather than `--fault`, which is reserved for things that
are broken; a bypassed module is one the user chose to step around, and
the panel says the word "BYPASS" so the state never rests on colour.

Where the numbers stand against the audit: 607 hex literals (176 distinct)
→ 145 (104 distinct, 27 of which are `#fff` inside a `color-mix`); 145
`font-size` declarations across ~26 hand-picked values → every declaration
but ten on a 8-step scale; 0 focus rings → one global `:focus-visible`;
0 `prefers-reduced-motion` blocks → 1; 17 `:hover` rules → 25.

---

## A. Tokens: the app has them by accident, not by decision

~~**A1 — There is no type scale (P0).**~~ ✔
`app/src/styles.css` (4788 lines) has **145** `font-size` declarations
across ~26 distinct values: `0.55 … 1.9 rem` plus `7, 8, 9, 10, 11, 12, 13,
14, 20 px`. Sizes were chosen locally to make things fit, and the hierarchy
inverted: a 1.9 rem module title over 9 px group labels and 7 px EQ axis
ticks. On the Beatify track view the word `group` is larger than the seed
names beside it.
**Fix:** one scale as custom properties in `:root`
(`--fs-micro … --fs-display`, 11 / 12 / 13 / 15 / 18 / 22 / 30 px), every
declaration re-mapped onto it, nothing below 11 px except true axis marks.

~~**A2 — The font stack asks for a face that is never loaded (P1).**~~ ✔
`styles.css:3` requests `'Inter', system-ui, sans-serif`, but nothing in
`app/index.html` or the CSS loads Inter (no `@font-face`, no `<link>`), so
the app renders in whatever the webview's `system-ui` is — a different face
per machine. There is no separate face for the numbers that matter: two
`ui-monospace` rules in 4788 lines and one `tabular-nums`.
**Fix:** an honest stack, not a phantom request — a real system UI stack
for text and a `--font-mono` role applied to every value readout (volts,
BPM, timecode, jack legends, library BPM/key/length), with tabular figures
so digits stop dancing. (Vendoring custom faces was cut: binary assets and
offline-loading policy are out of scope for a CSS pass.)

~~**A3 — 176 ad-hoc hex values, no palette (P1).**~~ ✔
*partial — the palette exists and the repeated literals are re-mapped (607 →
145). What is left is material shading (knob metal, socket gradients) and a
handful of one-off panel colours.*
607 literal hex colors, 176 distinct, versus 45 uses of any variable
(nearly all `--accent`). The comment at `styles.css:630` is the tell: a
color chosen because it is "deliberately distinct from the gold
wired-jack/wire-default (#e6b450), the cyan accent (#62d0ff), the green
outputs (#7dde8a)…". That is palette-by-collision-avoidance.
**Fix:** a named core palette in `:root` — canvas, panel, panel-raised,
line, ink, ink-muted, ink-dim, accent, cue-amber, ok, warn, fault — and
re-map the repeated literals onto it. Category accents
(`ModulePanel.tsx:33`) stay, but as a 2 px panel edge only, so a rack reads
as one instrument instead of a toy box.

~~**A4 — Buttons are re-invented per feature area (P1).**~~ ✔
`.store-tab`, `.add-module-btn`, `.clip-tools button`, `.file-dialog
button`, `.deck-cue`, `.context-menu-item`, `.beatify-clip-new`,
`.beatify-commit`, `.track-picker-more` each redefine background / border /
radius / padding with values a pixel or two apart (`#1b1d22` vs `#1d2026`;
`4px 12px` vs `6px 12px` vs `6px 14px`). Disabled buttons look enabled
(only the label dims), and primary actions carry no more weight than
"−3 dB".
**Fix:** a `button` baseline plus `.is-primary` / `.is-danger` modifiers
built from the tokens, one disabled treatment (dimmed *and* de-bordered),
and the per-area recipes reduced to the differences that matter. (A shared
`<Button>` component was cut: it would touch every screen's markup.)

~~**A5 — Selectors that cancel each other out (P2).**~~ ✔
Eight top-level selectors are defined twice — `.jack` (`:258`, `:1911`),
`.deck-cue`, `.library-empty`, `.track-picker-more`, `.beatify-builder`,
`.beatify-open-name` (two *different* colors), `.beatify-track-waveform`,
`.beatify-warn`. Also only 17 `:hover` rules in 4788 lines: most of the app
does not acknowledge the pointer.
**Fix:** reconcile the conflicting pairs (colors, not layout) and add one
hover/active convention through the shared primitives.

---

## B. Identity and hierarchy

~~**B1 — The header is a debug strip (P1).**~~ ✔
An 1.1 rem wordmark, four identical tabs, and `engine connected (cpal)` in
0.8 rem `#8a93a2` — the same size and color as the patch name, and the
*error* state ("no engine (dev)") is styled identically to the healthy one.
**Fix (visual only):** a wordmark with real presence, tabs that read as a
segmented control with a clear active state, the patch name as the
document title it is, and engine state as a colored status pill (ok / warn)
so healthy and broken never look the same. (A master strip with meters and
clock was cut: new UI and new state.)

~~**B2 — The most important number is the smallest (P0).**~~ ✔
`.deck-time` / `.deck-bpm` are 0.72 rem `#9aa7b5` in a corner
(`styles.css:2458`) while the module *name* is 1.9 rem. During a mix,
position and BPM are the only numbers that matter.
**Fix:** timecode and BPM at `--fs-xl`/`--fs-lg`, tabular, bright; module
title down to `--fs-lg`; utility buttons quieter. Title-bar geometry
(56 px) is untouched — AGENTS.md's rule is "resize fonts, not bar heights".

~~**B3 — Micro-labels are illegible (P2).**~~ ✔
*the 11 px floor holds for every label; the in-glyph numerals (EQ handle,
quantizer key) sit at `--fs-mark` 8 px, which is documented in the token
block as the one exception.*
Group titles are 0.58 rem uppercase `#6f7987` — 4.1:1 contrast, below AA,
at 9 px. Beatify's `#7c869a` facts lines and 7 px axis marks are worse.
**Fix:** 11 px floor, `--ink-dim` at ≥ 4.5:1, and one casing rule applied
with `text-transform` (never by rewriting label text, which tests pin).

~~**B4 — Panels have no depth language (P2).**~~ ✔
Overlapping panels (macro placement, restored layouts) render flat with a
1 px border, so it is unclear which is on top; selection is a flat glow;
drag has no lift.
**Fix:** an elevation scale — resting / hover / selected / dragging — in
box-shadow only, so nothing in the collision geometry moves.

~~**B5 — Waveforms change color per page for no reason (P1).**~~ ✔
`.beatify-peaks / .beatify-track-peaks { fill: #d8a15f }`
(`styles.css:3999`) against `.waveform-peaks { fill: #3f7fbf }`
(`styles.css:2482`) on deck and Clip. Tan here, blue there, and neither
means anything.
**Fix:** one waveform treatment app-wide; color encodes state (playing,
selected, muted stem), never which page you are on.

---

## C. Quality floor (the SKILL's non-negotiables)

~~**C1 — No visible keyboard focus anywhere (P0).**~~ ✔
Zero `:focus-visible` rules in the stylesheet, and the two places that
mention `outline` remove it (`:170`, `:1712`). Every button, tab, jack,
knob and dialog control is keyboard-reachable and invisible when focused.
**Fix:** one global `:focus-visible` ring (2 px accent, 2 px offset,
`outline-offset` so it never overlaps content), never removed, plus a
`:focus-visible` treatment for the two fields that opt out today. (Focus
trapping and `role="dialog"` were cut: behavior, not paint.)

~~**C2 — Motion ignores `prefers-reduced-motion` (P0).**~~ ✔
Three `@keyframes` — `jack-volatile-pulse` (`:331`, infinite 0.5 s
brightness on *every* volatile jack, i.e. dozens at once), `search-spin`,
`beatify-stems-settling` — and **zero** matches for `prefers-reduced-motion`
in the codebase.
**Fix:** a global reduced-motion block that stops continuous animation and
collapses transitions; the volatile jack keeps a static ring in that mode
so no information is lost.

~~**C3 — There is no motion vocabulary at all (P2).**~~ ✔
Three `transition` declarations in 4788 lines: modals appear instantly,
tabs cut, hovers snap.
**Fix:** two durations (`--dur-fast` 120 ms for state, `--dur-slow` 180 ms
for overlays) on color/border/shadow only — never on layout properties, so
nothing can shift a measurement — and one overlay fade-in. Guarded by C2.

~~**C4 — Hit targets are smaller than the gesture (P2).**~~ ✔
`.jack-socket` is 16 px (`:278`), `.deck-cue` 26 × 22 px (`:2529`), title
glyphs ~14 px, Beatify's seed ✎/× ~12 px. Patching is the core gesture.
**Fix:** grow the *hit* area with a transparent `::after` inset overlay,
leaving the painted size and every measured box exactly as it is.

~~**C5 — Contrast at the bottom of the scale (P2).**~~ ✔
`#6f7987` on panel background = 4.11:1; `#8a93a2` on the header = 5.8:1 but
used for both labels and status; disabled `#5c626c` is 3.2:1.
**Fix:** `--ink` / `--ink-muted` / `--ink-dim` chosen at ≥ 7 / ≥ 5.5 / ≥
4.5:1 on both surfaces that matter, and disabled state expressed by
opacity + border removal rather than an unreadable gray.

---

## D. Screens

~~**D1 — The library is a bare table (P1).**~~ ✔
`LibraryView.tsx` renders an unstyled `<table>` stretched to the full
viewport: at 1600 px, Title and Analysis sit 1400 px apart; rows have no
hover; BPM/Key/Length are proportional-figure text in the same weight as
everything else; three tag columns (Source / License / Analysis) use the
same pill in four colors so status reads like genre.
**Fix (visual only):** a max content width so columns stay scannable, a
row rhythm with hover and zebra-free separators, tabular figures for
BPM/Key/Length, a sticky header row, and one pill language — neutral for
provenance, semantic color only for analysis state. (Sorting, artwork,
preview and "load to deck" were cut: new behavior.)

~~**D2 — Store results and downloads throw metadata to the far wall (P2).**~~ ✔
Title at x = 28, provider pill and "42 %" at x = 1340–1570, nothing
between.
**Fix:** the same max width and a tighter row grid; the download progress
bar picks up the accent token instead of its own blue.

~~**D3 — The Clip page's EQ has no place to stand (P2).**~~ ✔
*the container, axis and readout strip landed; the `Q1.0` printed under each
knob *and* in the readout is still duplicated — that is markup.*
`ClipEqUI` is the right widget — curve, band handles, Q knobs — but it
floats as a ~350 px island at the far left of a 1600 px page, its axis is
7 px, and every band prints `Q1.0` under its knob *and* again in a
four-color readout strip.
**Fix:** a titled, bordered container aligned to the page's content width,
an 11 px axis, and the readout strip on the type scale in muted ink with
the band colors kept only as small swatches.

~~**D4 — The automation lane reads as a rendering bug (P1).**~~ ✔
*the lane now has gridlines and a label. Unity gain still sits at the very top
of the lane because the dB→y mapping lives in `ClipView`, not in CSS.*
With no breakpoints the level lane is an empty black strip with a green
line pinned to its top edge, no axis, no label.
**Fix:** dB gridlines painted in CSS (`repeating-linear-gradient`), a
CSS-generated lane label, and a dimmed "no automation" treatment for the
default line — all background, no new DOM.

~~**D5 — The primary action is not primary (P2).**~~ ✔
"Save as new track" carries `#24503a`, barely distinguishable from the
neutral buttons around it, at the end of a row of eight equal-weight tools
of which seven are disabled but look enabled.
**Fix:** `.is-primary` on the save action, the real disabled treatment from
A4, and the tool row visually grouped away from it.

~~**D6 — Beatify’s shelf rows do not align (P1).**~~ ✔
`.beatify-project` is a flex row whose `.beatify-project-open` child is
`flex: 1` with the source-missing warning as a *sibling*
(`styles.css:3755-3772`), so a row with a warning is shorter and its ✎ / ×
land at a different x than every other row (screenshot: x ≈ 627 vs 937).
**Fix:** a fixed grid template so the actions column is the same width on
every row, the warning inside the card, and the cards on the shared surface
tokens.

~~**D7 — Beatify’s seed rail is 180 px and everything in it wraps (P1).**~~ ✔
`.beatify-clip-list { width: 180px }` (`:4395`) holds a title that wraps to
three lines, a facts line that wraps to three, four 0.65 rem stem chips,
and a three-line hint repeated under *every* seed — while ~1400 × 400 px of
the page is empty. Available, unavailable and enabled stem chips look
nearly identical.
**Fix:** a wider rail, single-line titles with ellipsis + `title` tooltip,
and three visually distinct chip states (`.beatify-stem-on` /
`-off` / `:disabled` already exist as hooks).

~~**D8 — Beatify’s tracker banner shouts a shell command forever (P1).**~~ ✔
`beat_this not installed — using the built-in DSP tracker. pip install
beat-this torch` sits in warning amber beside the primary actions, on every
visit. Its text is pinned by `BeatifyView.test.tsx`, so this is a styling
fix only: it must stop looking like an error.
**Fix:** render `.beatify-tracker.fallback` as a quiet muted chip
(`--ink-dim`, panel-raised background, no alert hue); reserve amber for
states the user must act on.

~~**D9 — The analysis modal hides its own Save (P1).**~~ ✔
`.beatify-modal` is `max-height: 92vh; overflow-y: auto` (`:3843`) with a
static footer, so at a 1000 px viewport the commit row scrolls out of
sight. Its two sliders are native `<input type=range>` with the browser's
default blue thumb — the inconsistency the Clip page already fixed.
**Fix:** `position: sticky` footer with a token background and a top rule,
`.is-primary` on the commit button, and one styled `input[type=range]`
appearance shared by every range in the app.

~~**D10 — Add Module cards leak and get sliced (P2).**~~ ✔
*previews are clipped to their card and faded at the bottom edge, and the
modal hugs its content instead of always being 720 px tall. Wide panels still
clip at the right edge of the card.*
Card previews render real panels at `PICKER_SCALE = 0.55`
(`ModulePicker.tsx:152`); several (Wavetable, Waveshaper) overflow their
card border into the next column, and the fixed 1040 × 720 modal always
slices the last row mid-card. Card titles use the eight category hues at
full saturation, so the grid is a rainbow.
**Fix:** clip the preview to its card, fade its bottom edge so the slice
reads as intentional, and put the category hue on a small dot/edge rather
than the title text. (Replacing previews with docs summaries was cut:
markup and data plumbing.)

~~**D11 — Empty states are unreadable dead ends (P2).**~~ ✔
*one `.empty-state` treatment covers library, clip and picker, and the
store tabs (which showed *nothing* before a search) now say so. The Beatify
clip grid is still a silent empty box. The rack's zero state was later
removed entirely (an empty canvas is just an empty canvas).*
Rack: *"No engine connection — run via `./run.sh` (Tauri)…"*. Library:
*"No tracks yet — search a store tab…"* at 11 px gray. Clip: one gray
sentence at the top-left of a black 1600 px page. Picker: lowercase *"no
modules match"* in a modal that stays 1040 × 720.
**Fix:** one `.empty-state` treatment — centered in its surface, a
`--fs-md` first line in `--ink`, supporting line in `--ink-muted`, generous
padding — applied to the existing markup, plus copy edits *only* where no
test pins the string. (New buttons/CTAs were cut: new behavior.)

~~**D12 — Overlays are six different objects (P2).**~~ ✔
`.module-picker`, `.file-dialog`, `.beatify-modal`, `.track-picker`,
`.docs-panel`, `.context-menu`, `.knob-config-menu`: six paddings, six
radii, three scrim opacities (0.5 / 0.55 / 0.72).
**Fix:** one scrim value, one radius, one elevation shadow and one padding
step shared by all of them, and the same `--dur-slow` fade. (A shared
overlay component with focus trapping was cut.)

**D13 — The Decks page became chrome around the rack (post-overhaul).**
Not a fix from the review — a layout decision recorded so it is not
undone by accident. The tab shows the ONE rack canvas with the deck bank
as fixed chrome: tempo bar above, eight strips in a bottom band
(`max-height: 44%`, on `--surface-sunken` with a `--line` top rule, so
the band reads as a console edge and the canvas as the space behind it).
The strips carry real jacks (send/return per deck, a CV jack under each
tone knob, the clock in the bar) in the rack's own jack language — same
socket, same colors, same glow — and chrome-to-module cables draw in a
screen-space layer above both, so a cable from a strip into the rack
looks continuous instead of dying at the canvas border. A patched tone
knob keeps its knob but recolors its jack label with `--cue`: the visual
statement that the knob now drives the rack, not its band.

**D14 — Decks and Rack are two workspaces (post-overhaul).** Also a
recorded decision, not a review fix. The Decks tab's rack is its OWN
workspace: the modules racked around the bank never appear on the Rack
tab, and each tab keeps its own patch name in the one header title slot
(`patch-title` swaps with the tab — no second title, no "which patch is
this" chrome). File > Save/Open/New always mean the tab you are on;
deck patches live in their own folder so the open dialog never mixes
the two lists. The visual grammar did not change — same canvas, same
chrome — only what the canvas contains per tab.

**D15 — A deck strip says each thing once (post-overhaul).** A 156 px
column had five label rows above its knobs: clip name, project, a beat
count, a clip tempo and a stretch, plus "out"/"in" and an L/R on each of
the four patch sockets. What survives is one title line at the project
line's size (`project - clip`, ellipsized), one tempo line
(`140 bpm +9.3%`) and an arrow per socket pair — ↑ for the send, ↓ for
the return. The beat count went because the lamp row under it draws the
same number, silence included, and shows where the bank is in it.

**D16 — The Decks top bar says tempo, then clock, then output
(post-overhaul).** Another recorded decision. The tempo is ONE control in
ONE unit, so the number and its slider stack under a single `BPM` label
instead of standing side by side with the word printed twice, and the
clock jack — the tempo made audible — sits against that stack rather than
across the bar. To its right is where the bank COMES OUT: the live pair
over the monitor pair, one row each, each row its own L/R jacks and the
master fader for everything that pair carries (the cue row's label takes
`--cue`, the same amber a monitored deck lights up in). Two rows, not two
columns, because they are two destinations and a DJ reads them as
"room / headphones".

**D17 — The deck's title line is a title, not a field (post-overhaul).**
The head of a strip carried a deck number, the clip title in a bordered,
padded button and eject, all on one row: three boxes in 156 px, so the
title had room for about a dozen characters and read as somewhere to
type. The number went (a strip is named by everything else on it and by
its jacks), and the title is plain text filling the line on its own —
project and clip as two spans, each ellipsized SEPARATELY, so a long
project name can no longer eat the clip's own name. Eject dropped to the
stem-tag row and took a tag's size, since taking a clip out is the
smallest move on the strip. Below, `silence`/`shift` became `SIL`/`SFT`
with the word in a `title`, and the two steppers moved onto shared grid
columns so their buttons stand in one pair of lines.

**D18 — A deck strip is lit by its own output (post-overhaul).** Eight
identical dark columns said nothing about which of them the room was
hearing; the mute button and the beat lamps say what was ASKED for, not
what came out. The strip now carries a `--ok` tint scaled by the bank's
own second-long weighted average of that deck's output
(`--deck-level`), so a deck fades up as it comes in and back to the
strip's black when it is muted, dropped, or sitting on a silent beat —
no separate meter widget, because the channel itself is the meter. The
BACKGROUND takes only a small share of the green: the strip's dimmest
ink (`--ink-dim` notes and legends) has to keep its contrast at full
level, so the loud end is carried by the border and an inner glow
instead. Colour only, and the transition dies in the
`prefers-reduced-motion` block — with no motion at all the tint is
still the reading.

---

## G. Still open after this pass

Small, concrete, and each one honest about why it did not land yet.

1. **Clip automation lane, unity at the ceiling (P2).** The lane spans
   +6 … −60 dB, so the default 0 dB line sits 8 px from the top edge. The
   gridlines now explain the scale, but the mapping itself lives in
   `ClipView.tsx`, not in CSS.
2. **`Q1.0` is printed twice per EQ band (P3).** Once under the knob, once
   in the readout strip (`ClipEqUI.tsx`). Removing one is markup.
3. **Add Module previews clip at the right edge (P3).** Wide panels
   (Wavetable, Drum Voice) are cut off mid-panel; a scale-to-fit would
   need `PICKER_SCALE` to become per-card in `ModulePicker.tsx`.
4. **Beatify's clip grid is a silent empty box (P3).** 0 runs renders an
   empty 90 px lane with no invitation; the string would be new markup in
   `BeatifyClipEditor.tsx`.
5. **The seed rail prints "clip" under every clip name (P3).** A subtitle
   that repeats the section header — copy, in `BeatifyClipList.tsx`.
6. **In-glyph numerals sit at 8 px (`--fs-mark`) (P3).** EQ handles and
   quantizer keys. Legible at 1× because they are single digits on a solid
   disc, but they are the last thing below the 11 px floor.

---

## E. Direction (what the tokens are aiming at)

- **Subject:** a modular DJ instrument. The rack page's single job: *see
  and change signal flow while music is playing.*
- **Palette:** graphite canvas, two panel surfaces, three ink levels, one
  cyan signal accent (already the app's de-facto accent), cue-amber for
  "armed/attention", green for ok, red reserved for faults. Category hues
  derived to a fixed lightness so eight modules read as one rack.
- **Type:** one UI face, one mono face for values, a 7-step scale, tabular
  figures everywhere a number changes.
- **Restraint:** the loudest thing on a screen should be the data (a
  waveform, a timecode, a meter), never a label.

---

## F. Cut from this overhaul (deliberately not done)

Each of these is a real finding; each needs more than paint, so it is out
of scope for a visual pass and kept here as a backlog note.

| Finding | Why it is cut |
| --- | --- |
| Sagging/catenary cables, signal-typed cable rendering | Explicitly not wanted; also rewrites `WireOverlay` geometry |
| Eurorack rails / lane motif on the rack background | Explicitly not wanted |
| Deck exposes transport + hot cues twice | Needs `panelLayouts.ts` surgery and new jack-in-control markup |
| 64 always-rendered `map0…map63` jacks (MIDI, Launch Control) | Same: layout-model change, patch/wiring implications |
| Jack labels should use `JackDecl.name`, not the id | Tests and tooltips key on ids; a rename is a behavior change |
| Red = "too fast to display" on every audio jack | `indicatorStyle`'s hue is pinned by three tests; semantic change |
| Viewport controls, minimap, clamped pan restore | New UI + new state |
| Header master strip (clock, master meter) | New UI + new state |
| Empty states gain real CTAs ("Import files…", "Open a track") | New behavior |
| Library sorting, artwork, preview, load-to-deck | New behavior |
| Region tinting by source on the clip timeline | Needs render-model changes |
| Beatify: analysis overlays (confidence/drift/disagreement) | New drawing code over the timeline |
| Beatify: one stems hint per page, clip-grid drop invitation | Markup and state changes |
| Beatify: rename one of the two meanings of "seeds" | User-facing vocabulary + tests |
| Wiring hint follows the cursor; compatible-jack highlighting | New interaction state |
| Shared `<Button>` / `<Overlay>` components, focus trapping | Cross-cutting refactor of every screen |
| Tooltip viewport clamping | Layout logic in `TooltipLayer` |
| Add Module cards showing `moduleDocs` summaries | Markup + data plumbing |
| Vendored display/mono typefaces | Binary assets, offline-loading policy |
| Responsive breakpoints that restructure the header/library | Layout restructuring under the shell's scroll contract |

---

_Prepared by an AI agent (OpenHands) on behalf of the repository owner:
screenshots captured from the dev server with a mocked backend, critiqued
against the linked frontend-design skill._
