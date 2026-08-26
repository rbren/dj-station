# DESIGN_OVERHAUL — a design critique of the dj-station frontend

A design review of the React/Vite app in `app/`, judged against the
[frontend-design skill](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)
(distinctive visual identity, typography as personality, structure that
encodes meaning, deliberate motion, restraint, a real quality floor, and
copy written from the user's side of the screen).

This document is analysis only — no UI code was changed. Findings are
grouped by theme, each with a severity, the screen it was observed on, the
files that own it, and a concrete fix.

## How this was reviewed

Reviewed at `22b03d1` (Beatify seeds). Screenshots were captured in
headless Chrome against `npm run dev`, with a fake backend installed
through the same hook the dev stress harness uses
(`window.__DJ_STRESS_INVOKE__`, see `app/src/ipc.ts`), fed with real module
manifests (`extensions/*/manifest.json` plus the built-ins from
`ExtensionRegistry::all_manifests`) and plausible DJ data: two loaded
decks, a crossfader / LFO / delay / beat-clip / Launch Control patch, seven
library tracks in mixed analysis states, store search results, a two-source
clip edit, and a Beatify project with two seeds, two clips and a full
analysis payload (agreement, drift, residuals, sweep, cut scope).

Screens looked at: rack at 100 % and 60 % zoom; deck, choreography, grid
sequencer, MIDI, QWERTY, ADSR, EQ, Turing panels; Add Module modal
(Modules tab, Clips tab, one hit, no hits); module context menu; knob
config popover; docs panel; Save As / Open Patch / Unsaved Changes dialogs;
collapse-to-macro header form; pending-wire state; jack tooltip; Library
(local + store tabs, empty); Clip (empty, loaded, with a selection);
Beatify (project shelf, import dialog, analysis modal, track view, clip
builder); a 900 px-wide viewport; and every empty state with no engine
attached. Images live outside the repo (nothing binary committed); the
harness is a few dozen lines of Playwright plus the mock invoke and is
reproducible from the notes above.

## Verdict

The rack is genuinely impressive engineering with **no design point of
view**. The SKILL's calibration section warns about three AI-default looks;
dj-station is not even in that territory — it is the state *before* a
direction is chosen: the browser's default dark chrome, one neutral UI face
at 26 different sizes, 176 hand-picked hex values, engine identifiers used
as user-facing labels, and every screen laid out as "controls, in the order
the data model lists them."

The subject is a gift and it is being ignored. This is a **modular DJ
instrument**: patch cables, Eurorack panels, a Technics platter, hot cues,
loop rolls, beatgrids, the amber glow of a mixer's cue button, 1/4" jacks,
silkscreened panel legends, VU ballistics. None of that vocabulary shows up
in the type, palette, or layout. The one place the product's own world
*does* surface — the waveform + cue markers + volatile-jack glow — is
rendered at 11 px in gray. The single largest thing on screen is a 1.9 rem
module title that repeats what the user already knows.

The newest surface, Beatify, is the clearest evidence that the problem is
systemic rather than historical: it is a brand-new, four-screen feature
built in the last few weeks, and it re-invents the buttons, re-picks the
waveform color, re-implements two transports, and ships `pip install
beat-this torch` as permanent chrome. Without shared primitives, every new
feature will keep adding entropy faster than any redesign can remove it.

Priority levels used below:

- **P0** — breaks usability or credibility; fix first.
- **P1** — major identity/hierarchy problems; the substance of the overhaul.
- **P2** — significant but local.
- **P3** — polish.

---

## A. No design system: the app has tokens by accident, not by decision

**A1 — There is no type scale (P0).**
`app/src/styles.css` (4788 lines) has **145** `font-size` declarations
across ~26 distinct values: `0.55, 0.58, 0.6, 0.62, 0.65, 0.68, 0.7, 0.72,
0.75, 0.78, 0.8, 0.82, 0.85, 0.9, 1.1, 1.5, 1.9 rem` plus `7, 8, 9, 10, 11,
12, 13, 14, 20 px`. Sizes were chosen locally, per component, to make
things fit. The result is visible in every rack screenshot: a 1.9 rem
module title (`.module-title`) shouting over 0.58 rem uppercase group
labels (`.input-group-title`, 9 px) and 7 px axis ticks in the EQ curve —
an inverted hierarchy where the least informative text is the biggest. On
the Beatify track view the word `group` (0.9 rem) is larger than the track
title's metadata and the seed names beside it (0.65–0.72 rem).
**Fix:** define one scale (e.g. 11 / 12 / 14 / 16 / 20 / 28 / 40 px) as CSS
custom properties in `:root`, and re-map every declaration to it. Nothing
below 11 px survives; panel titles drop to ~16 px, and the space freed goes
to values, not names.

**A2 — No typographic personality; the display face was never loaded (P1).**
`styles.css:3` asks for `'Inter', system-ui, sans-serif`, but nothing in
`app/index.html` or the CSS loads Inter (no `@font-face`, no `<link>`), so
the packaged app silently renders in whatever the webview's `system-ui`
is — a different face on every machine, and in the Linux webview a generic
grotesque. Every role — module titles, jack legends, numeric readouts, body
copy — uses that one face. The SKILL asks for a deliberate display/body/
utility pairing; there is not even a monospace/tabular face for the numbers
that matter (two `font-family: ui-monospace` rules exist in 4788 lines, and
`.deck-time` gets `font-variant-numeric: tabular-nums` — that is the
extent of it).
**Fix:** ship three vendored faces (nothing CDN-loaded — the app is
offline-first, cf. the MediaPipe vendoring policy): a condensed
industrial/technical display face for panel titles and transport readouts
(the silkscreen/gear-label register), a quiet grotesque for UI text, and a
real mono/tabular face for volts, BPM, timecode, and jack legends.

**A3 — 176 ad-hoc hex values, no palette (P1).**
`styles.css` contains **607** literal hex colors, **176** distinct, versus
**45** uses of any CSS variable (nearly all of them `--accent`). The
comment at `styles.css:630` is the tell: a color was picked because it is
"deliberately distinct from the gold wired-jack/wire-default (#e6b450), the
cyan accent (#62d0ff), the green outputs (#7dde8a) and every WIRE_COLORS
cable entry." That is palette-by-collision-avoidance. Meanwhile
`CATEGORY_ACCENTS` (`app/src/components/ModulePanel.tsx:33`) assigns eight
unrelated hues (terracotta, mustard, violet, azure, magenta, sage, cyan,
slate) so a rack of eight modules is an eight-hue rainbow that reads as
decoration, not classification — and the Add Module grid turns that into a
rainbow of card titles (screenshot: picker, Modules tab).
**Fix:** a 5–6 value core palette with named tokens (surface, panel, ink,
muted ink, one signal accent, one alert), plus a *restricted* category
system — e.g. keep hue for category but derive all eight from two anchors
at fixed lightness/chroma so the rack reads as one instrument instead of a
toy box.

**A4 — Buttons are re-invented per feature area (P1).**
There is no shared button primitive. `.store-tab`, `.add-module-btn`,
`.clip-tools button`, `.file-dialog button`, `.deck-cue`,
`.context-menu-item`, `.beatify-clip-new`, `.beatify-project-edit`,
`.beatify-commit`, `.track-picker-more` each redefine background / border /
radius / padding with values that differ by a pixel or two (`#1b1d22` vs
`#1d2026`; `4px 12px` vs `6px 12px` vs `6px 14px`). Consequences visible in
the shots: on the Clip page enabled and disabled buttons are nearly
indistinguishable (disabled only dims the label to `#5c626c`), and the
primary action "Save as new track" carries no more weight than "−3 dB".
**Fix:** one `Button` component with `primary | default | quiet | danger`
variants and one disabled treatment (reduced opacity *and* removed border),
then delete the per-area recipes.

**A5 — CSS hygiene the SKILL explicitly warns about (P2).**
Eight top-level selectors are defined twice — `.jack` (`:258`, `:1911`),
`.deck-cue`, `.library-empty`, `.track-picker-more`, `.beatify-builder`,
`.beatify-open-name` (`:3804` and `:4550`, with *different* colors:
`#e6e9ef` then `#dce8ff`), `.beatify-track-waveform`, `.beatify-warn` —
each with the second copy silently overriding parts of the first. Exactly
the "classes that cancel each other out" failure mode. Also: only **17**
`:hover` rules exist in 4788 lines, so most of the app does not
acknowledge the pointer at all.
**Fix:** de-duplicate; add a single hover/active/focus convention applied
through shared primitives.

---

## B. No hero, no signature: the product never states its thesis

**B1 — The header is a debug strip (P1).**
`app/src/App.tsx:1850-1951`: an 1.1 rem `dj-station` wordmark, four tabs,
an "+ Add Module" button, the patch name as plain gray text, and
`engine connected (cpal)` in 0.8 rem `#8a93a2` — the same size and color as
the patch name. A user cannot tell status from label; the *error* state
("no engine (dev)") is styled identically to the healthy one. There is no
transport, no master level, no clock, no time — nothing that says "this is
an instrument."
**Fix:** treat the header as the instrument's fascia: patch identity +
dirty marker on the left, a live master strip (BPM/clock source, output
meter, engine state as a colored dot with a text label) as the piece of
information that is *always* true and *always* visible, and actions on the
right. Status colors: green/amber/red with text, never gray-on-gray.

**B2 — Nothing is memorable; there is no signature element (P1).**
The SKILL asks for one thing the product is remembered by, executed well,
with everything else quiet. Right now the loudest elements are module
titles and a rainbow of borders. The obvious candidate is sitting unused:
**the patch cable layer**. It is the app's true subject and it currently
draws as straight `<line>` segments in default amber (see D1).
**Fix:** make the cable layer the signature — catenary sag, cable-type
color/thickness semantics, plug shadows on the panel, a subtle glow that
tracks the actual signal level already flowing through `tap_all`. One bold
place; keep panels disciplined around it.

**B3 — Four top-level views, one flat tab bar, no sense of place (P2).**
Rack, Library, Clip and Beatify are four completely different activities
(perform, collect, edit, analyse) presented as four identical 12 px pills.
The Library re-announces itself with a heading that repeats the tab
(`<h2>Library</h2>`), while Clip and Beatify have no heading or orientation
at all — Beatify opens on a "+ New project" button, a shell command in
amber, and three gray bars. Nothing about Library, Clip or Beatify looks
like it belongs to the same instrument as the rack: different button
styles, different waveform colors, different control idioms (native `range`
sliders vs custom knobs), no shared frame.
**Fix:** give each view a distinct but sibling identity (one shared chrome,
different accent temperature or texture), drop duplicated headings, give
each page one line of orientation, and carry the rack's control language
(knobs, jack legends, meters) into the other three.

---

## C. Rack panels: information dumps rather than instruments

**C1 — The deck exposes every control twice, in two visual languages (P0).**
Deck A screenshot: a row of equal-weight text buttons
(`Pause | Keylock | Slip | Rev | sync▾`), then a row of eight cue chips
(`1..8`), then loop buttons (`In | Out | Loop | ½ | ×2 | Save` + saved-loop
chips), then beatgrid buttons (`Tap | ‹ grid | grid › | Anchor`), then four
stem faders — *and below all that* a "TRANSPORT" jack group with
`play / pitch / nudge / loop` cells plus a "HOT CUES" grid of eight
`cue_trig` cells (`panelLayouts.ts:810-827`). Play and the eight hot cues
each appear twice, ~120 px apart, styled completely differently. Nothing
indicates the two rows are the same thing.
**Fix:** one control per function. Keep the patchable jack for each
transport/cue input (it is a modular instrument) but merge it *into* the
control it duplicates — a cue pad with a socket on its edge — instead of
listing it again in a separate group.

**C2 — Hierarchy inside panels is flat; the most important number is the smallest (P0).**
`.deck-time` and `.deck-bpm` are 0.72 rem (~11.5 px) `#9aa7b5` in the top
right corner (`styles.css:2458`), while the module's *name* is 1.9 rem.
During a mix, position/remaining/BPM are the only numbers that matter.
**Fix:** invert it. Timecode and BPM at 24–32 px tabular, name at ~16 px,
utility buttons quieter still. Add a remaining-time readout (DJs read
"time left", not "elapsed").

**C3 — Dynamic jack lists flood panels with dead UI (P1).**
The MIDI panel renders `map0 … map63` (64 output jacks) plus a 16-slot LED
grid, always, regardless of how many mappings exist
(`panelLayouts.ts:838`) — a wall of identical red dots labelled `map8,
map9, map10…`. The new Launch Control XL panel repeats the same pattern
(`panelLayouts.ts:853`), and the Choreography panel lists `t0 … t63` under
"TRACKS" for a program with three tracks; that dead list occupies more
panel area than the actual timeline.
**Fix:** render allocated slots plus one "next" affordance, with an
expandable "show all 64" for patch-through cases. The engine's slot budget
is an implementation detail, not information.

**C4 — Labels are engine identifiers (P1).**
Across every panel: `audio_l`, `audio_r`, `beat_clock`, `bar_clock`,
`stem_vocals`, `cue_trig3`, `loop_toggle`, `t0`, `map17`, `b1..b8`, and the
deck's sync dropdown offering `deck_a` rather than "Deck A". The manifests
already carry human names (`JackDecl.name` — "Play Gate", "Pitch Fader"),
and the app chooses the id (`Jack.tsx`, `label ?? id`). The SKILL is
explicit: name things by what people control, never by how the system is
built.
**Fix:** default jack labels to `name`, keep the id in the tooltip/docs, and
render display names in every selector (sync partner, macro members, wiring
hints).

**C5 — Text collisions and truncation at default sizes (P2).**
Observed without any resizing: Crossfader and Audio Out panel titles elide
to `Crossfad…` / `Audio…` while the panel below them is half empty; the
Choreography lane label "boolean → t0" is clipped by the next lane; the
Turing panel shows `penta… scale` under a knob. The panel-width/grid math
(`rackLayout.ts`, 48 px grid) sizes panels to their control matrix, not to
their text.
**Fix:** measure titles into the width budget or wrap them; give lane
labels their own row.

**C6 — Micro-labels are illegible and inconsistent in register (P2).**
Panel group titles are 0.58 rem uppercase `#6f7987` (4.1:1 contrast — below
AA at any size, and this is 9 px): `TRANSPORT`, `HOT CUES`, `ROW CV`,
`LED FEEDBACK`. Knob labels below them are lowercase (`freq`, `gain`, `q`,
`fdbk`, `lp`, `hp`). Three casings coexist (UPPER group, lowercase jack,
Title Case buttons) with no rule; Beatify adds a fourth register with its
`1 · DETECTION` / `2 · ALIGNMENT` letterspaced headings.
**Fix:** one casing rule (sentence case for anything a human reads, small
caps reserved for group headers), 11 px minimum, ≥ 4.5:1 contrast.

**C7 — Touch/precision targets are tiny (P2).**
`.jack-socket` is 16 px (`styles.css:278`), `.deck-cue` is 26 × ~22 px
(`:2529`), close/help glyphs in the title bar are ~14 px, and Beatify's
seed remove (`×`) and rename (`✎`) glyphs are ~12 px. Patching is the app's
core gesture and its target is 16 px.
**Fix:** 24 px minimum interactive box (the visible socket can stay small
inside a larger hit area), 32 px for transport and cue pads.

---

## D. The canvas: the best idea in the product, undesigned

**D1 — All cables look the same and carry no meaning (P1).**
`WireOverlay.tsx:17` defines eight cable colors, index 0 (`#e6b450`, amber)
is the default, and the color is a *manual user choice* per wire. Cables
render as straight `<line>` elements from socket to socket, so the rack is
a lattice of identical amber diagonals slicing across panel titles,
waveforms and buttons (see the rack screenshot — a cable runs straight
through Deck A's waveform and hot-cue pads). The data model already knows
what each wire carries: `JackDecl.audio`, the `display` spec,
`volt_per_octave`, whether the target is a gate/clock.
**Fix:** derive cable appearance from signal type (audio = thick, warm;
CV = thin, cool; clock/gate = dashed or beaded), route with a sag curve so
cables read as physical and separate visually where they bundle, dim cables
that pass over a panel and brighten them over the canvas, and keep the
manual color as an *override*, not the only signal.

**D2 — Viewport controls are invisible (P1).**
Pan is wheel-only, zoom is `⌘+/−/0`-only; there is no zoom indicator, no
"fit to patch", no minimap, no scrollbars. Both pan and zoom persist in
`localStorage`, so a session can open onto empty canvas with no visible way
home — I hit exactly that: after a 0.6 zoom the top module sat clipped
under the header.
**Fix:** a small viewport control cluster (zoom −/%, +, fit, reset) pinned
to a canvas corner, plus a minimap when the patch exceeds the viewport, and
clamp restored pan so at least one module is always on screen.

**D3 — Modules can overlap with no depth language (P2).**
When positions collide (macro placement, restored layouts, a seeded patch),
panels render flat over each other with a 1 px border and no shadow, so it
is unclear which is on top or that two panels overlap at all. Selection is
a cyan glow; drag has no lift.
**Fix:** an elevation scale (resting / hovered / dragging / selected) with
shadow and slight scale on grab.

**D4 — Rack background is a uniform dot grid with no landmarks (P3).**
Nothing distinguishes regions of an infinite canvas; at 0.6 zoom the dots
become visual noise behind dense panels.
**Fix:** fade the grid with zoom, and consider a subtle rail/lane motif
drawn from the Eurorack world so vertical position reads as "row".

---

## E. Language: the interface talks like the engine

**E1 — Developer copy in user-facing surfaces (P0).**
Empty rack: *"No engine connection — run via `./run.sh` (Tauri) to see the
live rack."* (`App.tsx:2247`). Beatify, on every screen of the feature:
*"beat_this not installed — using the built-in DSP tracker. pip install
beat-this torch"* in warning amber. Those are notes to a contributor, shown
to a user, with no action attached.
**Fix:** state what happened, in the app's voice, with a way forward:
"Audio engine not running. Start it to load a patch." + a "Start engine"
button; for the tracker, a quiet "Tracker: built-in DSP" chip that explains
the upgrade in a popover when clicked — never a shell command nailed to the
chrome.

**E2 — Empty states are dead ends, not invitations (P1).**
Library empty: *"No tracks yet — search a store tab, or drop files into a
watch folder"* (`LibraryView.tsx:432`) — 11 px gray, no import button, and
with no engine attached the store tabs it points at do not work, so the
copy contradicts the screen. Clip empty: *"Open a library track to start
editing…"* in `#6f7987` at the top-left of an otherwise black 1600 px page
(`ClipView.tsx:790`), under a Stems row of four chips that control nothing
yet. Picker with no matches: lowercase *"no modules match "zzzz""* in a
fixed 1040 × 720 modal that stays full-size. Beatify's empty clip grid says
nothing at all (see G6).
**Fix:** every empty state gets a heading, one sentence of orientation, and
the primary action as a real button ("Import files…", "Open a track",
"Clear search"). Sentence case, active voice. Hide controls that cannot act
yet.

**E3 — Instructions live far from the action (P2).**
Starting a wire puts *"wiring from choreo1:clock — click an output jack
(re-click to change color, esc to cancel)"* in the top-right of the header,
~1000 px from the cursor, in 12 px text, while the legal targets on the
canvas get no highlight at all.
**Fix:** highlight compatible jacks (and dim incompatible ones) the moment
a wire is armed; attach the short hint to the cursor; move key hints into a
persistent, discreet shortcut affordance.

**E4 — Inconsistent verbs, and one word with two meanings (P2).**
"Open Patch" / "Save Patch As" / "Splice on end" / "Save as new track" /
"Collapse to Macro" / "Pull Latest" / "Break Macro" / "Trim to selection" —
several registers (file-manager, DAW, VCS, modular) in one product. Buttons
labelled `In`, `Out`, `½`, `×2`, `Tap`, `‹ grid`, `grid ›`, `Anchor` assume
the user already knows Rekordbox. Worse, Beatify uses **"seeds" for two
different things on the same screen**: the imported tracks in a project
(`BeatifySeed`, the "SEEDS" rail) and the beat trackers that voted on the
tempo (`SeedReading.seed`, "3 seeds · MOSTLY AGREED 93 %" in the analysis
modal header).
**Fix:** one vocabulary per concept — rename one of the two "seeds"
(tracks/"takes" vs "trackers") — verbs that name the outcome, and tooltips
carrying the long form for compressed DJ abbreviations.

**E5 — Status text carries no severity (P2).**
`Analyzing 2 tracks… (4/7 done, 1 failed)` renders as one amber sentence
above the library table with no way to see *which* track failed or why; the
failed row's only affordance is a `↻` glyph button with no label. Beatify's
`stopped`, `0 runs · 1 track`, `⠿ 0 beats` and `2:03.90 total · no
selection · beat 0` are the same pattern: a state machine printed as a
sentence fragment.
**Fix:** split progress (neutral, with a real progress element) from
failure (inline on the row, with the reason and a "Retry" button); give
numeric state labelled fields, not comma-separated prose.

---

## F. Library and Clip: default HTML wearing a dark theme

**F1 — The library is a bare table with no DJ affordances (P1).**
`LibraryView.tsx` renders an unstyled `<table>` stretched to the full
viewport width: at 1600 px the Title and Analysis columns are 1400 px
apart, rows have no hover or selection state, nothing is sortable, there is
no artwork, no waveform, no cue/loop indicator, no preview, and — most
tellingly for a DJ tool — **no way to load a track onto a deck** from the
library page (the one row action is "Edit", which jumps to the Clip page).
Three tag columns (Source / License / Analysis) use the same pill shape in
four colors, so status reads like genre.
**Fix:** a purpose-built track list: fixed-max content width, dense row
rhythm, artwork thumb, key/BPM as first-class typographic data (tabular,
prominent — DJs scan them), one "Load to deck A/B" action per row,
hover/selected states, sortable columns, and one visual language per tag
family (shape or position, not four colors).

**F2 — Store results and downloads throw metadata to the far wall (P2).**
Provider rows put the title on the left edge and provider / license /
duration / Download on the right edge of a 1600 px row. The new "Recent
downloads" block is better (a real progress bar) but repeats the pattern:
title at x = 28, provider pill and 42 % at x = 1340–1570, nothing between.
**Fix:** constrain the result list width, group metadata under the title,
and turn the Download button into an in-place progress control
(Download → 42 % → In library).

**F3 — The Clip page's EQ is a good widget with no place to stand (P2).**
`ClipEqUI.tsx` is a real improvement over the native sliders it replaced —
a curve with four draggable band handles and Q knobs, matching the rack's
idiom. But it renders as a ~350 px island floating at the far left of a
1600 px page, unaligned with the 1570 px waveform above it; its frequency
axis is 7 px (`50 100 500 1k 5k 10k`); each band prints `Q1.0` under its
knob *and* again in a four-color readout strip
(`99Hz +0.0dB Q1.0  397Hz +0.0dB Q1.0 …`) whose colors mean nothing outside
this widget.
**Fix:** give the EQ a titled container sized to the page grid, label the
axis at 11 px, print each band's readout under its own handle once, and
reuse the shared accent/state colors instead of four private hues.

**F4 — The automation lane looks broken (P1).**
With no breakpoints, the level lane is an empty black strip with a single
green line pinned to its top edge and no axis, ticks, or dB labels — it
reads as a rendering bug, not as "0 dB across the clip".
**Fix:** label the lane, draw dB gridlines (0 / −6 / −12 / −24 / silence),
and show the default line as a dimmed "no automation" state with an
inviting hover target.

**F5 — Multi-region edits are invisible on the timeline (P2).**
After splicing a second source, the two regions differ only by a thin
vertical join line; region 1 and region 3 come from different tracks but
look identical. The only place that information exists is the table below.
**Fix:** tint/label regions by source, show source name in a region header
strip, and highlight the corresponding table row on hover.

**F6 — The primary action is not primary (P2).**
"Save as new track" carries `#24503a` — barely distinguishable from the
neutral `#1b1d22` buttons around it at this contrast — and sits at the end
of a row of eight equally-weighted tools; with no selection, seven of those
tools are disabled but still look enabled (only the label dims). The Name
field beside it has no visible input affordance until focus.
**Fix:** one primary button per screen, real disabled styling, and group
destructive/rare actions away from the main flow.

---

## G. Beatify: a new feature that inherits none of the app and adds its own

**G1 — The project shelf has no orientation and its rows do not align (P1).**
`.beatify-project` is a flex row whose `.beatify-project-open` child is
`flex: 1` (`styles.css:3755-3772`), with the source-missing warning as a
*sibling*. So a row with a warning is shorter than a row without one, and
the ✎ / × controls land at a different x on every row (screenshot: rows 1
and 3 at x ≈ 937, row 2 at x ≈ 627). The page opens on three gray bars,
a "+ New project" button styled exactly like everything else, and no
heading, no explanation of what a Beatify project is, no dates, no tempo
emphasis, no artwork.
**Fix:** a grid (not `flex: 1`) so actions align in a fixed column; the
warning inside the card, not beside it; a one-line page purpose; BPM and
seed count as data, not prose; labelled icon buttons.

**G2 — A shell command is permanent chrome (P0).**
`beat_this not installed — using the built-in DSP tracker. pip install
beat-this torch` sits in warning amber next to the primary actions on the
shelf *and* in the track-view header, on every visit, forever. See E1 —
this is the most visible instance.

**G3 — The same object is drawn in a different color from the rest of the app (P1).**
`.beatify-peaks / .beatify-track-peaks { fill: #d8a15f }`
(`styles.css:3999`) against `.waveform-peaks { fill: #3f7fbf }`
(`styles.css:2482`) on the deck and Clip pages. A waveform is tan here and
blue everywhere else, and neither color means anything. Meanwhile the
Beatify waveform is a solid block with four cyan group lines and *none* of
the analysis the backend just computed — per-beat confidence, drift spans,
tracker disagreement spans, anchor positions are all in the payload and
none of it is on the track view.
**Fix:** one waveform treatment app-wide (color encodes state, not page);
spend the freed novelty on drawing confidence / drift / disagreement, which
is the only reason this page exists.

**G4 — The seeds rail is 180 px wide and everything in it wraps (P1).**
`.beatify-clip-list { width: 180px }` (`styles.css:4395`) holds, per seed: a
title that wraps to three lines, a facts line that wraps to three lines
beside it, a row of four 0.65 rem stem chips, and — repeated verbatim under
*every* seed — the three-line hint "no demucs stems yet — separate this
track on the Clip page first". Two seeds fill the rail; the page has
~1400 × 400 px of empty space below the timeline. The stem chips also give
available, unavailable and enabled stems near-identical treatment.
**Fix:** widen the rail (or make it a two-column panel), truncate titles
with a tooltip, show the stems hint once per page, and make chip state
(on / off / unavailable) visually distinct.

**G5 — Two transports on one page, neither of which says what it drives (P1).**
The track transport (`▶ ■ Loop 0:00.00 + − Fit group [4] ⠿ 0 beats`) and
the clip transport (`▶ ■ stopped beats [16] 0 runs · 1 track`) are 300 px
apart, in the same gray, in the same glyph language, with no container or
title tying either to its timeline. `⠿ 0 beats` and `0 runs · 1 track` are
unexplained.
**Fix:** one shared transport component, each instance inside a titled
container attached to its own timeline, and labelled fields instead of
cryptic chips.

**G6 — The clip builder's empty grid gives no instruction (P1).**
A new clip is 16 empty cells with the numbers 1 / 5 / 9 / 13 and a
`Save clip` / `Delete clip` pair. The core gesture of the whole feature —
drag a range from the seed timeline into the clip — has no drop target, no
hover state, and no copy anywhere on the page.
**Fix:** an in-grid invitation ("drag a range from the timeline above"), a
visible drop target while dragging, and a labelled beat ruler.

**G7 — The analysis modal is the best-designed screen in the app, and it is
cut off (P1).**
`1 · DETECTION` / `2 · ALIGNMENT` numbered steps, a residual scatter with a
legend (`±5 ms / to ±15 ms / beyond`), an overlaid cut-point scope, and
prose that explains what the user is looking at — this is the one screen
with a designer's argument in it. But `.beatify-modal` is
`max-height: 92vh; overflow-y: auto` (`styles.css:3843`) with no sticky
footer, so at a 1000 px viewport the commit row (`A/B original`,
`Sync check`, and the actual Save) is scrolled out of sight below the fold,
and the two sliders (warp strength, lead-in) are **native
`<input type=range>` with the browser's default blue thumb** — the exact
inconsistency the Clip page just fixed with `ClipEqUI`.
**Fix:** sticky modal footer with a real primary action; reuse the rack's
slider/knob primitives; keep the numbered-step pattern and promote it to
the rest of the app.

---

## H. Modals, menus, dialogs: six overlay systems, no hierarchy

**H1 — Every overlay is its own invention (P1).**
`.module-picker` (fixed 1040 × 720, `styles.css:1677`), `.file-dialog`
(small card, buttons stacked full-width), `.beatify-modal` (94 vw,
scrolling), `.track-picker` (centred card with intro copy), `.docs-panel`,
`.context-menu`, `.knob-config-menu` (absolutely positioned at
`top: 40px; left: 0` of the knob) — six patterns, six paddings, six radii,
three scrim opacities (0.5 / 0.55 / 0.72).
**Fix:** one overlay primitive (scrim, elevation, radius, padding,
title/body/actions slots, focus trap, Escape) with size variants.

**H2 — Dialog actions have no rank (P1).**
The Unsaved Changes dialog stacks `Save`, `Discard`, `Cancel` as three
identical full-width gray bars — the destructive option looks exactly like
the safe one. The Open Patch dialog renders each patch name as a
full-width gray button and then `Cancel` in the same style, so a list item
and a dismissal are visually the same object. Save As offers a bare input
with no label, no hint of where it saves, and no overwrite warning.
**Fix:** horizontal action row, right-aligned, primary filled + secondary
quiet + destructive in the alert color; list items styled as list items
(hover, keyboard selection, metadata: modified date, module count). The
Beatify import dialog (`TrackPicker.tsx`) already does the *content* half
of this correctly — title, one sentence of orientation, search, list with
artist and album — and should be the template.

**H3 — The Add Module modal hides what a module is (P1).**
Each card renders the module's real panel at `PICKER_SCALE = 0.55`
(`ModulePicker.tsx:152`), which turns 9 px legends into 5 px noise: the
previews are texture, not information, and several (Wavetable, Waveshaper)
visibly overflow their card borders into the next column. The only metadata
is "12 in · 4 out". The modal is a fixed 1040 × 720 so the last row is
always sliced mid-card. Meanwhile `moduleDocs.ts` (1288 lines of genuinely
good copy — summaries, per-jack descriptions, "typical patches") is only
reachable via right-click → Documentation on an *already placed* module.
**Fix:** card = name + one-line summary from `moduleDocs.ts` + category +
a *simplified* silhouette/icon; keep the live panel preview for a detail
pane or hover; size the grid so rows are never sliced; surface the docs
entry inside the picker.

**H4 — The picker's Clips tab is a spreadsheet in a big empty box (P2).**
Two clips render as two 30 px rows (name · project · `16 beats` · `124.0
BPM`) in the same 1040 × 720 modal, ~90 % of which is empty, with no
waveform, no length in seconds, no audition button, and no grouping by
project — for a *clip*, the one thing you want before placing it is to hear
it or see its shape.
**Fix:** share the module grid's card rhythm: a small waveform thumbnail,
beats + seconds, project as a group header, and a play-on-hover audition.

**H5 — The context menu is a gray box (P2).**
No icons, no separators, no keyboard-shortcut hints (⌘C/⌘V exist!), no
danger styling for Delete, disabled Paste only dimmed.
**Fix:** grouped sections with rules, right-aligned shortcut hints, danger
color for destructive items.

**H6 — The knob config popover collides with the tooltip layer (P2).**
Opening it over a knob, the global tooltip (`TooltipLayer.tsx`) draws on top
of the popover's first row, hiding the "Value (V)" label. The popover mixes
native `<select>` chevrons with custom fields, ends in a full-width gray
"Close" bar that does not say whether changes were applied, and has no
anchor/arrow tying it to the knob it edits.
**Fix:** suppress tooltips while a popover is open, anchor with an arrow,
use shared field/select styles, and label the dismissal ("Done").

**H7 — Mode changes happen in the header and shift the layout (P3).**
Selecting modules injects a "Collapse to Macro (n)" button into the header,
and confirming swaps it for an inline name form — the header reflows and
the canvas jumps.
**Fix:** put contextual actions in a fixed-height selection bar or a
floating toolbar near the selection; never resize the app chrome.

---

## I. Quality floor (the SKILL's non-negotiables)

**I1 — No visible keyboard focus anywhere (P0).**
`styles.css` contains **zero** `:focus-visible` rules, and the two places
that mention `outline` for a text field remove it (`.module-name-input`
`:170`; the picker search field `:1712`). Every button, tab, jack, knob and
dialog control is keyboard-reachable and *invisible* when focused. Escape
does close every overlay (that part is done well), but focus is never
trapped or restored, and only `KnobConfigMenu` carries `role="dialog"` —
the picker, file dialogs, Beatify modal and docs panel have no dialog
semantics.
**Fix:** one global `:focus-visible` treatment (2 px accent ring, 2 px
offset), never removed; focus trap + restore and `role="dialog"` /
`aria-modal` in the overlay primitive.

**I2 — Motion ignores `prefers-reduced-motion` (P0).**
Three `@keyframes` exist — `jack-volatile-pulse` (`:331`, an infinite 0.5 s
brightness animation applied to *every* volatile jack, i.e. dozens of
pulsing dots in a live patch), `search-spin` (`:1513`) and
`beatify-stems-settling` (`:4535`) — and **zero** matches for
`prefers-reduced-motion` in the whole codebase.
**Fix:** wrap all continuous animation in a reduced-motion query; replace
the pulse with a static texture/ring in that mode.

**I3 — Red means "normal audio" (P1).**
`Jack.tsx` `indicatorStyle`: any jack whose signal fluctuates faster than
the 10 Hz display window renders `hsl(0, …)` — pure red — with a pulsing
halo. That is *every audio jack in every patch*. The deck screenshot shows
`audio_l`, `audio_r` and all four stem outs glowing alarm-red while the
deck is working perfectly, next to legitimately red error text elsewhere in
the app.
**Fix:** keep the "too fast to display" concept but move it off the alert
hue — a shimmer/hatch or a cool high-energy color — and reserve red for
faults (clipping, missing file, dead extension). Clipping/overload, which
*is* an alarm, currently has no distinct treatment at all.

**I4 — Zero media queries; the layout has no responsive floor (P1).**
No `@media` rules exist in 4788 lines. At 900 px the rack simply clips
(module panels are absolutely positioned in unzoomed coordinates), the
header does not reflow, the library table survives only by accident, and
Beatify's 180 px rail plus 1100 px modal have no fallback.
**Fix:** define two breakpoints (≤1280, ≤1024): collapse the header into
icon+menu, allow the library to switch to a card list, and keep dialogs
within the viewport.

**I5 — Contrast and size at the bottom of the scale (P2).**
`#6f7987` on the panel background is 4.11:1 — below AA for normal text —
and it is used at 0.58–0.6 rem for group titles and lane labels; Beatify's
`#7c869a` facts lines and the EQ's 7 px axis marks are worse.
**Fix:** minimum 11 px and ≥ 4.5:1 for anything a user must read; ≥ 3:1 for
decorative/axis marks.

**I6 — Tooltips are the only home for essential data, and they clip (P2).**
Jack values live exclusively in the hover tooltip (`t0: -4.92 V ⚡ >10 Hz`),
which renders the raw jack id, and near the window edge it draws
half-off-screen (observed at x ≈ 16 px).
**Fix:** clamp tooltips to the viewport; use the human jack name; consider
an inline value readout for jacks the user has pinned.

---

## J. Motion: incidental, not orchestrated

**J1 — There is no motion design (P2).**
Three `transition` declarations and three `@keyframes` in 4788 lines.
Modals appear instantly, the picker snaps in, panels pop into existence,
tabs cut, the Beatify project shelf swaps to a full-page editor with no
transition at all. Meanwhile the app has genuinely sophisticated
*simulated* motion (playhead extrapolation, LFO lamp motion blur, ADSR
stage replay — see `extensions/ui-lib/stepFollower.ts`) that nobody reads
as "designed" because the surrounding UI has no motion vocabulary.
**Fix:** one small motion system — 120 ms ease-out for state, 180 ms for
overlays, a single orchestrated page-load reveal for the rack (panels
settling, then cables drawing in) — and nothing else. The SKILL's warning
applies: scattered effects read as AI-generated; one orchestrated moment
lands.

---

## K. Suggested direction (a starting point, not a mandate)

Per the SKILL's two-pass process, a compact plan to critique before any
code is written:

- **Subject:** a modular DJ instrument for people who patch. Audience:
  DJs who came from Eurorack, or Eurorack people who DJ. The rack page's
  single job: *see and change signal flow while music is playing.*
- **Palette (5):** `graphite #16181C` (canvas), `panel #1E222A` (aluminium
  fascia), `bone #E8E4DA` (silkscreen ink — warmer than the current cold
  `#e6e6e6`), `cue-amber #FFA33D` (the mixer's cue lamp: the one accent,
  used for the active/armed state and nothing else), `fault #FF4D4F`
  (reserved exclusively for faults). Category hues derive from two anchors
  at fixed chroma, used as a 3 px panel edge only.
- **Type (3 roles):** a condensed technical display face for panel titles
  and the transport readout (gear-legend register); a quiet grotesque for
  UI text; a tabular mono for volts, BPM, timecode, jack legends. Scale:
  11 / 12 / 14 / 16 / 20 / 28 / 40.
- **Layout:** panels as physical modules on horizontal rails; the header
  becomes a master strip (patch identity · clock/BPM · master meter ·
  engine state); everything else is quiet.
- **Signature:** the cable layer — physical sag, signal-typed cables, and a
  faint level-driven brightness so the patch visibly *carries audio*. One
  bold thing, everything else disciplined.
- **Risk worth taking:** silkscreen legends. Panel labels rendered as
  engraved-looking condensed uppercase set *into* the panel surface
  (inset shadow, not a color change), the way real gear is labelled. It is
  the one detail that would make a screenshot of this app unmistakable —
  and it costs one text treatment, not a maximalist theme.

---

## L. What is already good (do not lose it in the overhaul)

- **The Beatify analysis modal's argument** — numbered steps, a legend on
  the residual plot, a cut-point scope, and prose that tells you what you
  are looking at. The strongest information design in the app; it just
  needs the shared primitives and a sticky footer (G7).
- **The Beatify import dialog** (`TrackPicker.tsx`): title, one sentence of
  orientation, search, list with artist and album. The template every other
  dialog should follow (H2).
- **The docs panel** (`DocsPanel.tsx` + `moduleDocs.ts`): summary, a real
  jack table with ranges, and "typical patches". The best-written surface
  in the app — it just needs to be reachable earlier (H3).
- **`ClipEqUI`**: the Clip page's EQ was three native sliders and is now a
  curve with band handles and Q knobs. Exactly the right direction; the
  remaining problem is placement, not the widget (F3).
- **Keeping the Clip page mounted across tab switches** (`App.tsx:2147`,
  `active` prop): an edit and its undo history now survive navigation,
  matching how the rack behaves. The right call — apply the same care to
  Beatify's in-progress clip.
- **The jack indicator *concept*** (`Jack.tsx`): signed value → hue, plus a
  distinct treatment for "too fast to display", is a genuinely thoughtful
  idea. Only the hue choice is wrong (I3).
- **Anti-aliased playheads and the LFO lamp's motion blur**: honest,
  physically-motivated animation most apps get wrong.
- **The unsaved-changes flow** for patches: correct copy, correct moment.
- **Waveform + cue markers + loop region** on the deck, and the Clip page's
  selection highlight: the right information, just under-scaled and
  under-labelled.

---

## Suggested sequence

1. **Floor first (P0):** focus rings, reduced motion, developer copy out of
   user surfaces (rack empty state + Beatify tracker banner), deck control
   duplication, type scale.
2. **Tokens and primitives (P1):** color/type/space tokens, one button, one
   overlay, one transport, one waveform; delete the per-area recipes.
3. **Identity (P1):** header as master strip, panel typography, category
   accent discipline, cable layer as signature.
4. **Screen-level rework (P1–P2):** library track list, Beatify shelf and
   track view, module picker cards and Clips tab, clip editor layout.
5. **Polish (P2–P3):** motion system, minimap/viewport controls, elevation,
   empty-state illustration.

---

_Prepared by an AI agent (OpenHands) on behalf of the repository owner:
screenshots captured from the dev server with a mocked backend, critiqued
against the linked frontend-design skill. No UI code was changed._
