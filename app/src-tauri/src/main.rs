// dj-station Tauri shell: hosts the Rust engine and exposes it to the React
// frontend over IPC. The engine itself lives in crates/dj-engine and is fully
// usable without this shell (see crates/dj-cli for the headless harness).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dj_engine::{
    Engine, EngineConfig, ExtensionRegistry, JackTelemetry, KnobConfig, KnobStyle, Manifest,
};
use dj_library::providers::SearchOutcome;
use dj_library::{AcquisitionHub, Library, Query, Track, TrackResult};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, State};

struct AppState {
    engine: Mutex<Engine>,
    library: Arc<Library>,
    hub: AcquisitionHub,
    /// Watch-folder scanner; kept alive for the app's lifetime.
    _watcher: dj_library::WatchHandle,
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
        Some("cpal") if engine.start_cpal().is_ok() => {}
        Some(_) => engine.start_null_realtime().map_err(err)?,
        None => {}
    }
    result
}

#[derive(Serialize)]
struct NodeSnapshot {
    instance_id: String,
    type_id: String,
    manifest: Manifest,
    knobs: BTreeMap<String, KnobSnapshot>,
    params: BTreeMap<String, f32>,
    wired_inputs: Vec<String>,
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
            manifest: n.manifest.clone(),
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
        .add_midi_mapping("midi1", "note", 60, "pad_1")
        .map_err(err)?;
    connect_as_wire(&mut engine, "midi1", "pad_1", "adsr1", "gate")?;
    connect_as_wire(&mut engine, "osc1", "audio", "vca1", "in")?;
    connect_as_wire(&mut engine, "adsr1", "env", "vca1", "cv")?;
    connect_as_wire(&mut engine, "vca1", "out", "out1", "ch1")?;
    connect_as_wire(&mut engine, "vca1", "out", "out1", "ch2")?;
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
    engine
        .set_knob_atten_offset(&instance, &jack, atten, offset)
        .map_err(err)
}

#[tauri::command]
fn set_param(state: State<AppState>, instance: String, param: String, value: f32) -> CmdResult<()> {
    let mut engine = state.engine.lock().map_err(err)?;
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
    engine.stop().map_err(err)?;
    let registry = ExtensionRegistry::discover(&extension_dirs()).map_err(err)?;
    *engine = Engine::load_patch(&PathBuf::from(dir), registry).map_err(err)?;
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
        Ok(()) => Ok("cpal".into()),
        Err(_) => {
            // Headless / no audio device: fall back to the null realtime
            // backend so telemetry and the UI still run.
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

#[tauri::command]
fn provider_search(state: State<AppState>, text: String) -> CmdResult<SearchOutcome> {
    Ok(state.hub.search(&Query::new(&text)))
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
    engine
        .playback_load(&instance, &PathBuf::from(track.file_path))
        .map_err(err)
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
            engine_start,
            engine_stop,
            library_tracks,
            library_search,
            provider_search,
            import_track,
            download_track,
            open_store_page,
            open_external,
            add_watch_folder,
            watch_folders,
            playback_load,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
