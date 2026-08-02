// dj-station Tauri shell: hosts the Rust engine and exposes it to the React
// frontend over IPC. The engine itself lives in crates/dj-engine and is fully
// usable without this shell (see crates/dj-cli for the headless harness).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dj_engine::{Engine, EngineConfig, ExtensionRegistry, JackTelemetry, KnobConfig, Manifest};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, State};

struct AppState {
    engine: Mutex<Engine>,
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
struct NodeSnapshot {
    instance_id: String,
    type_id: String,
    manifest: Manifest,
    knobs: BTreeMap<String, KnobSnapshot>,
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
            wired_inputs: wires
                .iter()
                .filter(|w| w.to_node == node_idx)
                .filter_map(|w| n.manifest.inputs.get(w.to_jack).map(|d| d.id.clone()))
                .collect(),
        })
        .collect())
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
    engine
        .connect("midi1", "pad_1", "adsr1", "gate")
        .map_err(err)?;
    engine.connect("osc1", "audio", "vca1", "in").map_err(err)?;
    engine.connect("adsr1", "env", "vca1", "cv").map_err(err)?;
    engine.connect("vca1", "out", "out1", "ch1").map_err(err)?;
    engine.connect("vca1", "out", "out1", "ch2").map_err(err)?;
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

    tauri::Builder::default()
        .manage(AppState {
            engine: Mutex::new(engine),
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
            engine_nodes,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
