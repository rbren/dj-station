# Tasks (temporary checklist)

- [x] File menu: add "New Patch". Background right-click menu shows the same
      items as the File menu (not just "Save") — dedupe so the two stay in
      sync.
- [x] Mixer: default each channel level to 8V.
- [x] Multi-select modules + copy/paste/delete:
  - select multiple modules, highlight with a bright border when selected
  - cmd+c / cmd+v copy/paste; Backspace deletes the selection
  - right-click menu options for copy / paste / delete
  - paste includes wires internal to the copied set, but not wires that
    connect to modules outside the set
  - "Reset to defaults" for the whole selected group
  - copy/paste works for a single module too
- [ ] Knob right-click "set value": display the unit next to the input.
      When the unit is Hz, add a "note" picker that sets the numeric value
      to the corresponding frequency. Also fixes: setting pitch on the
      oscillator module is broken — the right-click menu only accepts a
      voltage, but it should accept the value in Hz, exactly as displayed
      (respect the jack's display mapping, e.g. volt-per-octave, when
      converting the entered value back to a knob position).
- [ ] Attenuverter: make it prettier — line up each output with its input,
      using short columns for each input/output pair.
- [ ] Infinite canvas: let the rack overscroll to open up new areas in every
      direction.
- [ ] Module picker overhaul: remove the ugly left pane; cmd+m opens a modal
      picker showing each module fully rendered but zoomed out; click-drag
      modules from the modal onto the canvas; include a category filter.
- [ ] Much better EQ/filter module: frequency-domain display with 4 draggable
      controls for frequency levels, each with a Q parameter controlling how
      wide a band it governs.
- [ ] Drums are way too quiet — make them louder.
- [ ] Input/output docs: replace self-defined descriptions (e.g. "RMS" ->
      "RMS level") with a practical sentence on what the jack is, what it's
      used for, and what it represents, so a novice knows what to do with it.
