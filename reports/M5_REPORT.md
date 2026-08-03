# Milestone M5 Report — Gesture Control (Webcam)

Built on `main`, on headless Linux (no display, no camera, no audio
device, no GPU). All seven [A] criteria are implemented and verified by
tests wired into the existing CI surface (`cargo test --workspace
--release` + frontend vitest), with the throughput criterion verified in
its synthetic-benchmark adaptation; the literal ≥ 30 fps timing on M4
hardware and the two [H] items are left unchecked (see "Open items").

## What was built

### Detection pipeline — `crates/dj-gesture`

- **Frame source abstraction** (`frame.rs`): `FrameSource` yields RGB
  `Frame`s. The shipped implementation is `TraceFrameSource`
  (`trace.rs`), which renders synthetic 320×240 frames from recorded
  pose traces; the macOS AVFoundation camera implements the same trait
  later.
- **Recorded fixtures** (`tests/fixtures/*.json`, 144 KB total): small
  JSON landmark traces — NOT video binaries — checked into the test
  tree: `poses.json` (known poses for landmark recovery), `pinch.json`
  (scripted pinch open/close), `wheel-tour.json` (a hand visiting all
  18 wheel zones). A provenance test
  (`pipeline.rs::fixtures_match_generators`) pins the committed files
  byte-for-byte to their deterministic generators (`fixtures.rs`;
  regenerate with `REGEN_FIXTURES=1`).
- **Hand detection** (`detect.rs`, `landmark.rs`, `marker.rs`): the
  21-point MediaPipe-Hands landmark topology with names per PRD §7.3
  (`L.index.tip`, `R.thumb.tip`, …) behind a `HandDetector` trait. The
  **tested default is the deterministic `MarkerDetector`**: trace frames
  encode (handedness, landmark) in marker pixel colors; the detector
  recovers centroids by pure integer scanning — byte-identical across
  runs and platforms, and honest about exercising the full
  frame-in/landmarks-out path.
- **ONNX detector** (`onnx.rs`, `--features onnx`): a
  MediaPipe-Hands-class landmark-model runner behind the same
  `HandDetector` trait, following the M3 dj-analysis conventions (ort
  2.0.0-rc.13, CoreML EP on macOS / CPU EP elsewhere, model path from
  `DJ_GESTURE_ONNX_MODEL`, empty-string env = unset). **No model weights
  ship**; `tests/onnx_smoke.rs` skips itself without the env var, and CI
  builds the feature to keep it compiling. This is plumbing-complete but
  not the tested default (see "Placeholder vs production-ready").

### Mode system — extensible registry

- `mode.rs`: `GestureMode` (id, `create(config) -> MappingEval`,
  `learn(detection) -> Option<config>`) registered in a `ModeRegistry`.
  The `GestureProcessor` core (`processor.rs`) looks mappings' modes up
  by id and never inspects mode configs itself, so **new modes plug in
  by registration alone** — proven by stub-third-mode tests at both the
  crate level (`tests/modes.rs`) and through the engine
  (`dj-engine/tests/gesture.rs`), where the stub lives entirely in the
  test file.
- **Wheel mode** (`modes.rs`, `wheel.rs`): two wheels × (8 radial
  sections + center) = 18 zones (`WheelLayout`, persisted, editable).
  A mapping targets one zone; hand-centroid presence drives a gate
  (10.0/0.0 per §4, matching MIDI note gates).
- **Landmark mode** (`modes.rs`): `presence` (gate 1 while the named
  point is detected, decaying to 0 after a configured timeout once it
  disappears — dropped frames don't count as disappearance) and
  `distance` (two named points → continuous 0..1, min/max-normalized,
  exponentially smoothed, holds last value across dropped frames).

### Engine module — `builtin.gesture` (dj-engine)

- `gesture.rs` + `engine.rs`: architecturally the MIDI module's twin.
  The control-side `GestureProcessor` is fed off the RT thread
  (`Engine::gesture_feed`); per-mapping value changes cross into the RT
  graph as timestamped events over the **same lock-free SPSC ring
  pattern as MIDI** (rtrb), applied sample-accurately by the RT module
  with zero allocations/locks. Every mapping materializes as an output
  jack (preallocated buffer budget `MAX_GESTURE_JACKS = 64`), wireable
  into anything. Learn flow: `gesture_learn_begin` arms the processor,
  the active mode proposes a config from the next detection,
  `gesture_learn_poll` creates the mapping.
- `patch.rs`: `GestureState` (mappings with jack assignments, active
  mode, wheel layout) persists in the module's JSON file in the patch
  directory and round-trips through save/load.
- **E2E golden** `gesture-pinch-vca`: serialized patch wiring
  `Gesture(distance) → VCA(cv)` with `Osc → VCA → Audio Out (stereo
  l/r)`, driven by the recorded pinch fixture via the events sidecar's
  new `gestures` section; the WAV is byte-identical to the committed
  golden and its RMS envelope tracks the pinch. All pre-existing goldens
  stay byte-identical.
- `rt_safety.rs`: the stress patch now includes an active gesture module
  (fed a looping fixture during the run); offline stress, live
  null-backend segment, and the RT allocation tripwire all pass.

### App layer — Tauri shell (`app/src-tauri/src/main.rs`)

- Commands: `gesture_status` (mode, mode list, wheel layout, mappings
  with live values, latest detection, active zones, feed/camera state —
  one poll drives the whole panel), `gesture_set_mode`,
  `gesture_add_mapping` / `gesture_remove_mapping` (wire teardown +
  wire-knob restore, like MIDI), `gesture_learn_begin` /
  `gesture_learn_poll`, `gesture_feed_start` / `gesture_feed_stop`.
- The mock feed plays a named fixture (`demo`, `pinch`, `wheel_tour`)
  through the **full pipeline** — synthetic frame render → detector →
  mappings → RT graph — from a control-rate background thread at the
  trace's 30 fps, never the RT thread. A macOS camera frame source slots
  in behind the same start/stop commands.
- Gesture output jacks render dynamically in the rack (one per mapping,
  by name), same pattern as MIDI mapping jacks.

### Frontend — `app/src/components/GesturePanel.tsx`

- Video feed area with the detection overlay drawn as **SVG from
  detection data**: wheel mode shows both wheels' 8 wedges + center with
  active-zone and mapped-zone highlighting; landmark mode shows all 21
  points per hand with labeled tips (`L.index.tip`, …). Because the
  overlay renders from data, it works headless over the placeholder and
  will sit unchanged on top of real camera frames on macOS.
- Mode selector fed by the engine's extensible mode list; learn-mapping
  flow (name → arm → poll until the mode captures); mapping list with
  live value bars and removal; feed source selector + start/stop; camera
  status badge ("no camera — mock feed available" here; the macOS
  permission flow is stubbed as an open [H] item).

## Per-criterion evidence

1. **Detection pipeline on recorded fixtures** —
   `dj-gesture/tests/pipeline.rs::known_poses_recover_named_landmarks`
   (named landmarks within 1.5 px tolerance; two runs byte-identical),
   `::fixtures_match_generators` (fixture provenance),
   `::empty_frame_detects_nothing`.
2. **Wheel mode, 18 zones, exactly one toggles** —
   `dj-gesture/tests/modes.rs::wheel_tour_toggles_exactly_one_zone` (all
   18 mapped, recorded tour, exactly the visited zone high);
   `dj-engine/tests/gesture.rs::wheel_zones_gate_exactly_one_output_in_graph`
   (gates land in the rendered graph per §4).
3. **Landmark mode** —
   `modes.rs::presence_gate_decays_after_timeout`,
   `::pinch_distance_is_monotonic_normalized_and_holds`; in-graph:
   `gesture.rs::presence_gate_decays_after_timeout_in_graph`,
   `::pinch_distance_tracks_amplitude_in_render`,
   `::frame_drops_hold_continuous_values`.
4. **Patch round-trip incl. mode + wheel layout** —
   `gesture.rs::gesture_state_round_trips_through_patch`.
5. **E2E golden** — `e2e_golden.rs` case `gesture-pinch-vca`
   (byte-identical WAV; RMS envelope rises/falls with the pinch;
   `decks`-style sidecar extension: `gestures` in `events.json`).
6. **Throughput / RT (adapted)** —
   `pipeline.rs::pipeline_throughput_floor`: full synthetic pipeline
   (render + detect + mode evaluation for one mapping of each kind),
   asserts ≥ 120 fps; measured **~9000 fps** in release on this host.
   `rt_safety.rs` (offline stress, live null segment, allocation
   tripwire) passes with the gesture module active. On-M4-hardware
   ≥ 30 fps stays an open PRD checkbox (noted inline in the PRD).
7. **Extensible mode registry, zero core changes** —
   `modes.rs::stub_third_mode_registers_without_core_changes` and
   `gesture.rs::stub_third_mode_registers_against_engine_without_core_changes`
   (stub mode defined in the test file, added via `register_mode` only;
   mappings/learn/graph output work immediately).

Learn flow (scope item 5) is additionally covered by
`modes.rs::learn_proposes_mapping_from_detection` and
`gesture.rs::learn_flow_creates_mapping_from_detection`; mapping removal +
wire teardown by `gesture.rs::remove_mapping_drops_wires_and_zeroes_value`.
Frontend behavior (overlay zones/landmarks, mode select, learn UI, value
bars, feed controls) by 7 vitest cases in `app/tests/GesturePanel.test.tsx`.

## Test counts

- `dj-gesture`: 12 (3 unit + 5 modes + 4 pipeline) + 1 feature-gated
  ONNX smoke (skips without a model).
- `dj-engine/tests/gesture.rs`: 8 (new); `e2e_golden.rs`: 9 (8 existing,
  byte-identical, + `gesture-pinch-vca`); `rt_safety.rs`: 3 (with the
  gesture module now in the stress patch).
- Frontend: 116 vitest (7 new in `GesturePanel.test.tsx`).
- Full CI-equivalent pass at end of milestone: `cargo test --workspace
  --release`, workspace clippy `-D warnings`, `cargo fmt --all --check`
  (all three cargo workspaces), `npm run lint && npm test && npm run
  build`, Tauri shell build.

## Placeholder vs production-ready

- **Production-ready**: mode system + both builtin modes, the
  GestureProcessor core, the engine module (jacks, lock-free RT path,
  sample-accurate application, persistence), patch round-trip, learn
  flow, E2E golden harness, the panel UI and its overlay renderer.
- **Deterministic stand-in (by design, tested)**: `MarkerDetector` +
  `TraceFrameSource` — the shipped detection path. It exercises real
  frames and real scanning, but recognizes synthetic marker encodings,
  not human hands.
- **Plumbing-complete, not production-tested**: `OnnxHandDetector`
  (`--features onnx`) — compiles in CI, follows the M3 EP conventions,
  but has never run against real weights here (no model ships;
  single-hand contract; a palm-detection stage for multi-hand crops is
  follow-up work alongside real weights).
- **Stub**: camera capture (no `FrameSource` for AVFoundation yet — the
  feed commands and UI are camera-shaped, the source is fixtures) and
  the macOS permission flow (UI badge state only).

## Open items (unchecked in the PRD)

- **[A] throughput**: ≥ 30 fps on M4 hardware — needs the target
  machine + camera; synthetic floor is in place.
- **[H] camera permission flow on macOS** — needs macOS/AVFoundation;
  fallback prompt state is stubbed in the panel badge.
- **[H] overlay feel / playability** — needs a human with a camera.

## Deviations from the PRD (with rationale)

- "Recorded test videos" are recorded **JSON landmark traces** rendered
  to synthetic frames, keeping the repo lean (144 KB, text-diffable,
  deterministic) while still covering frames-in/landmarks-out. Condoned
  by the milestone's own "camera mocked as a frame source".
- The ONNX hand model is feature-gated rather than default: no
  redistributable MediaPipe-Hands ONNX export could be cleanly vendored,
  and CI must not depend on model files (same policy as M3 stems).
- Gate high level is 10.0 (not literal 1) matching §4's gate convention
  as already implemented by MIDI note gates ("high ≥ 1.0").
