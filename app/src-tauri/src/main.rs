// dj-station Tauri shell: hosts the Rust engine and exposes it to the React
// frontend over IPC. The engine itself lives in crates/dj-engine and is fully
// usable without this shell (see crates/dj-cli for the headless harness).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dj_engine::{
    Backend, Engine, EngineConfig, ExtensionRegistry, JackTelemetry, KnobConfig, KnobStyle,
    MacroDef, MacroInterface, MacroJack, MacroLibrary, MacroResolution, Manifest, MidiMapKind,
    PatchDoc, UndoHistory,
};
use dj_library::{AcquisitionHub, Library, ProviderInfo, Query, Track, TrackResult};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, State};

struct AppState {
    engine: Mutex<Engine>,
    history: Mutex<UndoHistory>,
    library: Arc<Library>,
    hub: AcquisitionHub,
    /// Name of the patch currently being edited (used by save/autosave).
    patch_name: Mutex<String>,
    /// Last autosaved document, to skip disk writes when nothing changed.
    last_autosave: Mutex<Option<PatchDoc>>,
    /// Watch-folder scanner; kept alive for the app's lifetime.
    _watcher: dj_library::WatchHandle,
    /// Background analysis worker (M3): drains the library queue so
    /// BPM/key/beatgrid/stems land in the DB with no user action.
    analysis: dj_analysis::AnalysisWorker,
    /// Running gesture feeds by instance id (M5): stop flag + source name.
    /// Here the source is always a recorded fixture played through the
    /// mock pipeline; on macOS a camera source slots in behind the same
    /// start/stop commands.
    gesture_feeds: Mutex<BTreeMap<String, GestureFeedHandle>>,
}

struct GestureFeedHandle {
    stop: Arc<std::sync::atomic::AtomicBool>,
    source: String,
}

/// Named patches live under the single user data dir (PRD §3).
fn patches_dir() -> PathBuf {
    dj_library::default_data_dir().join("patches")
}

/// Crash-recovery autosave location (outside the named patches).
fn autosave_dir() -> PathBuf {
    dj_library::default_data_dir().join("autosave")
}

/// Autosave the current patch if it changed since the last autosave.
/// Called from the periodic autosave thread and on window close.
fn autosave_now(state: &AppState) {
    let Ok(engine) = state.engine.lock() else {
        return;
    };
    let Ok(name) = state.patch_name.lock().map(|n| n.clone()) else {
        return;
    };
    let doc = engine.snapshot(&name);
    let Ok(mut last) = state.last_autosave.lock() else {
        return;
    };
    if last.as_ref() == Some(&doc) {
        return;
    }
    match engine.save_patch(&autosave_dir(), &name) {
        Ok(()) => *last = Some(doc),
        Err(e) => eprintln!("[dj-audio] autosave failed: {e:#}"),
    }
}

/// Record the pre-edit snapshot for an undoable edit. Failures to lock the
/// history never block the edit itself.
fn record_edit(state: &State<AppState>, engine: &Engine, key: &str) {
    if let Ok(mut history) = state.history.lock() {
        history.record(key, engine.snapshot("undo"));
    }
}

/// Rebuild the engine from a snapshot, preserving the running backend.
fn restore_doc(state: &State<AppState>, engine: &mut Engine, doc: &PatchDoc) -> CmdResult<()> {
    let backend = engine.backend();
    if backend.is_some() {
        engine.stop().map_err(err)?;
    }
    *engine = Engine::from_doc(doc, engine.registry.clone()).map_err(err)?;
    // Undo snapshots embed only the macros they use; re-register the rest
    // of the user library so instantiation stays available.
    if let Ok(lib) = db_macro_library(&state.library) {
        for def in lib.defs.into_values() {
            if engine.macros.get(&def.id).is_none() {
                engine.register_macro(def);
            }
        }
    }
    let deck_instances: Vec<String> = engine
        .nodes
        .iter()
        .filter(|n| n.is_deck())
        .map(|n| n.instance_id.clone())
        .collect();
    for instance in deck_instances {
        apply_deck_metadata(state, engine, &instance)?;
    }
    match backend {
        Some(Backend::Cpal) => {
            if let Err(e) = engine.start_cpal() {
                eprintln!("[dj-audio] WARNING: cpal restart after undo/redo failed ({e})");
                engine.start_null_realtime().map_err(err)?;
            }
        }
        Some(other) => engine.start_backend(other).map_err(err)?,
        None => {}
    }
    Ok(())
}

/// Undo the last edit. Returns false when there is nothing to undo.
#[tauri::command]
fn undo(state: State<AppState>) -> CmdResult<bool> {
    let mut engine = state.engine.lock().map_err(err)?;
    let doc = {
        let mut history = state.history.lock().map_err(err)?;
        history.undo(engine.snapshot("undo"))
    };
    match doc {
        Some(doc) => restore_doc(&state, &mut engine, &doc).map(|()| true),
        None => Ok(false),
    }
}

/// Remove a module and all wires touching it (undoable).
#[tauri::command]
fn remove_module(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("remove:{instance}"));
    let mut doc = engine.snapshot("edit");
    if !doc.remove_module(&instance) {
        return Err(format!("no such module instance: {instance}"));
    }
    restore_doc(&state, &mut engine, &doc)
}

/// Mark the end of an edit gesture (pointer-up after a knob/segment drag)
/// so the next edit of the same control is a separate undo step.
#[tauri::command]
fn end_edit(state: State<AppState>) -> CmdResult<()> {
    state.history.lock().map_err(err)?.end_gesture();
    Ok(())
}

/// Redo the last undone edit. Returns false when there is nothing to redo.
#[tauri::command]
fn redo(state: State<AppState>) -> CmdResult<bool> {
    let mut engine = state.engine.lock().map_err(err)?;
    let doc = {
        let mut history = state.history.lock().map_err(err)?;
        history.redo(engine.snapshot("undo"))
    };
    match doc {
        Some(doc) => restore_doc(&state, &mut engine, &doc).map(|()| true),
        None => Ok(false),
    }
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
struct KnobSnapshot {
    position: f32,
    atten: f32,
    offset: f32,
    config: Option<KnobConfig>,
}

#[derive(Serialize)]
struct WireSnapshot {
    from_instance: String,
    from_jack: String,
    to_instance: String,
    to_jack: String,
}

/// Structural graph edits need a stopped engine; wrap them in
/// stop -> edit -> restart-same-backend (the cpal backend hands the graph
/// back on stop, so audio resumes with the edit applied).
fn with_stopped<T>(
    engine: &mut Engine,
    f: impl FnOnce(&mut Engine) -> CmdResult<T>,
) -> CmdResult<T> {
    let backend = engine.backend();
    if backend.is_some() {
        engine.stop().map_err(err)?;
    }
    let result = f(engine);
    match backend {
        Some(Backend::Cpal) => {
            if let Err(e) = engine.start_cpal() {
                // A downgrade here means audio dies after a graph edit even
                // though the UI still shows "engine connected".
                eprintln!(
                    "[dj-audio] WARNING: cpal restart after graph edit failed ({e}); \
                     falling back to the silent null backend"
                );
                engine.start_null_realtime().map_err(err)?;
            }
        }
        Some(other) => engine.start_backend(other).map_err(err)?,
        None => {}
    }
    result
}

#[derive(Serialize)]
struct MidiMappingSnapshot {
    name: String,
    kind: MidiMapKind,
    num: u8,
}

#[derive(Serialize)]
struct NodeSnapshot {
    instance_id: String,
    type_id: String,
    manifest: Manifest,
    knobs: BTreeMap<String, KnobSnapshot>,
    params: BTreeMap<String, f32>,
    wired_inputs: Vec<String>,
    midi_mappings: Vec<MidiMappingSnapshot>,
    /// LED feedback mappings (M4, PRD §7.1); each is also an input jack.
    midi_led_mappings: Vec<MidiMappingSnapshot>,
}

#[tauri::command]
fn list_extensions(state: State<AppState>) -> CmdResult<Vec<Manifest>> {
    let engine = state.engine.lock().map_err(err)?;
    Ok(engine
        .registry
        .extensions
        .values()
        .map(|e| e.manifest.clone())
        .collect())
}

#[tauri::command]
fn engine_nodes(state: State<AppState>) -> CmdResult<Vec<NodeSnapshot>> {
    let engine = state.engine.lock().map_err(err)?;
    // Macro-aware view: the snapshot document already collapses macro
    // internals into their instances and rewrites wires to external jacks.
    let doc = engine.snapshot("ui");
    let mut wired: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for wf in doc.wires.values() {
        for w in &wf.wires {
            wired.entry(&w.to).or_default().push(w.to_jack.clone());
        }
    }
    let mut out: Vec<NodeSnapshot> = engine
        .nodes
        .iter()
        .filter(|n| !n.instance_id.contains('/')) // macro internals hidden
        .map(|n| NodeSnapshot {
            instance_id: n.instance_id.clone(),
            type_id: n.ext_id.clone(),
            manifest: {
                let mut m = n.manifest.clone();
                // MIDI output jacks are dynamic: show only mapped controls
                // (by mapping name), not the 64 preallocated slots.
                if n.is_midi() {
                    m.outputs = n
                        .midi_mappings
                        .iter()
                        .map(|mm| dj_engine::manifest::OutputDecl {
                            id: mm.name.clone(),
                            name: mm.name.clone(),
                        })
                        .collect();
                    // LED input jacks likewise (M4): one per LED mapping,
                    // by mapping name, not the 16 preallocated slots.
                    m.inputs = n
                        .midi_led_mappings
                        .iter()
                        .map(|mm| dj_engine::manifest::JackDecl {
                            id: mm.name.clone(),
                            name: mm.name.clone(),
                            default: 0.0,
                            knob: None,
                        })
                        .collect();
                }
                // Gesture output jacks are dynamic too (M5): one per
                // mapping, by mapping name.
                if let Some(g) = &n.gesture {
                    m.outputs = g
                        .mappings()
                        .iter()
                        .map(|(_, d)| dj_engine::manifest::OutputDecl {
                            id: d.name.clone(),
                            name: d.name.clone(),
                        })
                        .collect();
                }
                m
            },
            knobs: n
                .manifest
                .inputs
                .iter()
                .zip(&n.knobs)
                .map(|(decl, k)| {
                    (
                        decl.id.clone(),
                        KnobSnapshot {
                            position: k.position,
                            atten: k.atten,
                            offset: k.offset,
                            config: k.config.clone(),
                        },
                    )
                })
                .collect(),
            params: n.params.clone(),
            wired_inputs: wired
                .get(n.instance_id.as_str())
                .cloned()
                .unwrap_or_default(),
            midi_mappings: n
                .midi_mappings
                .iter()
                .map(|m| MidiMappingSnapshot {
                    name: m.name.clone(),
                    kind: m.kind,
                    num: m.num,
                })
                .collect(),
            midi_led_mappings: n
                .midi_led_mappings
                .iter()
                .map(|m| MidiMappingSnapshot {
                    name: m.name.clone(),
                    kind: m.kind,
                    num: m.num,
                })
                .collect(),
        })
        .collect();
    // Macro instances render like any other module panel, using their
    // synthesized external manifest and promoted knob/param state.
    for (iid, mi) in engine.macro_instances() {
        if iid.contains('/') {
            continue;
        }
        let Some(manifest) = engine.macro_manifest(&mi.macro_id) else {
            continue;
        };
        let mf = doc.modules.get(iid);
        out.push(NodeSnapshot {
            instance_id: iid.clone(),
            type_id: mi.macro_id.clone(),
            manifest,
            knobs: mf
                .map(|m| {
                    m.knobs
                        .iter()
                        .map(|(id, k)| {
                            (
                                id.clone(),
                                KnobSnapshot {
                                    position: k.position,
                                    atten: k.atten,
                                    offset: k.offset,
                                    config: k.config.clone(),
                                },
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
            params: mf.map(|m| m.params.clone()).unwrap_or_default(),
            wired_inputs: wired.get(iid.as_str()).cloned().unwrap_or_default(),
            midi_mappings: Vec::new(),
            midi_led_mappings: Vec::new(),
        });
    }
    Ok(out)
}

/// All module types that can be added to the rack (built-ins + extensions
/// + user-library macros, PRD §6).
#[tauri::command]
fn list_modules(state: State<AppState>) -> CmdResult<Vec<Manifest>> {
    let engine = state.engine.lock().map_err(err)?;
    let mut manifests = engine.registry.all_manifests();
    for def in engine.macros.list() {
        if let Some(m) = engine.macro_manifest(&def.id) {
            manifests.push(m);
        }
    }
    Ok(manifests)
}

#[tauri::command]
fn engine_wires(state: State<AppState>) -> CmdResult<Vec<WireSnapshot>> {
    let engine = state.engine.lock().map_err(err)?;
    // Snapshot wires are macro-aware: internal wires are hidden and
    // boundary wires appear at the instance's promoted external jacks.
    let doc = engine.snapshot("ui");
    Ok(doc
        .wires
        .iter()
        .flat_map(|(src, wf)| {
            wf.wires.iter().map(|w| WireSnapshot {
                from_instance: src.clone(),
                from_jack: w.from_jack.clone(),
                to_instance: w.to.clone(),
                to_jack: w.to_jack.clone(),
            })
        })
        .collect())
}

#[tauri::command]
fn add_module(state: State<AppState>, instance: String, type_id: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("add:{instance}"));
    with_stopped(&mut engine, |e| {
        e.add_module(&instance, &type_id).map_err(err)
    })
}

#[tauri::command]
fn connect_wire(
    state: State<AppState>,
    from_instance: String,
    from_jack: String,
    to_instance: String,
    to_jack: String,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(
        &state,
        &engine,
        &format!("wire+:{from_instance}:{from_jack}->{to_instance}:{to_jack}"),
    );
    with_stopped(&mut engine, |e| {
        e.connect(&from_instance, &from_jack, &to_instance, &to_jack)
            .map_err(err)
    })
}

#[tauri::command]
fn disconnect_wire(
    state: State<AppState>,
    from_instance: String,
    from_jack: String,
    to_instance: String,
    to_jack: String,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(
        &state,
        &engine,
        &format!("wire-:{from_instance}:{from_jack}->{to_instance}:{to_jack}"),
    );
    with_stopped(&mut engine, |e| {
        e.disconnect(&from_instance, &from_jack, &to_instance, &to_jack)
            .map_err(err)?;
        // Legacy patches from before wired-input blending saved an automatic
        // wire-style override; undo it so the knob comes back (only when it
        // is still set to wire — respect manual choices).
        if let Ok(k) = e.knob_state(&to_instance, &to_jack) {
            if k.config
                .as_ref()
                .is_some_and(|c| c.style == KnobStyle::Wire)
            {
                e.set_knob_config(&to_instance, &to_jack, None)
                    .map_err(err)?;
            }
        }
        Ok(())
    })
}

/// Map a MIDI control (note/cc) to a new output jack. Safe while running:
/// the mapping table is lock-free and jack buffers are preallocated.
#[tauri::command]
fn add_midi_mapping(
    state: State<AppState>,
    instance: String,
    kind: MidiMapKind,
    num: u8,
    name: String,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("midi+:{instance}:{name}"));
    engine
        .add_midi_mapping(&instance, kind, num, &name)
        .map(|_| ())
        .map_err(err)
}

/// Remove a MIDI mapping. Any wires from its jack are disconnected first
/// (restoring auto wire-style knobs), which needs the engine stopped.
#[tauri::command]
fn remove_midi_mapping(state: State<AppState>, instance: String, name: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("midi-:{instance}:{name}"));
    let doomed: Vec<(String, String)> = engine
        .wire_specs()
        .iter()
        .filter(|w| {
            engine.nodes[w.from_node].instance_id == instance
                && engine.output_jack_name(w.from_node, w.from_jack) == name
        })
        .map(|w| {
            (
                engine.nodes[w.to_node].instance_id.clone(),
                engine.nodes[w.to_node].manifest.inputs[w.to_jack]
                    .id
                    .clone(),
            )
        })
        .collect();
    with_stopped(&mut engine, |e| {
        for (to_instance, to_jack) in &doomed {
            e.disconnect(&instance, &name, to_instance, to_jack)
                .map_err(err)?;
            if let Ok(k) = e.knob_state(to_instance, to_jack) {
                if k.config
                    .as_ref()
                    .is_some_and(|c| c.style == KnobStyle::Wire)
                {
                    e.set_knob_config(to_instance, to_jack, None).map_err(err)?;
                }
            }
        }
        e.remove_midi_mapping(&instance, &name).map_err(err)
    })
}

/// Add a MIDI LED feedback mapping (M4, PRD §7.1): the named input jack
/// appears on the MIDI module and drives note/CC out messages back to the
/// controller (hardware port when `DJ_MIDI_OUT_PORT` matches one).
#[tauri::command]
fn add_midi_led_mapping(
    state: State<AppState>,
    instance: String,
    kind: MidiMapKind,
    num: u8,
    name: String,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("led+:{instance}:{name}"));
    engine
        .add_midi_led_mapping(&instance, kind, num, &name)
        .map(|_| ())
        .map_err(err)
}

/// Remove a MIDI LED mapping. The engine drops wires into its jack, which
/// is a structural edit and needs the engine stopped.
#[tauri::command]
fn remove_midi_led_mapping(
    state: State<AppState>,
    instance: String,
    name: String,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("led-:{instance}:{name}"));
    with_stopped(&mut engine, |e| {
        e.remove_midi_led_mapping(&instance, &name).map_err(err)
    })
}

// ---------------------------------------------------------------------------
// Gesture Control (M5, PRD §7.3)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct GestureMappingSnapshot {
    name: String,
    mode: String,
    config: serde_json::Value,
    value: f32,
}

/// Everything the gesture panel needs per poll: config + live overlay data.
#[derive(Serialize)]
struct GestureStatus {
    mode: String,
    modes: Vec<String>,
    wheels: dj_engine::dj_gesture::WheelLayout,
    mappings: Vec<GestureMappingSnapshot>,
    /// Latest detection (named landmarks via index order; normalized
    /// coordinates) for the overlay.
    detection: Option<dj_engine::dj_gesture::Detection>,
    /// (wheel, zone) pairs currently containing a hand centroid.
    active_zones: Vec<(usize, usize)>,
    /// Fixture name when a mock feed is running.
    feed: Option<String>,
    /// Camera availability: always "mock" here. On macOS the AVFoundation
    /// path will report "granted" / "denied" / "prompt" ([H] criterion,
    /// not implemented on this platform).
    camera: String,
}

#[tauri::command]
fn gesture_status(state: State<AppState>, instance: String) -> CmdResult<GestureStatus> {
    let engine = state.engine.lock().map_err(err)?;
    let g = engine.gesture(&instance).map_err(err)?;
    let mappings = g
        .mappings()
        .iter()
        .map(|(jack, d)| GestureMappingSnapshot {
            name: d.name.clone(),
            mode: d.mode.clone(),
            config: d.config.clone(),
            value: g.value(*jack),
        })
        .collect();
    let feed = state
        .gesture_feeds
        .lock()
        .map_err(err)?
        .get(&instance)
        .map(|f| f.source.clone());
    Ok(GestureStatus {
        mode: g.active_mode().to_string(),
        modes: g.mode_ids(),
        wheels: *g.wheels(),
        mappings,
        detection: g.last_detection().cloned(),
        active_zones: g.active_zones(),
        feed,
        camera: "mock".into(),
    })
}

#[tauri::command]
fn gesture_set_mode(state: State<AppState>, instance: String, mode: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("gest-mode:{instance}"));
    engine.gesture_set_mode(&instance, &mode).map_err(err)
}

/// Create a gesture mapping under the given mode (a new output jack).
/// Safe while running: jack buffers are preallocated, like MIDI.
#[tauri::command]
fn gesture_add_mapping(
    state: State<AppState>,
    instance: String,
    name: String,
    mode: String,
    config: serde_json::Value,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("gest+:{instance}:{name}"));
    engine
        .add_gesture_mapping(&instance, &name, &mode, config)
        .map(|_| ())
        .map_err(err)
}

/// Remove a gesture mapping. Wires from its jack are disconnected first
/// (restoring auto wire-style knobs), which needs the engine stopped.
#[tauri::command]
fn gesture_remove_mapping(state: State<AppState>, instance: String, name: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("gest-:{instance}:{name}"));
    let doomed: Vec<(String, String)> = engine
        .wire_specs()
        .iter()
        .filter(|w| {
            engine.nodes[w.from_node].instance_id == instance
                && engine.output_jack_name(w.from_node, w.from_jack) == name
        })
        .map(|w| {
            (
                engine.nodes[w.to_node].instance_id.clone(),
                engine.nodes[w.to_node].manifest.inputs[w.to_jack]
                    .id
                    .clone(),
            )
        })
        .collect();
    with_stopped(&mut engine, |e| {
        for (to_instance, to_jack) in &doomed {
            e.disconnect(&instance, &name, to_instance, to_jack)
                .map_err(err)?;
            if let Ok(k) = e.knob_state(to_instance, to_jack) {
                if k.config
                    .as_ref()
                    .is_some_and(|c| c.style == KnobStyle::Wire)
                {
                    e.set_knob_config(to_instance, to_jack, None).map_err(err)?;
                }
            }
        }
        e.remove_gesture_mapping(&instance, &name).map_err(err)
    })
}

/// Arm the learn flow: the next detection is offered to the active mode.
#[tauri::command]
fn gesture_learn_begin(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.gesture_learn_begin(&instance).map_err(err)
}

/// Poll the learn flow; on capture, creates the mapping under `name` and
/// returns true (the frontend polls like MIDI learn).
#[tauri::command]
fn gesture_learn_poll(state: State<AppState>, instance: String, name: String) -> CmdResult<bool> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("gest+:{instance}:{name}"));
    Ok(engine
        .gesture_learn_poll(&instance, &name)
        .map_err(err)?
        .is_some())
}

/// Build one of the recorded fixture traces by name.
fn gesture_fixture(
    name: &str,
    wheels: &dj_engine::dj_gesture::WheelLayout,
) -> Option<dj_engine::dj_gesture::PoseTrace> {
    use dj_engine::dj_gesture::fixtures;
    match name {
        "pinch" => Some(fixtures::pinch_trace(30.0, 90, 0.04, 0.3)),
        "wheel_tour" => Some(fixtures::wheel_tour_trace(30.0, wheels, 15)),
        "demo" => Some(fixtures::demo_trace(30.0, wheels)),
        _ => None,
    }
}

/// Start the (mock) gesture feed: plays a recorded fixture through the
/// full pipeline — synthetic frames -> detector -> mappings -> RT graph —
/// from a control-rate background thread (never the RT thread). On macOS
/// a camera frame source will replace the fixture behind this same
/// command; the UI is identical either way.
#[tauri::command]
fn gesture_feed_start(
    app: tauri::AppHandle,
    state: State<AppState>,
    instance: String,
    source: String,
) -> CmdResult<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let wheels = {
        let engine = state.engine.lock().map_err(err)?;
        *engine.gesture(&instance).map_err(err)?.wheels()
    };
    let trace = gesture_fixture(&source, &wheels)
        .ok_or_else(|| format!("unknown gesture fixture {source:?}"))?;
    let mut feeds = state.gesture_feeds.lock().map_err(err)?;
    if let Some(old) = feeds.remove(&instance) {
        old.stop.store(true, Ordering::Relaxed);
    }
    let stop = Arc::new(AtomicBool::new(false));
    feeds.insert(
        instance.clone(),
        GestureFeedHandle {
            stop: stop.clone(),
            source,
        },
    );
    drop(feeds);
    let handle = app.clone();
    std::thread::spawn(move || {
        use dj_engine::dj_gesture::{HandDetector, MarkerDetector, TraceFrameSource};
        let state = handle.state::<AppState>();
        let mut detector = MarkerDetector;
        let dt = 1.0 / trace.fps;
        let tick = std::time::Duration::from_secs_f32(dt);
        let mut i = 0usize;
        while !stop.load(Ordering::Relaxed) {
            let det =
                TraceFrameSource::render(&trace, i).and_then(|frame| detector.detect(&frame).ok());
            {
                let Ok(mut engine) = state.engine.lock() else {
                    break;
                };
                let frame = engine.current_frame();
                if engine
                    .gesture_feed(&instance, frame, det.as_ref(), dt)
                    .is_err()
                {
                    break; // module removed / engine rebuilt without it
                }
            }
            i = (i + 1) % trace.frames.len();
            std::thread::sleep(tick);
        }
    });
    Ok(())
}

#[tauri::command]
fn gesture_feed_stop(state: State<AppState>, instance: String) -> CmdResult<()> {
    if let Some(feed) = state.gesture_feeds.lock().map_err(err)?.remove(&instance) {
        feed.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn load_demo_patch(state: State<AppState>) -> CmdResult<()> {
    {
        let engine = state.engine.lock().map_err(err)?;
        if !engine.nodes.is_empty() {
            return Ok(());
        }
    }
    // Crash/quit recovery: restore the autosaved patch when one exists.
    let autosave = autosave_dir();
    if autosave.join("patch.json").is_file() {
        match load_patch_dir(&state, &autosave) {
            Ok(()) => {
                if let Some(name) = std::fs::read_to_string(autosave.join("patch.json"))
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .and_then(|v| v["name"].as_str().map(str::to_string))
                {
                    *state.patch_name.lock().map_err(err)? = name;
                }
                // The startup restore is not an edit: without this, undoing
                // past the session's first change restores the pre-load
                // EMPTY engine (blank rack, telemetry "no node" spam).
                state.history.lock().map_err(err)?.clear();
                eprintln!("[dj-audio] restored autosaved patch");
                return Ok(());
            }
            Err(e) => eprintln!("[dj-audio] autosave restore failed ({e}); loading demo patch"),
        }
    }
    let mut engine = state.engine.lock().map_err(err)?;
    engine.add_module("midi1", "builtin.midi").map_err(err)?;
    engine
        .add_module("osc1", "com.dj.oscillator")
        .map_err(err)?;
    engine.add_module("adsr1", "com.dj.adsr").map_err(err)?;
    engine.add_module("vca1", "com.dj.vca").map_err(err)?;
    engine
        .add_module("out1", "builtin.audio_out")
        .map_err(err)?;
    engine
        .add_midi_mapping("midi1", MidiMapKind::Note, 60, "C4")
        .map_err(err)?;
    engine
        .connect("midi1", "C4", "adsr1", "gate")
        .map_err(err)?;
    engine.connect("osc1", "audio", "vca1", "in").map_err(err)?;
    engine.connect("adsr1", "env", "vca1", "cv").map_err(err)?;
    engine.connect("vca1", "out", "out1", "l").map_err(err)?;
    engine.connect("vca1", "out", "out1", "r").map_err(err)?;
    // The wired envelope adds to the cv knob baseline; close the knob so
    // the envelope alone sets the level (default 10 would drone).
    engine.set_knob_value("vca1", "cv", 0.0).map_err(err)?;
    // Building the demo patch is startup state, not an undoable edit.
    state.history.lock().map_err(err)?.clear();
    eprintln!(
        "[dj-audio] demo patch loaded: MIDI(note 60) -> ADSR(gate) -> VCA(cv), \
         Osc -> VCA -> Out. NOTE: the VCA is gated by MIDI note 60 — without a \
         MIDI event (hardware or inject_midi) the patch renders SILENCE by design."
    );
    Ok(())
}

#[tauri::command]
fn set_knob_position(
    state: State<AppState>,
    instance: String,
    jack: String,
    position: f32,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("knob:{instance}:{jack}"));
    engine
        .set_knob_position(&instance, &jack, position)
        .map_err(err)
}

#[tauri::command]
fn set_knob_config(
    state: State<AppState>,
    instance: String,
    jack: String,
    config: Option<KnobConfig>,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("knobcfg:{instance}:{jack}"));
    engine
        .set_knob_config(&instance, &jack, config)
        .map_err(err)
}

#[tauri::command]
fn set_knob_atten_offset(
    state: State<AppState>,
    instance: String,
    jack: String,
    atten: f32,
    offset: f32,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("attoff:{instance}:{jack}"));
    engine
        .set_knob_atten_offset(&instance, &jack, atten, offset)
        .map_err(err)
}

#[tauri::command]
fn set_param(state: State<AppState>, instance: String, param: String, value: f32) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("param:{instance}:{param}"));
    engine.set_param(&instance, &param, value).map_err(err)
}

#[tauri::command]
fn tap(state: State<AppState>, instance: String, jack: String) -> CmdResult<JackTelemetry> {
    let engine = state.engine.lock().map_err(err)?;
    engine.tap(&instance, &jack).map_err(err)
}

/// Batched telemetry for the UI's 100 ms poll: one lock acquisition and one
/// IPC round-trip for the whole rack instead of one `tap` per jack. Keys
/// mirror the `engine_nodes` snapshot the UI renders from: macro internals
/// are hidden, MIDI nodes expose their LED-mapping jacks by name, and macro
/// instances expose their external input jacks.
#[tauri::command]
fn tap_all(state: State<AppState>) -> CmdResult<BTreeMap<String, BTreeMap<String, JackTelemetry>>> {
    let engine = state.engine.lock().map_err(err)?;
    let mut out: BTreeMap<String, BTreeMap<String, JackTelemetry>> = BTreeMap::new();
    for n in &engine.nodes {
        if n.instance_id.contains('/') {
            continue; // macro internals hidden, as in engine_nodes
        }
        let jacks = out.entry(n.instance_id.clone()).or_default();
        if n.is_midi() {
            for m in &n.midi_led_mappings {
                if let Some(slot) = n.telemetry.get(m.jack) {
                    jacks.insert(m.name.clone(), slot.read());
                }
            }
        } else {
            for (i, decl) in n.manifest.inputs.iter().enumerate() {
                if let Some(slot) = n.telemetry.get(i) {
                    jacks.insert(decl.id.clone(), slot.read());
                }
            }
        }
    }
    for (iid, mi) in engine.macro_instances() {
        if iid.contains('/') {
            continue;
        }
        let jacks = out.entry(iid.clone()).or_default();
        for (ext_jack, node, jack) in &mi.inputs {
            if let Ok(t) = engine.tap(node, jack) {
                jacks.insert(ext_jack.clone(), t);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn save_patch(state: State<AppState>, dir: String, name: String) -> CmdResult<()> {
    let engine = state.engine.lock().map_err(err)?;
    engine.save_patch(&PathBuf::from(dir), &name).map_err(err)
}

/// Patch names double as directory names under `patches_dir()`; keep them
/// to a safe filename alphabet (no separators or traversal).
fn valid_patch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
}

#[tauri::command]
fn save_patch_as(state: State<AppState>, name: String) -> CmdResult<()> {
    let name = name.trim().to_string();
    if !valid_patch_name(&name) {
        return Err(format!("invalid patch name: {name:?}"));
    }
    let engine = state.engine.lock().map_err(err)?;
    engine
        .save_patch(&patches_dir().join(&name), &name)
        .map_err(err)?;
    *state.patch_name.lock().map_err(err)? = name;
    Ok(())
}

#[tauri::command]
fn list_patches() -> CmdResult<Vec<String>> {
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(patches_dir()) {
        for entry in entries.flatten() {
            if entry.path().join("patch.json").is_file() {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn load_patch_by_name(state: State<AppState>, name: String) -> CmdResult<()> {
    if !valid_patch_name(&name) {
        return Err(format!("invalid patch name: {name:?}"));
    }
    load_patch_dir(&state, &patches_dir().join(&name))?;
    *state.patch_name.lock().map_err(err)? = name;
    Ok(())
}

#[tauri::command]
fn current_patch(state: State<AppState>) -> CmdResult<String> {
    Ok(state.patch_name.lock().map_err(err)?.clone())
}

fn load_patch_dir(state: &State<AppState>, dir: &Path) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(state, &engine, &format!("load:{}", dir.display()));
    engine.stop().map_err(err)?;
    let registry = ExtensionRegistry::discover(&extension_dirs()).map_err(err)?;
    *engine = Engine::load_patch(dir, registry).map_err(err)?;
    // Decks: re-apply library-stored DJ metadata (cues/loops/beatgrids)
    // for every loaded deck track (PRD §7 — metadata survives across
    // patches via the library DB, not the patch files).
    let deck_instances: Vec<String> = engine
        .nodes
        .iter()
        .filter(|n| n.is_deck())
        .map(|n| n.instance_id.clone())
        .collect();
    for instance in deck_instances {
        apply_deck_metadata(state, &mut engine, &instance)?;
    }
    Ok(())
}

#[derive(Serialize)]
struct MacroConflictInfo {
    macro_id: String,
    name: String,
    patch_version: u32,
    library_version: u32,
}

/// Macro definitions stored in the user library DB, as an engine-side
/// `MacroLibrary`.
fn db_macro_library(library: &Library) -> CmdResult<MacroLibrary> {
    let mut lib = MacroLibrary::default();
    for r in library.macros().map_err(err)? {
        match serde_json::from_str::<MacroDef>(&r.definition) {
            Ok(def) => lib.register(def),
            Err(e) => eprintln!("[dj-macros] bad stored definition for {}: {e}", r.id),
        }
    }
    Ok(lib)
}

fn persist_macro(library: &Library, def: &MacroDef) -> CmdResult<()> {
    library
        .save_macro(&dj_library::MacroRecord {
            id: def.id.clone(),
            name: def.name.clone(),
            version: def.version as i64,
            definition: serde_json::to_string(def).map_err(err)?,
        })
        .map_err(err)
}

/// Load a patch, resolving macro version mismatches (PRD §6). When the
/// patch's embedded macro definitions disagree with the library and no
/// `resolutions` decide them yet, the engine is left untouched and the
/// conflicts are returned so the UI can prompt (update vs fork) and call
/// again. `resolutions` entries are `(macro_id, "update" | "fork")`.
#[tauri::command]
fn load_patch(
    state: State<AppState>,
    dir: String,
    resolutions: Option<Vec<(String, String)>>,
) -> CmdResult<Vec<MacroConflictInfo>> {
    let mut engine = state.engine.lock().map_err(err)?;
    let mut doc = PatchDoc::read(Path::new(&dir)).map_err(err)?;
    let mut lib = db_macro_library(&state.library)?;
    for (macro_id, action) in resolutions.unwrap_or_default() {
        let resolution = match action.as_str() {
            "update" => MacroResolution::UpdateToLibrary,
            "fork" => {
                let mut new_id = format!("{macro_id}-fork");
                let mut n = 2;
                while lib.get(&new_id).is_some() || doc.macros.contains_key(&new_id) {
                    new_id = format!("{macro_id}-fork-{n}");
                    n += 1;
                }
                MacroResolution::Fork { new_id }
            }
            other => return Err(format!("unknown macro resolution {other:?}")),
        };
        doc.resolve_macro_conflict(&macro_id, &resolution, &mut lib)
            .map_err(err)?;
        if let MacroResolution::Fork { new_id } = &resolution {
            if let Some(def) = lib.get(new_id) {
                persist_macro(&state.library, def)?;
            }
        }
    }
    let conflicts = doc.macro_conflicts(&lib);
    if !conflicts.is_empty() {
        return Ok(conflicts
            .into_iter()
            .map(|c| MacroConflictInfo {
                name: doc
                    .macros
                    .get(&c.macro_id)
                    .map(|d| d.name.clone())
                    .unwrap_or_else(|| c.macro_id.clone()),
                macro_id: c.macro_id,
                patch_version: c.patch_version,
                library_version: c.library_version,
            })
            .collect());
    }
    record_edit(&state, &engine, &format!("load:{dir}"));
    engine.stop().map_err(err)?;
    let registry = ExtensionRegistry::discover(&extension_dirs()).map_err(err)?;
    *engine = Engine::from_doc_with_macros(&doc, registry, lib).map_err(err)?;
    // Decks: re-apply library-stored DJ metadata (cues/loops/beatgrids)
    // for every loaded deck track (PRD §7 — metadata survives across
    // patches via the library DB, not the patch files).
    let deck_instances: Vec<String> = engine
        .nodes
        .iter()
        .filter(|n| n.is_deck())
        .map(|n| n.instance_id.clone())
        .collect();
    for instance in deck_instances {
        apply_deck_metadata(&state, &mut engine, &instance)?;
    }
    Ok(Vec::new())
}

#[derive(Serialize)]
struct MacroInfo {
    id: String,
    name: String,
    version: u32,
}

/// Macros available for instantiation (user library, PRD §6).
#[tauri::command]
fn list_macros(state: State<AppState>) -> CmdResult<Vec<MacroInfo>> {
    let engine = state.engine.lock().map_err(err)?;
    Ok(engine
        .macros
        .list()
        .into_iter()
        .map(|d| MacroInfo {
            id: d.id.clone(),
            name: d.name.clone(),
            version: d.version,
        })
        .collect())
}

/// Auto-derived macro interface for a rack selection: boundary wires are
/// promoted (required for a valid collapse); every other input jack of a
/// selected module that isn't wired inside the selection is promoted too,
/// so instances keep their knobs. External ids prefer the bare jack id and
/// fall back to `<node>_<jack>` on collision.
fn auto_interface(engine: &Engine, selection: &[String]) -> MacroInterface {
    let sel: std::collections::BTreeSet<&str> = selection.iter().map(|s| s.as_str()).collect();
    let doc = engine.snapshot("collapse");
    let mut interface = MacroInterface::default();
    let mut in_ids = std::collections::BTreeSet::new();
    let mut out_ids = std::collections::BTreeSet::new();
    let mut internally_wired = std::collections::BTreeSet::new();

    let promote_in = |interface: &mut MacroInterface,
                      ids: &mut std::collections::BTreeSet<String>,
                      node: &str,
                      jack: &str| {
        if interface
            .inputs
            .iter()
            .any(|j| j.node == node && j.jack == jack)
        {
            return;
        }
        let id = if ids.insert(jack.to_string()) {
            jack.to_string()
        } else {
            let id = format!("{node}_{jack}");
            ids.insert(id.clone());
            id
        };
        interface.inputs.push(MacroJack {
            id,
            node: node.to_string(),
            jack: jack.to_string(),
        });
    };
    let promote_out = |interface: &mut MacroInterface,
                       ids: &mut std::collections::BTreeSet<String>,
                       node: &str,
                       jack: &str| {
        if interface
            .outputs
            .iter()
            .any(|j| j.node == node && j.jack == jack)
        {
            return;
        }
        let id = if ids.insert(jack.to_string()) {
            jack.to_string()
        } else {
            let id = format!("{node}_{jack}");
            ids.insert(id.clone());
            id
        };
        interface.outputs.push(MacroJack {
            id,
            node: node.to_string(),
            jack: jack.to_string(),
        });
    };

    // Boundary wires first — these promotions are mandatory.
    for (src, wf) in &doc.wires {
        for w in &wf.wires {
            let src_in = sel.contains(src.as_str());
            let dst_in = sel.contains(w.to.as_str());
            if src_in && dst_in {
                internally_wired.insert((w.to.clone(), w.to_jack.clone()));
            } else if dst_in {
                promote_in(&mut interface, &mut in_ids, &w.to, &w.to_jack);
            } else if src_in {
                promote_out(&mut interface, &mut out_ids, src, &w.from_jack);
            }
        }
    }
    // Remaining jacks of the selected modules (macro instances included —
    // macros nest, so a selected macro's external jacks promote the same
    // way as a plain module's).
    for id in selection {
        let (inputs, outputs): (Vec<String>, Vec<String>) =
            if let Some(n) = engine.nodes.iter().find(|n| &n.instance_id == id) {
                (
                    n.manifest.inputs.iter().map(|j| j.id.clone()).collect(),
                    n.manifest.outputs.iter().map(|o| o.id.clone()).collect(),
                )
            } else if let Some(m) = engine
                .macro_instances()
                .get(id)
                .and_then(|mi| engine.macro_manifest(&mi.macro_id))
            {
                (
                    m.inputs.iter().map(|j| j.id.clone()).collect(),
                    m.outputs.iter().map(|o| o.id.clone()).collect(),
                )
            } else {
                continue;
            };
        for jack in inputs {
            if !internally_wired.contains(&(id.clone(), jack.clone())) {
                promote_in(&mut interface, &mut in_ids, id, &jack);
            }
        }
        for jack in outputs {
            promote_out(&mut interface, &mut out_ids, id, &jack);
        }
    }
    interface
}

/// Collapse the selected rack modules into a new macro (PRD §6). Returns
/// the new instance's id; the definition lands in the user library DB.
#[tauri::command]
fn collapse_macro(
    state: State<AppState>,
    selection: Vec<String>,
    name: String,
) -> CmdResult<String> {
    if selection.is_empty() {
        return Err("empty selection".into());
    }
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, "collapse_macro");
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let mut macro_id = format!("macro.{slug}");
    let mut n = 2;
    while engine.macros.get(&macro_id).is_some() {
        macro_id = format!("macro.{slug}-{n}");
        n += 1;
    }
    let taken: std::collections::BTreeSet<String> = engine
        .nodes
        .iter()
        .map(|nd| nd.instance_id.clone())
        .collect();
    let mut instance = slug.clone();
    let mut k = 2;
    while taken.contains(&instance) {
        instance = format!("{slug}-{k}");
        k += 1;
    }
    let interface = auto_interface(&engine, &selection);
    let sel_refs: Vec<&str> = selection.iter().map(|s| s.as_str()).collect();
    let def = with_stopped(&mut engine, |e| {
        e.collapse_to_macro(&sel_refs, &instance, &macro_id, &name, interface)
            .map_err(err)
    })?;
    persist_macro(&state.library, &def)?;
    Ok(instance)
}

#[tauri::command]
fn inject_midi(
    state: State<AppState>,
    instance: String,
    frame: u64,
    data: [u8; 3],
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.inject_midi(&instance, frame, data).map_err(err)
}

#[tauri::command]
fn engine_start(state: State<AppState>) -> CmdResult<String> {
    let mut engine = state.engine.lock().map_err(err)?;
    if engine.is_running() {
        return Ok("already-running".into());
    }
    match engine.start_cpal() {
        Ok(()) => {
            eprintln!("[dj-audio] engine started on the cpal device backend");
            Ok("cpal".into())
        }
        Err(e) => {
            // Headless / no audio device: fall back to the null realtime
            // backend so telemetry and the UI still run.
            eprintln!(
                "[dj-audio] WARNING: cpal start failed ({e}); \
                 falling back to the SILENT null backend — no device audio"
            );
            engine.start_null_realtime().map_err(err)?;
            Ok("null".into())
        }
    }
}

#[tauri::command]
fn engine_stop(state: State<AppState>) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.stop().map_err(err)
}

// ---------------------------------------------------------------------------
// Library + acquisition (M1)
// ---------------------------------------------------------------------------

#[tauri::command]
fn library_tracks(state: State<AppState>) -> CmdResult<Vec<Track>> {
    state.library.tracks().map_err(err)
}

#[tauri::command]
fn library_search(state: State<AppState>, text: String) -> CmdResult<Vec<Track>> {
    state.library.search(&text).map_err(err)
}

/// Enabled acquisition providers with their UI filter specs (per-store
/// search tabs).
#[tauri::command]
fn providers(state: State<AppState>) -> CmdResult<Vec<ProviderInfo>> {
    Ok(state.hub.providers_info())
}

/// Search one store, with that store's filter selections.
#[tauri::command]
fn search_provider(
    state: State<AppState>,
    provider: String,
    text: String,
    filters: BTreeMap<String, String>,
) -> CmdResult<Vec<TrackResult>> {
    let mut q = Query::new(&text);
    q.filters = filters;
    state.hub.search_provider(&provider, &q).map_err(err)
}

#[tauri::command]
fn import_track(state: State<AppState>, path: String) -> CmdResult<Track> {
    state
        .library
        .import_file(&PathBuf::from(path), dj_library::ImportOptions::default())
        .map(|o| o.track().clone())
        .map_err(err)
}

#[derive(Serialize)]
struct RekordboxImportSummary {
    imported: usize,
    duplicates: usize,
}

/// Import a rekordbox XML export (M4, PRD §8.1): tracks, beatgrids, hot
/// cues, and loops land in the library DB; existing tracks (by path) skip.
#[tauri::command]
fn import_rekordbox(state: State<AppState>, path: String) -> CmdResult<RekordboxImportSummary> {
    let report = state
        .library
        .import_rekordbox_xml(Path::new(&path))
        .map_err(err)?;
    Ok(RekordboxImportSummary {
        imported: report.imported.len(),
        duplicates: report.duplicates.len(),
    })
}

#[tauri::command]
fn download_track(state: State<AppState>, result: TrackResult) -> CmdResult<Track> {
    state
        .hub
        .download_to_library(&state.library, &result)
        .map_err(err)
}

/// Deep-link acquisition: resolves the store URL, opens it in the system
/// browser, and returns it (M1: iTunes purchases land via the watch folder).
#[tauri::command]
fn open_store_page(state: State<AppState>, result: TrackResult) -> CmdResult<String> {
    state
        .hub
        .open_deep_link(&result, |url| {
            open::that_detached(url).map_err(anyhow::Error::from)
        })
        .map_err(err)
}

/// Open a web URL in the system's default browser (never in the app's
/// webview). Restricted to http(s) so IPC can't be used to launch
/// arbitrary local files/schemes.
#[tauri::command]
fn open_external(url: String) -> CmdResult<()> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("refusing to open non-http(s) URL: {url}"));
    }
    open::that_detached(&url).map_err(err)
}

#[tauri::command]
fn add_watch_folder(state: State<AppState>, path: String) -> CmdResult<()> {
    state
        .library
        .add_watch_folder(&PathBuf::from(path))
        .map_err(err)
}

#[tauri::command]
fn watch_folders(state: State<AppState>) -> CmdResult<Vec<String>> {
    Ok(state
        .library
        .watch_folders()
        .map_err(err)?
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

/// Load a library track into a Playback module instance.
#[tauri::command]
fn playback_load(state: State<AppState>, instance: String, track_id: i64) -> CmdResult<()> {
    let track = state.library.track(track_id).map_err(err)?;
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("track:{instance}"));
    engine
        .playback_load(&instance, &PathBuf::from(track.file_path))
        .map_err(err)
}

// ---------------------------------------------------------------------------
// DJ Deck (M2). The library DB is the canonical store for cues/loops/
// beatgrids (PRD §7): every set is written through to the library, and
// loading a track (or a patch) re-applies the stored metadata.
// ---------------------------------------------------------------------------

/// Library row id for the track loaded in a deck, if it's a library track.
fn deck_library_track(state: &AppState, engine: &Engine, instance: &str) -> Option<Track> {
    let path = engine.deck_track(instance).ok()??;
    state.library.track_by_path(Path::new(&path)).ok()?
}

/// Re-apply a track's library metadata (beatgrid, cues, first saved loop)
/// to a deck. Used after deck_load and after patch load.
fn apply_deck_metadata(state: &AppState, engine: &mut Engine, instance: &str) -> CmdResult<()> {
    let Some(track) = deck_library_track(state, engine, instance) else {
        return Ok(());
    };
    if let Some(grid) = state.library.track_beatgrid(track.id).map_err(err)? {
        engine
            .deck_set_beatgrid(instance, grid.bpm, grid.anchor_secs)
            .map_err(err)?;
    }
    for cue in state.library.track_cues(track.id).map_err(err)? {
        engine
            .deck_set_cue(instance, cue.slot as usize, Some(cue.position_secs))
            .map_err(err)?;
    }
    if let Some(l) = state.library.track_loops(track.id).map_err(err)?.first() {
        engine
            .deck_set_loop(instance, l.start_secs, l.end_secs)
            .map_err(err)?;
    }
    // Cached stems (M3, keyed by content hash) auto-load with the track.
    // Best-effort: a missing/failed stem cache must not break deck load.
    let dir = dj_analysis::stems_dir(state.library.data_dir(), &track.content_hash);
    if dj_analysis::stems_cached(&dir) {
        if let Err(e) = engine.deck_load_stems(instance, &dj_analysis::stem_paths(&dir)) {
            eprintln!("[dj-analysis] loading stems for {instance}: {e:#}");
        }
    }
    Ok(())
}

/// Analysis queue snapshot for the Library view (M3).
#[derive(Serialize)]
struct AnalysisQueueSnapshot {
    /// Track currently being analyzed, if any.
    current: Option<i64>,
    /// Track ids still waiting (queue order).
    queued: Vec<i64>,
    /// Track counts by analysis status.
    counts: BTreeMap<String, usize>,
}

#[tauri::command]
fn analysis_status(state: State<AppState>) -> CmdResult<AnalysisQueueSnapshot> {
    let current = state.analysis.current_track();
    let queued: Vec<i64> = state
        .library
        .analysis_queue()
        .map_err(err)?
        .into_iter()
        .map(|t| t.id)
        .filter(|id| Some(*id) != current)
        .collect();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for t in state.library.tracks().map_err(err)? {
        *counts.entry(t.analysis_status).or_default() += 1;
    }
    Ok(AnalysisQueueSnapshot {
        current,
        queued,
        counts,
    })
}

/// Queue (or re-queue) analysis for a track; the background worker picks
/// it up. Stems already cached for the same content are reused.
#[tauri::command]
fn analyze_track(state: State<AppState>, track_id: i64) -> CmdResult<()> {
    state.library.requeue_analysis(track_id).map_err(err)
}

/// Load the cached stems for the deck's current track (e.g. after
/// analysis finished while the track was already loaded).
#[tauri::command]
fn deck_load_stems(state: State<AppState>, instance: String) -> CmdResult<bool> {
    let mut engine = state.engine.lock().map_err(err)?;
    let Some(track) = deck_library_track(&state, &engine, &instance) else {
        return Ok(false);
    };
    let dir = dj_analysis::stems_dir(state.library.data_dir(), &track.content_hash);
    if !dj_analysis::stems_cached(&dir) {
        return Ok(false);
    }
    engine
        .deck_load_stems(&instance, &dj_analysis::stem_paths(&dir))
        .map_err(err)?;
    Ok(true)
}

#[tauri::command]
fn deck_clear_stems(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.deck_clear_stems(&instance).map_err(err)
}

/// Write the deck's current beatgrid through to the library.
fn persist_deck_grid(state: &AppState, engine: &Engine, instance: &str) -> CmdResult<()> {
    if let (Some(track), Ok(Some((bpm, anchor)))) = (
        deck_library_track(state, engine, instance),
        engine.deck_beatgrid(instance),
    ) {
        state
            .library
            .set_track_beatgrid(track.id, bpm, anchor)
            .map_err(err)?;
    }
    Ok(())
}

/// Load a library track into a deck and re-apply its DJ metadata.
#[tauri::command]
fn deck_load(state: State<AppState>, instance: String, track_id: i64) -> CmdResult<()> {
    let track = state.library.track(track_id).map_err(err)?;
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("track:{instance}"));
    engine
        .deck_load(&instance, &PathBuf::from(track.file_path))
        .map_err(err)?;
    apply_deck_metadata(&state, &mut engine, &instance)
}

#[tauri::command]
fn deck_status(state: State<AppState>, instance: String) -> CmdResult<dj_engine::deck::DeckStatus> {
    let engine = state.engine.lock().map_err(err)?;
    engine.deck_status(&instance).map_err(err)
}

/// Waveform overview peaks (0..=1), `buckets` values.
#[tauri::command]
fn deck_waveform(state: State<AppState>, instance: String, buckets: usize) -> CmdResult<Vec<f32>> {
    let engine = state.engine.lock().map_err(err)?;
    engine
        .deck_waveform(&instance, buckets.min(20_000))
        .map_err(err)
}

#[tauri::command]
fn deck_seek(state: State<AppState>, instance: String, position: f64) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.deck_seek(&instance, position).map_err(err)
}

/// Set (Some) or clear (None) a hot cue; written through to the library.
#[tauri::command]
fn deck_set_cue(
    state: State<AppState>,
    instance: String,
    slot: usize,
    position: Option<f64>,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine
        .deck_set_cue(&instance, slot, position)
        .map_err(err)?;
    if let Some(track) = deck_library_track(&state, &engine, &instance) {
        match position {
            Some(pos) => state
                .library
                .set_track_cue(track.id, slot as u8, pos, "")
                .map_err(err)?,
            None => state
                .library
                .clear_track_cue(track.id, slot as u8)
                .map_err(err)?,
        }
    }
    Ok(())
}

/// Set the active loop region (transient until saved).
#[tauri::command]
fn deck_set_loop(state: State<AppState>, instance: String, start: f64, end: f64) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.deck_set_loop(&instance, start, end).map_err(err)
}

#[tauri::command]
fn deck_loop_enable(state: State<AppState>, instance: String, enabled: bool) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.deck_loop_enable(&instance, enabled).map_err(err)
}

#[tauri::command]
fn deck_loop_halve(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.deck_loop_halve(&instance).map_err(err)
}

#[tauri::command]
fn deck_loop_double(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.deck_loop_double(&instance).map_err(err)
}

/// Save the current loop region as a named library loop for the track.
#[tauri::command]
fn deck_save_loop(state: State<AppState>, instance: String, name: String) -> CmdResult<i64> {
    let engine = state.engine.lock().map_err(err)?;
    let status = engine.deck_status(&instance).map_err(err)?;
    let (Some(start), Some(end)) = (status.loop_start_secs, status.loop_end_secs) else {
        return Err("no loop region set".into());
    };
    let track =
        deck_library_track(&state, &engine, &instance).ok_or("deck track is not in the library")?;
    state
        .library
        .add_track_loop(track.id, &name, start, end)
        .map_err(err)
}

/// Saved loops for the deck's current track.
#[tauri::command]
fn deck_saved_loops(
    state: State<AppState>,
    instance: String,
) -> CmdResult<Vec<dj_library::SavedLoop>> {
    let engine = state.engine.lock().map_err(err)?;
    match deck_library_track(&state, &engine, &instance) {
        Some(track) => state.library.track_loops(track.id).map_err(err),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
fn deck_set_beatgrid(
    state: State<AppState>,
    instance: String,
    bpm: f64,
    anchor: f64,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine
        .deck_set_beatgrid(&instance, bpm, anchor)
        .map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)
}

/// Tap tempo at the live playhead; the resulting grid persists.
#[tauri::command]
fn deck_tap_tempo(state: State<AppState>, instance: String) -> CmdResult<Option<(f64, f64)>> {
    let mut engine = state.engine.lock().map_err(err)?;
    let grid = engine.deck_tap_tempo(&instance).map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)?;
    Ok(grid)
}

/// Nudge the beatgrid anchor by `delta` seconds.
#[tauri::command]
fn deck_nudge_beatgrid(state: State<AppState>, instance: String, delta: f64) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.deck_nudge_beatgrid(&instance, delta).map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)
}

/// Re-anchor the beatgrid at the current playhead.
#[tauri::command]
fn deck_anchor_here(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.deck_anchor_here(&instance).map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)
}

/// Beat-sync a deck to another deck (None clears sync).
#[tauri::command]
fn deck_sync(state: State<AppState>, instance: String, master: Option<String>) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    engine.deck_sync(&instance, master.as_deref()).map_err(err)
}

fn extension_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        // Repo layout: target/{debug,release}/dj-station -> ../../extensions
        for anc in exe.ancestors().skip(1) {
            let cand = anc.join("extensions");
            if cand.is_dir() {
                dirs.push(cand);
                break;
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for anc in cwd.ancestors() {
            let cand = anc.join("extensions");
            if cand.is_dir() && !dirs.contains(&cand) {
                dirs.push(cand);
                break;
            }
        }
    }
    dirs
}

fn main() {
    let registry =
        ExtensionRegistry::discover(&extension_dirs()).expect("extension discovery failed");
    let mut engine =
        Engine::new(EngineConfig::default(), registry).expect("engine construction failed");

    // Library under the single user data dir (PRD §3); watch folders +
    // provider hub (keyed providers enabled via env, see README).
    let library =
        Arc::new(Library::open(&dj_library::default_data_dir()).expect("library open failed"));
    // User-library macros are instantiable from the start (PRD §6).
    match db_macro_library(&library) {
        Ok(lib) => {
            for def in lib.defs.into_values() {
                engine.register_macro(def);
            }
        }
        Err(e) => eprintln!("[dj-macros] loading macro library failed: {e}"),
    }
    let watcher =
        dj_library::start_watcher(library.clone(), dj_library::watch::DEFAULT_POLL_INTERVAL);
    let hub = AcquisitionHub::from_env();
    // M3: background analysis worker. Defaults to the DSP stem separator;
    // an ONNX model can be swapped in via the `onnx` feature of
    // dj-analysis (CoreML EP on macOS, CPU EP elsewhere).
    let analysis =
        dj_analysis::start_worker(library.clone(), dj_analysis::AnalysisSettings::default());

    tauri::Builder::default()
        .manage(AppState {
            engine: Mutex::new(engine),
            history: Mutex::new(UndoHistory::new()),
            library,
            hub,
            patch_name: Mutex::new("untitled".into()),
            last_autosave: Mutex::new(None),
            _watcher: watcher,
            analysis,
            gesture_feeds: Mutex::new(BTreeMap::new()),
        })
        .setup(|app| {
            // Periodic crash-recovery autosave (skips unchanged states).
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(15));
                autosave_now(&handle.state::<AppState>());
            });
            // M4 (PRD §7.1): LED feedback pump. When DJ_MIDI_OUT_PORT names
            // a hardware MIDI output port, forward engine-generated note/CC
            // out messages to it from a control-rate background thread
            // (never the RT thread). Headless/CI: env unset ⇒ no thread.
            let port = std::env::var("DJ_MIDI_OUT_PORT").unwrap_or_default();
            if !port.is_empty() {
                match Engine::open_midi_hardware_sink(&port) {
                    Ok(mut sink) => {
                        let handle = app.handle().clone();
                        std::thread::spawn(move || {
                            let state = handle.state::<AppState>();
                            loop {
                                if let Ok(mut engine) = state.engine.lock() {
                                    let midis: Vec<String> = engine
                                        .nodes
                                        .iter()
                                        .filter(|n| n.is_midi())
                                        .map(|n| n.instance_id.clone())
                                        .collect();
                                    for m in midis {
                                        let _ = engine.pump_midi_out(&m, &mut sink);
                                    }
                                }
                                std::thread::sleep(std::time::Duration::from_millis(30));
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[dj-midi] LED output port {port:?} unavailable: {e}")
                    }
                }
            }
            // System menu: platform defaults (App/Edit/Window on macOS)
            // plus File (save/load) and Debug (web inspector) submenus.
            let save = MenuItemBuilder::with_id("file_save", "Save Patch")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let save_as = MenuItemBuilder::with_id("file_save_as", "Save Patch As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let open = MenuItemBuilder::with_id("file_open", "Open Patch…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let file = SubmenuBuilder::new(app, "File")
                .item(&save)
                .item(&save_as)
                .item(&open)
                .build()?;
            let devtools = MenuItemBuilder::with_id("toggle_devtools", "Toggle Developer Tools")
                .accelerator("CmdOrCtrl+Alt+I")
                .build(app)?;
            let debug = SubmenuBuilder::new(app, "Debug").item(&devtools).build()?;
            let menu = Menu::default(app.handle())?;
            menu.append(&file)?;
            menu.append(&debug)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                autosave_now(&window.state::<AppState>());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle_devtools" => {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
            }
            // Save with the current name directly in the backend; Save As /
            // Open need frontend interaction (name prompt / patch picker).
            "file_save" => {
                let state = app.state::<AppState>();
                let name = state
                    .patch_name
                    .lock()
                    .map(|n| n.clone())
                    .unwrap_or_else(|_| "untitled".into());
                if let Err(e) = save_patch_as(app.state::<AppState>(), name) {
                    eprintln!("[dj-station] save failed: {e}");
                } else {
                    let _ = app.emit("dj-menu", "saved");
                }
            }
            "file_save_as" => {
                let _ = app.emit("dj-menu", "save-as");
            }
            "file_open" => {
                let _ = app.emit("dj-menu", "open");
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            list_extensions,
            list_modules,
            engine_nodes,
            engine_wires,
            add_module,
            remove_module,
            connect_wire,
            disconnect_wire,
            load_demo_patch,
            set_knob_position,
            set_knob_config,
            set_knob_atten_offset,
            set_param,
            tap,
            tap_all,
            save_patch,
            save_patch_as,
            list_patches,
            load_patch_by_name,
            current_patch,
            load_patch,
            list_macros,
            collapse_macro,
            inject_midi,
            add_midi_mapping,
            remove_midi_mapping,
            add_midi_led_mapping,
            remove_midi_led_mapping,
            gesture_status,
            gesture_set_mode,
            gesture_add_mapping,
            gesture_remove_mapping,
            gesture_learn_begin,
            gesture_learn_poll,
            gesture_feed_start,
            gesture_feed_stop,
            undo,
            redo,
            end_edit,
            engine_start,
            engine_stop,
            library_tracks,
            library_search,
            providers,
            search_provider,
            import_track,
            import_rekordbox,
            download_track,
            open_store_page,
            open_external,
            add_watch_folder,
            watch_folders,
            playback_load,
            deck_load,
            deck_status,
            deck_waveform,
            deck_seek,
            deck_set_cue,
            deck_set_loop,
            deck_loop_enable,
            deck_loop_halve,
            deck_loop_double,
            deck_save_loop,
            deck_saved_loops,
            deck_set_beatgrid,
            deck_tap_tempo,
            deck_nudge_beatgrid,
            deck_anchor_here,
            deck_sync,
            analysis_status,
            analyze_track,
            deck_load_stems,
            deck_clear_stems,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
