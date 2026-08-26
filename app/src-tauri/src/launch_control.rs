//! Launch Control XL plumbing for the shell: the hot-plug device watcher
//! and the panel's status/ownership commands.
//!
//! The device path is HOT-PLUG BY POLLING (like the analysis queue and
//! the download jobs, no events): a background thread looks for the
//! surface's MIDI input port once a second and opens/drops the connection
//! as it appears and goes away, publishing presence on the engine so the
//! panel's indicator light can simply read it. Nothing here is required
//! for the module to work — with no controller attached (CI, headless)
//! the watcher just never finds a port, and the module is still driven by
//! `launchcontrol_inject` from tests and offline renders.
//!
//! Device messages arrive on midir's own callback thread, which must not
//! block: they cross a channel to a forwarder thread that owns the engine
//! lock, so a long command (patch load, deck decode) can never stall the
//! controller's callback.

use std::sync::mpsc;
use std::time::Duration;

use dj_engine::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{engine_lock, err, patch_edit, AppState, CmdResult, EditKey};

/// How often the watcher looks for the surface.
const SCAN_MS: u64 = 1000;

/// Everything the Launch Control panel polls for: is the surface here,
/// and who owns it.
#[derive(Serialize)]
pub struct LaunchControlStatus {
    connected: bool,
    /// Whether THIS module owns the surface.
    active: bool,
    /// The module that owns it (`None` = nobody), so a panel can say who
    /// has it instead of just "not you".
    active_instance: Option<String>,
}

#[tauri::command]
pub fn launchcontrol_status(
    state: State<AppState>,
    instance: String,
) -> CmdResult<LaunchControlStatus> {
    let engine = engine_lock(&state)?;
    let active = engine.launchcontrol_is_active(&instance).map_err(err)?;
    Ok(LaunchControlStatus {
        connected: engine.launchcontrol_connected(),
        active,
        active_instance: engine.launchcontrol_active_instance(),
    })
}

/// Hand the surface to this module (or take it away). Ownership is the
/// `active` param, which lives in the patch, so this is an ordinary
/// undoable param edit.
#[tauri::command]
pub fn launchcontrol_set_active(
    state: State<AppState>,
    instance: String,
    active: bool,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::Param(&instance, "active"))?;
    engine
        .launchcontrol_set_active(&instance, active)
        .map_err(err)
}

/// Start the device watcher and its message forwarder. Called once from
/// `setup`; both threads live for the app's lifetime.
pub fn spawn_watcher(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<[u8; 3]>();

    let forward_app = app.clone();
    std::thread::spawn(move || {
        while let Ok(data) = rx.recv() {
            let state = forward_app.state::<AppState>();
            let Ok(mut engine) = state.engine.lock() else {
                continue;
            };
            let frame = engine.current_frame();
            // No active module (or none on the rack at all) is the normal
            // idle state, not an error.
            let _ = engine.launchcontrol_feed(frame, data);
        }
    });

    std::thread::spawn(move || {
        let mut conn: Option<dj_engine::midir::MidiInputConnection<()>> = None;
        loop {
            let present = Engine::launchcontrol_port_present();
            match (present, conn.is_some()) {
                (true, false) => {
                    let tx = tx.clone();
                    match Engine::connect_launchcontrol_hardware(move |data| {
                        let _ = tx.send(data);
                    }) {
                        Ok(open) => {
                            conn = Some(open);
                            set_connected(&app, true);
                            eprintln!("[dj-midi] Launch Control XL connected");
                        }
                        Err(e) => eprintln!("[dj-midi] Launch Control XL connect failed: {e:#}"),
                    }
                }
                (false, true) => {
                    conn = None;
                    set_connected(&app, false);
                    eprintln!("[dj-midi] Launch Control XL disconnected");
                }
                _ => {}
            }
            std::thread::sleep(Duration::from_millis(SCAN_MS));
        }
    });
}

fn set_connected(app: &AppHandle, connected: bool) {
    let state = app.state::<AppState>();
    let Ok(mut engine) = state.engine.lock() else {
        return;
    };
    engine.launchcontrol_set_connected(connected);
}
