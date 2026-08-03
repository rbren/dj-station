// dj-station Tauri shell: hosts the Rust engine and exposes it to the React
// frontend over IPC. The engine itself lives in crates/dj-engine and is fully
// usable without this shell (see crates/dj-cli for the headless harness).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dj_engine::{
    Engine, EngineConfig, ExtensionRegistry, JackTelemetry, KnobConfig, KnobStyle, Manifest,
    PatchDoc, UndoHistory,
};
use dj_library::{AcquisitionHub, Library, ProviderInfo, Query, Track, TrackResult};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, State};

struct AppState {
    engine: Mutex<Engine>,
    history: Mutex<UndoHistory>,
    library: Arc<Library>,
    hub: AcquisitionHub,
    /// Watch-folder scanner; kept alive for the app's lifetime.
    _watcher: dj_library::WatchHandle,
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
    let backend = engine.backend_name();
    if backend.is_some() {
        engine.stop().map_err(err)?;
    }
    *engine = Engine::from_doc(doc, engine.registry.clone()).map_err(err)?;
    let deck_instances: Vec<String> = engine
        .nodes
        .iter()
        .filter(|n| n.ext_id == "builtin.deck")
        .map(|n| n.instance_id.clone())
        .collect();
    for instance in deck_instances {
        apply_deck_metadata(state, engine, &instance)?;
    }
    match backend {
        Some("cpal") => {
            if let Err(e) = engine.start_cpal() {
                eprintln!("[dj-audio] WARNING: cpal restart after undo/redo failed ({e})");
                engine.start_null_realtime().map_err(err)?;
            }
        }
        Some(_) => engine.start_null_realtime().map_err(err)?,
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
    let backend = engine.backend_name();
    if backend.is_some() {
        engine.stop().map_err(err)?;
    }
    let result = f(engine);
    match backend {
        Some("cpal") => {
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
        Some(_) => engine.start_null_realtime().map_err(err)?,
        None => {}
    }
    result
}

#[derive(Serialize)]
struct MidiMappingSnapshot {
    name: String,
    kind: String,
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
    let wires = engine.wire_specs().to_vec();
    Ok(engine
        .nodes
        .iter()
        .enumerate()
        .map(|(node_idx, n)| NodeSnapshot {
            instance_id: n.instance_id.clone(),
            type_id: n.ext_id.clone(),
            manifest: {
                let mut m = n.manifest.clone();
                // MIDI output jacks are dynamic: show only mapped controls
                // (by mapping name), not the 64 preallocated slots.
                if n.ext_id == dj_engine::builtin::MIDI_ID {
                    m.outputs = n
                        .midi_mappings
                        .iter()
                        .map(|mm| dj_engine::manifest::OutputDecl {
                            id: mm.name.clone(),
                            name: mm.name.clone(),
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
            wired_inputs: wires
                .iter()
                .filter(|w| w.to_node == node_idx)
                .filter_map(|w| n.manifest.inputs.get(w.to_jack).map(|d| d.id.clone()))
                .collect(),
            midi_mappings: n
                .midi_mappings
                .iter()
                .map(|m| MidiMappingSnapshot {
                    name: m.name.clone(),
                    kind: m.kind.clone(),
                    num: m.num,
                })
                .collect(),
        })
        .collect())
}

/// All module types that can be added to the rack (built-ins + extensions).
#[tauri::command]
fn list_modules(state: State<AppState>) -> CmdResult<Vec<Manifest>> {
    let engine = state.engine.lock().map_err(err)?;
    Ok(engine.registry.all_manifests())
}

#[tauri::command]
fn engine_wires(state: State<AppState>) -> CmdResult<Vec<WireSnapshot>> {
    let engine = state.engine.lock().map_err(err)?;
    Ok(engine
        .wire_specs()
        .iter()
        .map(|w| WireSnapshot {
            from_instance: engine.nodes[w.from_node].instance_id.clone(),
            from_jack: engine.output_jack_name(w.from_node, w.from_jack),
            to_instance: engine.nodes[w.to_node].instance_id.clone(),
            to_jack: engine.nodes[w.to_node].manifest.inputs[w.to_jack]
                .id
                .clone(),
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
        connect_as_wire(e, &from_instance, &from_jack, &to_instance, &to_jack)
    })
}

/// Connect a wire and switch the destination input's knob to the plain
/// "wire" style so the panel shows a jack instead of a knob.
fn connect_as_wire(
    e: &mut Engine,
    from_instance: &str,
    from_jack: &str,
    to_instance: &str,
    to_jack: &str,
) -> CmdResult<()> {
    e.connect(from_instance, from_jack, to_instance, to_jack)
        .map_err(err)?;
    let mut cfg = e
        .knob_state(to_instance, to_jack)
        .ok()
        .and_then(|k| k.config)
        .unwrap_or_default();
    cfg.style = KnobStyle::Wire;
    e.set_knob_config(to_instance, to_jack, Some(cfg))
        .map_err(err)
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
        // Undo the automatic wire-style override so the knob comes back
        // (only when it is still set to wire — respect manual choices).
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
    kind: String,
    num: u8,
    name: String,
) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("midi+:{instance}:{name}"));
    engine
        .add_midi_mapping(&instance, &kind, num, &name)
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

#[tauri::command]
fn load_demo_patch(state: State<AppState>) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    if !engine.nodes.is_empty() {
        return Ok(());
    }
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
        .add_midi_mapping("midi1", "note", 60, "C4")
        .map_err(err)?;
    connect_as_wire(&mut engine, "midi1", "C4", "adsr1", "gate")?;
    connect_as_wire(&mut engine, "osc1", "audio", "vca1", "in")?;
    connect_as_wire(&mut engine, "adsr1", "env", "vca1", "cv")?;
    connect_as_wire(&mut engine, "vca1", "out", "out1", "l")?;
    connect_as_wire(&mut engine, "vca1", "out", "out1", "r")?;
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

#[tauri::command]
fn save_patch(state: State<AppState>, dir: String, name: String) -> CmdResult<()> {
    let engine = state.engine.lock().map_err(err)?;
    engine.save_patch(&PathBuf::from(dir), &name).map_err(err)
}

#[tauri::command]
fn load_patch(state: State<AppState>, dir: String) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
    record_edit(&state, &engine, &format!("load:{dir}"));
    engine.stop().map_err(err)?;
    let registry = ExtensionRegistry::discover(&extension_dirs()).map_err(err)?;
    *engine = Engine::load_patch(&PathBuf::from(dir), registry).map_err(err)?;
    // Decks: re-apply library-stored DJ metadata (cues/loops/beatgrids)
    // for every loaded deck track (PRD §7 — metadata survives across
    // patches via the library DB, not the patch files).
    let deck_instances: Vec<String> = engine
        .nodes
        .iter()
        .filter(|n| n.ext_id == "builtin.deck")
        .map(|n| n.instance_id.clone())
        .collect();
    for instance in deck_instances {
        apply_deck_metadata(&state, &mut engine, &instance)?;
    }
    Ok(())
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
    Ok(())
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
    engine.deck_waveform(&instance, buckets.min(20_000)).map_err(err)
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
    engine.deck_set_cue(&instance, slot, position).map_err(err)?;
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
    let track = deck_library_track(&state, &engine, &instance)
        .ok_or("deck track is not in the library")?;
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
    let engine =
        Engine::new(EngineConfig::default(), registry).expect("engine construction failed");

    // Library under the single user data dir (PRD §3); watch folders +
    // provider hub (keyed providers enabled via env, see README).
    let library =
        Arc::new(Library::open(&dj_library::default_data_dir()).expect("library open failed"));
    let watcher =
        dj_library::start_watcher(library.clone(), dj_library::watch::DEFAULT_POLL_INTERVAL);
    let hub = AcquisitionHub::from_env();

    tauri::Builder::default()
        .manage(AppState {
            engine: Mutex::new(engine),
            history: Mutex::new(UndoHistory::new()),
            library,
            hub,
            _watcher: watcher,
        })
        .setup(|app| {
            // System menu: platform defaults (App/Edit/Window on macOS)
            // plus a Debug submenu exposing the web inspector.
            let devtools = MenuItemBuilder::with_id("toggle_devtools", "Toggle Developer Tools")
                .accelerator("CmdOrCtrl+Alt+I")
                .build(app)?;
            let debug = SubmenuBuilder::new(app, "Debug").item(&devtools).build()?;
            let menu = Menu::default(app.handle())?;
            menu.append(&debug)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "toggle_devtools" {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_extensions,
            list_modules,
            engine_nodes,
            engine_wires,
            add_module,
            connect_wire,
            disconnect_wire,
            load_demo_patch,
            set_knob_position,
            set_knob_config,
            set_knob_atten_offset,
            set_param,
            tap,
            save_patch,
            load_patch,
            inject_midi,
            add_midi_mapping,
            remove_midi_mapping,
            undo,
            redo,
            engine_start,
            engine_stop,
            library_tracks,
            library_search,
            providers,
            search_provider,
            import_track,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
