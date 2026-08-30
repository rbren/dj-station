//! Decks tab IPC: the bank of eight clip slots the page draws, and the
//! Beatify clips that go in them.
//!
//! The tab is a big panel for ONE rack module (`builtin.decks`), so
//! everything here is an ordinary engine edit — the bank is in the patch
//! and it is wired into the graph. [`decks_ensure`] is the page's "give
//! me the decks" gesture: it finds the bank or makes one, and gives its
//! live and cue pairs somewhere to play, in one undo step.
//!
//! A clip is placements, not audio (see [`crate::beatify_clip`]), so the
//! patch keeps the BINDING and the samples are assembled here — when the
//! user drops a clip into a slot, and again after a patch load or an undo
//! that brought the bank back ([`hydrate`]). Assembling decodes and mixes
//! seconds of audio, so those commands are `async`: a sync command runs
//! on the main thread and would freeze the window.

use dj_engine::beat_clip::BeatClipRef;
use dj_engine::decks::{DeckArm, DecksStatus, MasterBus, SlotControl, DECKS_ID, SURFACE_PARAM};
use dj_engine::playback::TrackData;
use dj_engine::{Engine, Workspace};
use tauri::State;

use crate::beatify_clip::{render_clip, RenderedClip};
use crate::{engine_lock, err, patch_edit, AppState, CmdResult, EditKey};

/// Every Decks bank on the rack (usually one).
#[tauri::command]
pub fn decks_banks(state: State<AppState>) -> CmdResult<Vec<String>> {
    Ok(engine_lock(&state)?.decks_nodes())
}

/// The bank the Decks tab drives, wired so it can be HEARD: the first one
/// on the rack, or a new one. One undo step, because it is one act —
/// "give me the decks".
///
/// The page calls this when it opens as well as from its empty state, so
/// a bank whose live pair goes nowhere — the state a bank added to a
/// patch with no Audio Output used to be left in, audible in the
/// headphones and nowhere else — gets an output the moment it is looked
/// at. Nothing to do is not an edit: no bank is created without being
/// asked, no wire is moved, and no undo step is recorded.
#[tauri::command]
pub fn decks_ensure(state: State<AppState>) -> CmdResult<String> {
    let existing = {
        let engine = engine_lock(&state)?;
        match engine.decks_nodes().into_iter().next() {
            Some(first) => {
                // The bank belongs to the Decks workspace. A pre-workspace
                // session's bank carries the Rack default and gets moved
                // (below) the first time the page looks at it.
                if engine.module_workspace(&first).map_err(err)? == Workspace::Decks
                    && engine.decks_loose_outputs(&first).map_err(err)? == (false, false)
                {
                    return Ok(first);
                }
                Some(first)
            }
            None => None,
        }
    };
    let mut engine = patch_edit(&state, EditKey::Add("decks"))?;
    let instance = match existing {
        Some(bank) => bank,
        None => {
            let instance = fresh_id(&engine);
            engine.add_module(&instance, DECKS_ID).map_err(err)?;
            instance
        }
    };
    engine
        .set_module_workspace(&instance, Workspace::Decks)
        .map_err(err)?;
    engine.decks_connect_outputs(&instance).map_err(err)?;
    Ok(instance)
}

fn fresh_id(engine: &Engine) -> String {
    let taken: std::collections::BTreeSet<&str> = engine
        .nodes
        .iter()
        .map(|n| n.instance_id.as_str())
        .collect();
    (1..)
        .map(|n| format!("decks{n}"))
        .find(|id| !taken.contains(id.as_str()))
        .unwrap()
}

#[tauri::command]
pub fn decks_status(state: State<AppState>, instance: String) -> CmdResult<DecksStatus> {
    let engine = engine_lock(&state)?;
    engine.decks_status(&instance).map_err(err)
}

/// Assemble a Beatify clip and drop it into a slot. It arrives muted and
/// on the bank's grid (`Engine::decks_load`); the level, tone controls and
/// solo the slot already had stay where the user left them.
#[tauri::command(async)]
pub fn decks_load(
    state: State<AppState>,
    instance: String,
    slot: usize,
    project_id: String,
    clip_id: String,
) -> CmdResult<()> {
    // Assemble BEFORE taking the engine lock: this decodes and mixes.
    let rendered = render_clip(&state, &project_id, &clip_id)?;
    let clip = BeatClipRef {
        project: project_id,
        clip: clip_id,
        name: rendered.name.clone(),
        project_name: rendered.project_name.clone(),
        stems: rendered.stems.clone(),
    };
    let mut engine = patch_edit(&state, EditKey::DeckSlot(&instance, slot))?;
    engine
        .decks_load(
            &instance,
            slot,
            Some(clip),
            track_data(&rendered),
            rendered.bpm,
        )
        .map_err(err)
}

#[tauri::command]
pub fn decks_clear(state: State<AppState>, instance: String, slot: usize) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::DeckSlot(&instance, slot))?;
    engine.decks_clear(&instance, slot).map_err(err)
}

/// One of a slot's controls — the six the Launch Control XL column
/// carries, plus the insert's wetness knob and its cue button. Coalesced
/// per control, so a fader drag is one undo step rather than a hundred.
#[tauri::command]
pub fn decks_set_control(
    state: State<AppState>,
    instance: String,
    slot: usize,
    control: SlotControl,
    value: f32,
) -> CmdResult<()> {
    let name = control_key(control);
    let mut engine = patch_edit(&state, EditKey::DeckSlotControl(&instance, slot, name))?;
    engine
        .decks_set_control(&instance, slot, control, value)
        .map_err(err)
}

/// Queue or drop a deck — its mute, taken on the bank's grid instead of
/// under the finger (`Engine::decks_arm`). The edit the patch keeps is the
/// mute the arm is heading for, so it coalesces with the mute button's.
#[tauri::command]
pub fn decks_arm(
    state: State<AppState>,
    instance: String,
    slot: usize,
    arm: DeckArm,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::DeckSlotControl(&instance, slot, "mute"))?;
    engine.decks_arm(&instance, slot, arm).map_err(err)
}

/// The fader on one of the bank's two output pairs — the room, or the
/// headphones. Bank state like the slot mix, so it rides in the deck
/// patch; coalesced per bus, so a drag is one undo step.
#[tauri::command]
pub fn decks_set_master(
    state: State<AppState>,
    instance: String,
    bus: MasterBus,
    value: f32,
) -> CmdResult<()> {
    let name = match bus {
        MasterBus::Live => "live",
        MasterBus::Monitor => "monitor",
    };
    let mut engine = patch_edit(&state, EditKey::DeckMaster(&instance, name))?;
    engine.decks_set_master(&instance, bus, value).map_err(err)
}

fn control_key(control: SlotControl) -> &'static str {
    match control {
        SlotControl::Level => "level",
        SlotControl::High => "high",
        SlotControl::Mid => "mid",
        SlotControl::Low => "low",
        SlotControl::Mute => "mute",
        SlotControl::Monitor => "monitor",
        SlotControl::Wet => "wet",
        SlotControl::InsertMonitor => "insert_monitor",
    }
}

#[tauri::command]
pub fn decks_set_tail(
    state: State<AppState>,
    instance: String,
    slot: usize,
    tail: u32,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::DeckSlot(&instance, slot))?;
    engine.decks_set_tail(&instance, slot, tail).map_err(err)
}

#[tauri::command]
pub fn decks_set_phase(
    state: State<AppState>,
    instance: String,
    slot: usize,
    phase: i32,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::DeckSlot(&instance, slot))?;
    engine.decks_set_phase(&instance, slot, phase).map_err(err)
}

/// The bank's tempo. It is the module's `bpm` knob, so this is an
/// ordinary knob edit and undo/redo already knows what to do with it.
#[tauri::command]
pub fn decks_set_bpm(state: State<AppState>, instance: String, bpm: f32) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::Knob(&instance, "bpm"))?;
    engine.set_knob_value(&instance, "bpm", bpm).map_err(err)
}

/// Whether this bank follows the Launch Control XL (a mode param, so it
/// rides in the patch).
#[tauri::command]
pub fn decks_set_surface(state: State<AppState>, instance: String, follow: bool) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::Param(&instance, SURFACE_PARAM))?;
    engine
        .set_param(&instance, SURFACE_PARAM, if follow { 1.0 } else { 0.0 })
        .map_err(err)
}

/// Park the bank on beat 0. Where the clock is is not saved state, so
/// this is not an undoable edit.
#[tauri::command]
pub fn decks_reset(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.decks_reset(&instance).map_err(err)
}

/// Assemble any slot still waiting for its audio. The page calls this
/// when it opens: a bank restored from the autosave at startup can find
/// its clips unassembled (the Beatify projects they name are read off
/// disk, and that can fail while the app is still coming up), and the
/// symptom is a deck that looks loaded and makes no sound. Assembling
/// again is free when nothing is pending.
#[tauri::command(async)]
pub fn decks_rehydrate(state: State<AppState>) -> CmdResult<usize> {
    let mut engine = engine_lock(&state)?;
    let pending = engine.decks_pending().len();
    if pending == 0 {
        return Ok(0);
    }
    hydrate(&state, &mut engine);
    Ok(pending - engine.decks_pending().len())
}

fn track_data(rendered: &RenderedClip) -> TrackData {
    TrackData {
        channels: rendered.audio.channels.clone(),
        sample_rate: rendered.audio.sample_rate as f32,
    }
}

/// Re-assemble every bank slot that knows which clip it plays but has no
/// audio behind it — after a patch load, or an undo/redo that recreated
/// the module. A clip whose project has been deleted leaves its slot
/// silent (and says so in the log): losing the source should cost the
/// sound, never the patch.
pub fn hydrate(state: &AppState, engine: &mut Engine) {
    for (instance, slot, clip) in engine.decks_pending() {
        match render_clip(state, &clip.project, &clip.clip) {
            Ok(rendered) => {
                let audio = track_data(&rendered);
                let bpm = rendered.bpm;
                // The display fields are re-read off the clip as it now
                // stands, like a Beat Clip's: a patch saved before clips
                // said what they hold carries no stems.
                let clip = BeatClipRef {
                    name: rendered.name.clone(),
                    project_name: rendered.project_name.clone(),
                    stems: rendered.stems.clone(),
                    ..clip
                };
                if let Err(e) = engine.decks_supply(&instance, slot, Some(clip), audio, bpm) {
                    eprintln!("[dj-audio] loading a clip into {instance} slot {slot}: {e:#}");
                }
            }
            Err(e) => eprintln!(
                "[dj-audio] {instance} slot {slot} plays clip {}/{}, which cannot be assembled: {e}",
                clip.project, clip.clip
            ),
        }
    }
}
