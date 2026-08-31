//! Decks tab IPC: the bank of eight clip slots the page draws, and the
//! beat clips that go in them.
//!
//! The tab is a big panel for ONE rack module (`builtin.decks`), so
//! everything here is an ordinary engine edit — the bank is in the patch
//! and it is wired into the graph. [`decks_ensure`] is the page's "give
//! me the decks" gesture: it finds the bank or makes one, and gives its
//! live and cue pairs somewhere to play, in one undo step.
//!
//! The patch keeps the BINDING (see [`crate::beat_clip`]) and the samples
//! are loaded here — when the user drops a clip into a slot, and again
//! after a patch load or an undo that brought the bank back
//! ([`hydrate`]). Loading decodes seconds of audio, so those commands are
//! `async`: a sync command runs on the main thread and would freeze the
//! window.

use dj_engine::beat_clip::BeatClipRef;
use dj_engine::decks::{
    DeckArm, DeckTransition, DecksStatus, MasterBus, SlotControl, DECKS_ID, SURFACE_PARAM,
};
use dj_engine::{Engine, Workspace};
use tauri::State;

use crate::beat_clip::render_clip;
use crate::{engine_lock, err, patch_edit, AppState, CmdResult, EditKey};

/// Whether a bank is a Decks V2 one — the two-arrangement bank its own
/// tab drives. The two tabs share the workspace but never a bank, so
/// both listing commands filter by this flag.
fn is_v2(engine: &Engine, instance: &str) -> bool {
    engine.decks_state(instance).map(|s| s.v2).unwrap_or(false)
}

/// Every CLASSIC Decks bank on the rack (usually one) — a V2 bank is the
/// other tab's and never listed here.
#[tauri::command]
pub fn decks_banks(state: State<AppState>) -> CmdResult<Vec<String>> {
    let engine = engine_lock(&state)?;
    Ok(engine
        .decks_nodes()
        .into_iter()
        .filter(|id| !is_v2(&engine, id))
        .collect())
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
        let first = engine
            .decks_nodes()
            .into_iter()
            .find(|id| !is_v2(&engine, id));
        match first {
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
            let instance = fresh_id(&engine, "decks");
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

fn fresh_id(engine: &Engine, stem: &str) -> String {
    let taken: std::collections::BTreeSet<&str> = engine
        .nodes
        .iter()
        .map(|n| n.instance_id.as_str())
        .collect();
    (1..)
        .map(|n| format!("{stem}{n}"))
        .find(|id| !taken.contains(id.as_str()))
        .unwrap()
}

/// Every V2 bank on the rack (usually one) — what the Decks V2 tab looks
/// for before it offers to make one.
#[tauri::command]
pub fn decks_v2_banks(state: State<AppState>) -> CmdResult<Vec<String>> {
    let engine = engine_lock(&state)?;
    Ok(engine
        .decks_nodes()
        .into_iter()
        .filter(|id| is_v2(&engine, id))
        .collect())
}

/// The bank the Decks V2 tab drives: the first V2 bank on the rack, or a
/// new one — same gesture as [`decks_ensure`], for the other tab. A fresh
/// V2 bank ignores the Launch Control XL (the page offers no surface) and
/// is wired to outputs like any bank; the two tabs share the decks
/// workspace but never a bank.
#[tauri::command]
pub fn decks_v2_ensure(state: State<AppState>) -> CmdResult<String> {
    let existing = {
        let engine = engine_lock(&state)?;
        let first = engine
            .decks_nodes()
            .into_iter()
            .find(|id| is_v2(&engine, id));
        match first {
            Some(first) => {
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
    let mut engine = patch_edit(&state, EditKey::Add("decks-v2"))?;
    let instance = match existing {
        Some(bank) => bank,
        None => {
            let instance = fresh_id(&engine, "decksv2_");
            engine.add_module(&instance, DECKS_ID).map_err(err)?;
            engine.decks_set_v2(&instance, true).map_err(err)?;
            engine
                .set_param(&instance, SURFACE_PARAM, 0.0)
                .map_err(err)?;
            instance
        }
    };
    engine
        .set_module_workspace(&instance, Workspace::Decks)
        .map_err(err)?;
    engine.decks_connect_outputs(&instance).map_err(err)?;
    Ok(instance)
}

/// Load a saved beat clip into a V2 row. Like [`decks_load`] it arrives
/// in the MONITOR arrangement (a new row never touches the room); with
/// `muted` it lands silent there too — the page adds a whole song's clips
/// that way, so eight rows landing at once make no noise anywhere.
#[tauri::command(async)]
pub fn decks_v2_load(
    state: State<AppState>,
    instance: String,
    slot: usize,
    clip_id: String,
    muted: bool,
) -> CmdResult<()> {
    // Load BEFORE taking the engine lock: this decodes seconds of audio.
    let rendered = render_clip(&state, &clip_id)?;
    let clip = BeatClipRef {
        project: crate::clip::BEAT_CLIPS_PROJECT.into(),
        clip: clip_id,
        name: rendered.name.clone(),
        project_name: rendered.project_name.clone(),
        stems: rendered.stems.clone(),
        ones: rendered.ones.clone(),
    };
    let mut engine = patch_edit(&state, EditKey::DeckSlot(&instance, slot))?;
    engine
        .decks_load(
            &instance,
            slot,
            Some(clip),
            rendered.clip_audio(),
            rendered.bpm,
        )
        .map_err(err)?;
    if muted {
        engine
            .decks_set_control(&instance, slot, SlotControl::Mute, 10.0)
            .map_err(err)?;
    }
    Ok(())
}

/// One of the LIVE side's controls on a V2 row — its own fader or mute
/// (the classic `decks_set_control` writes the monitor arrangement).
/// Coalesced per control, like the monitor side's.
#[tauri::command]
pub fn decks_v2_set_live_control(
    state: State<AppState>,
    instance: String,
    slot: usize,
    control: SlotControl,
    value: f32,
) -> CmdResult<()> {
    let name = match control {
        SlotControl::Level => "live_level",
        SlotControl::Mute => "live_mute",
        other => return Err(err(anyhow::anyhow!("not a live-side control: {other:?}"))),
    };
    let mut engine = patch_edit(&state, EditKey::DeckSlotControl(&instance, slot, name))?;
    engine
        .decks_set_live_control(&instance, slot, control, value)
        .map_err(err)
}

/// Shift the LIVE side of a V2 row along the bank's grid (the disarmed
/// live grid's own shift control).
#[tauri::command]
pub fn decks_v2_set_live_phase(
    state: State<AppState>,
    instance: String,
    slot: usize,
    phase: i32,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::DeckSlot(&instance, slot))?;
    engine
        .decks_set_live_phase(&instance, slot, phase)
        .map_err(err)
}

/// Arm (or cancel) a jump/crossfade on a V2 bank. Transport, like a
/// deck's queue/drop: the bank's clock fires it on the cycle seam, and
/// nothing here is an undoable edit.
#[tauri::command]
pub fn decks_v2_transition(
    state: State<AppState>,
    instance: String,
    mode: DeckTransition,
) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.decks_transition(&instance, mode).map_err(err)
}

/// Finish a fired transition: copy the monitor arrangement into the live
/// side (`Engine::decks_transition_commit`). The page calls this when its
/// poll sees `transition_done`; inaudible, one undo step, and idempotent
/// — a second poll finds nothing owed and edits nothing.
#[tauri::command]
pub fn decks_v2_commit(state: State<AppState>, instance: String) -> CmdResult<bool> {
    // Nothing owed is nothing to edit (and no undo step): peek first.
    if !engine_lock(&state)?
        .decks_status(&instance)
        .map_err(err)?
        .transition_done
    {
        return Ok(false);
    }
    let mut engine = patch_edit(&state, EditKey::DeckCommit(&instance))?;
    engine.decks_transition_commit(&instance).map_err(err)
}

#[tauri::command]
pub fn decks_status(state: State<AppState>, instance: String) -> CmdResult<DecksStatus> {
    let engine = engine_lock(&state)?;
    engine.decks_status(&instance).map_err(err)
}

/// Load a saved beat clip into a slot. It arrives cued to the monitor —
/// unmuted, out of the live mix — on the bank's grid and with the deck
/// put back the way an empty one starts: the mix, the shift, the silence
/// and the ratio belonged to the clip that just left (`Engine::decks_load`),
/// and so did the cables at the deck's own jacks
/// (`Engine::decks_unplug_slot` — the insert was built for that clip).
#[tauri::command(async)]
pub fn decks_load(
    state: State<AppState>,
    instance: String,
    slot: usize,
    clip_id: String,
) -> CmdResult<()> {
    // Load BEFORE taking the engine lock: this decodes seconds of audio.
    let rendered = render_clip(&state, &clip_id)?;
    let clip = BeatClipRef {
        project: crate::clip::BEAT_CLIPS_PROJECT.into(),
        clip: clip_id,
        name: rendered.name.clone(),
        project_name: rendered.project_name.clone(),
        stems: rendered.stems.clone(),
        ones: rendered.ones.clone(),
    };
    let mut engine = patch_edit(&state, EditKey::DeckSlot(&instance, slot))?;
    engine.decks_unplug_slot(&instance, slot).map_err(err)?;
    engine
        .decks_load(
            &instance,
            slot,
            Some(clip),
            rendered.clip_audio(),
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

/// Run a deck at a ratio of the bank's grid — the strip's BPM label. It
/// moves the deck's baseline tempo (`Engine::decks_set_ratio`), so it is
/// grid state like the tail and the shift and rides in the patch beside
/// them.
#[tauri::command]
pub fn decks_set_ratio(
    state: State<AppState>,
    instance: String,
    slot: usize,
    ratio: f32,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::DeckSlot(&instance, slot))?;
    engine.decks_set_ratio(&instance, slot, ratio).map_err(err)
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

/// Start or stop the bank's clock — the page's transport. A bank is
/// created and restored stopped, so opening the tab makes no noise on its
/// own; stopping parks it back on beat 0. Where the clock is is not saved
/// state, so this is not an undoable edit.
#[tauri::command]
pub fn decks_set_running(state: State<AppState>, instance: String, running: bool) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.decks_set_running(&instance, running).map_err(err)
}

/// Load any slot still waiting for its audio. The page calls this when it
/// opens: a bank restored from the autosave at startup can find its clips
/// unloaded (the store is read off disk, and that can fail while the app
/// is still coming up), and the symptom is a deck that looks loaded and
/// makes no sound. Asking again is free when nothing is pending.
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

/// Re-load every bank slot that knows which clip it plays but has no
/// audio behind it — after a patch load, or an undo/redo that recreated
/// the module. A clip that has been deleted leaves its slot silent (and
/// says so in the log): losing the source should cost the sound, never
/// the patch.
pub fn hydrate(state: &AppState, engine: &mut Engine) {
    for (instance, slot, clip) in engine.decks_pending() {
        match render_clip(state, &clip.clip) {
            Ok(rendered) => {
                let audio = rendered.clip_audio();
                let bpm = rendered.bpm;
                // What the clip SAYS is re-read off it as it now stands,
                // like a Beat Clip's: a patch saved before clips said what
                // they hold carries no stems, and a clip revised in the
                // Clip page brings its new ones with it. The slot's SHIFT
                // is not touched — this is the audio arriving late, not a
                // new load, so the deck stays lined up where it was.
                let clip = BeatClipRef {
                    name: rendered.name.clone(),
                    project_name: rendered.project_name.clone(),
                    stems: rendered.stems.clone(),
                    ones: rendered.ones.clone(),
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
