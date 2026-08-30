// dj-station Tauri shell: hosts the Rust engine and exposes it to the React
// frontend over IPC. The engine itself lives in crates/dj-engine and is fully
// usable without this shell (see crates/dj-cli for the headless harness).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod beat_clip;
mod beatify;
mod beatify_clip;
mod clip;
mod decks;
mod launch_control;

use dj_engine::{
    AudioFocus, AudioOutputs, Backend, CaptureWindow, Engine, EngineConfig, ExtensionRegistry,
    JackTelemetry, KnobConfig, KnobStyle, MacroDef, MacroInterface, MacroJack, MacroLibrary,
    MacroStore, Manifest, MidiMapKind, PatchDoc, UndoHistory, WireStyle, Workspace,
    MACROS_DIR_NAME,
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
    hub: Arc<AcquisitionHub>,
    /// Provider downloads in flight (off the main thread, progress polled
    /// by the library view).
    downloads: dj_library::DownloadManager,
    /// Name of the rack-workspace patch currently being edited (used by
    /// save/autosave; the autosave header carries it across restarts).
    patch_name: Mutex<String>,
    /// Name of the decks-workspace patch currently being edited (the
    /// autosave dir carries it in a sidecar — one header, two names).
    deck_patch_name: Mutex<String>,
    /// Last autosaved document, to skip disk writes when nothing changed.
    last_autosave: Mutex<Option<PatchDoc>>,
    /// Per-workspace snapshot at the last save/load/new — the clean
    /// baseline `patch_dirty` compares against so destructive actions
    /// (New Patch, Open) can prompt to save or discard first. Rack and
    /// decks baselines are independent: an edit on one tab never makes
    /// the OTHER tab's patch dirty. Indexed by [`ws_index`].
    last_saved: Mutex<[Option<PatchDoc>; 2]>,
    /// Watch-folder scanner; kept alive for the app's lifetime.
    _watcher: dj_library::WatchHandle,
    /// Background analysis worker (M3): drains the library queue so
    /// BPM/key/beatgrid/stems land in the DB with no user action.
    analysis: dj_analysis::AnalysisWorker,
    /// Decoded sources for the Clip page's offline editor.
    clips: clip::ClipCache,
    /// Stem separation (PRD §8.2): htdemucs_ft via the external demucs
    /// CLI, one background thread per job.
    stems: Arc<dj_analysis::StemJobs>,
    /// Keeps the stem cache filled by itself — every downloaded track,
    /// history included — so the Clip page never has to ask for one.
    auto_stems: dj_analysis::AutoStemService,
    /// The Beatify tab's in-flight analysis (ephemeral until Save).
    beatify: beatify::BeatifySession,
}

/// Named patches live under the single data dir (PRD §3) — `custom/` in
/// the repo checkout unless `DJ_STATION_DATA_DIR` overrides it.
fn patches_dir() -> PathBuf {
    dj_library::default_data_dir().join("patches")
}

/// Deck patches (the Decks tab's workspace: bank + its rack) get their
/// own folder, a sibling of `patches/` — the two tabs are two different
/// racks and their saves never mix.
fn deck_patches_dir() -> PathBuf {
    dj_library::default_data_dir().join("deck_patches")
}

/// Where a workspace's named patches live.
fn workspace_patches_dir(ws: Workspace) -> PathBuf {
    match ws {
        Workspace::Rack => patches_dir(),
        Workspace::Decks => deck_patches_dir(),
    }
}

/// Parse a command's optional `workspace` argument. Absent means the Rack
/// tab's workspace — every pre-workspace caller keeps its behavior.
fn ws_arg(workspace: Option<&str>) -> CmdResult<Workspace> {
    match workspace {
        None | Some("rack") => Ok(Workspace::Rack),
        Some("decks") => Ok(Workspace::Decks),
        Some(other) => Err(CmdError::invalid(format!("unknown workspace {other:?}"))),
    }
}

fn other_workspace(ws: Workspace) -> Workspace {
    match ws {
        Workspace::Rack => Workspace::Decks,
        Workspace::Decks => Workspace::Rack,
    }
}

/// One workspace of the engine as a standalone patch document, tags
/// normalized away: what its Save writes and what its dirty-check
/// compares. A patch FILE is workspace-neutral — which rack it loads
/// into is the folder it lives in.
fn workspace_doc(engine: &Engine, ws: Workspace, name: &str) -> PatchDoc {
    let mut doc = engine.snapshot(name);
    doc.retain_workspace(ws);
    doc.strip_workspaces();
    doc
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
        Ok(()) => {
            // The autosave header names the RACK patch; the deck patch
            // name rides in a sidecar so a restart can restore both.
            if let Ok(deck_name) = state.deck_patch_name.lock() {
                let _ = std::fs::write(autosave_dir().join("deck_name.txt"), deck_name.as_str());
            }
            *last = Some(doc);
        }
        Err(e) => eprintln!("[dj-audio] autosave failed: {e:#}"),
    }
}

/// Undo-history key for a patch edit. The `Display` output is the
/// coalescing key (rapid same-key edits merge into one undo step, e.g. a
/// knob drag), so the exact strings must stay stable.
enum EditKey<'a> {
    Add(&'a str),
    Remove(&'a str),
    Rename(&'a str),
    WireAdd(&'a str, &'a str, &'a str, &'a str),
    WireRemove(&'a str, &'a str, &'a str, &'a str),
    MidiAdd(&'a str, &'a str),
    MidiRemove(&'a str, &'a str),
    LedAdd(&'a str, &'a str),
    LedRemove(&'a str, &'a str),
    ChoreoBeats(&'a str),
    ChoreoTrackAdd(&'a str, &'a str),
    ChoreoTrackRemove(&'a str, usize),
    ChoreoTrackRename(&'a str, usize),
    ChoreoTrackMove(&'a str),
    ChoreoTrackSettings(&'a str, usize),
    /// Cell/value edits coalesce per track (drag paints stream updates).
    ChoreoData(&'a str, usize),
    /// A Math module's expression; keyed per instance so a burst of
    /// typing collapses into one undo step.
    MathExpr(&'a str),
    Knob(&'a str, &'a str),
    KnobConfig(&'a str, &'a str),
    KnobReset(&'a str, &'a str),
    AttenOffset(&'a str, &'a str),
    WireStyle(&'a str, &'a str),
    ModuleReset(&'a str),
    ModuleResetMany,
    /// A built-in preset recalled from a module's right-click menu.
    Preset(&'a str, &'a str),
    /// A completed module-drag gesture ([`move_modules`] ends the gesture
    /// itself, so every drag is exactly one undo step).
    Move,
    Param(&'a str, &'a str),
    Bypass(&'a str),
    Load(&'a str),
    NewPatch,
    Paste,
    RemoveMany,
    CollapseMacro,
    BreakMacro(&'a str),
    PullMacro(&'a str),
    ResetMacro(&'a str),
    Track(&'a str),
    /// A Decks slot's clip, silence tail or phase shift.
    DeckSlot(&'a str, usize),
    /// One control of a Decks slot; coalesced per control so a fader drag
    /// is one undo step.
    DeckSlotControl(&'a str, usize, &'static str),
    /// The fader on one of a bank's two output pairs, per bus.
    DeckMaster(&'a str, &'static str),
}

impl std::fmt::Display for EditKey<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EditKey::Add(i) => write!(f, "add:{i}"),
            EditKey::Remove(i) => write!(f, "remove:{i}"),
            EditKey::Rename(i) => write!(f, "rename:{i}"),
            EditKey::WireAdd(fi, fj, ti, tj) => write!(f, "wire+:{fi}:{fj}->{ti}:{tj}"),
            EditKey::WireRemove(fi, fj, ti, tj) => write!(f, "wire-:{fi}:{fj}->{ti}:{tj}"),
            EditKey::MidiAdd(i, n) => write!(f, "midi+:{i}:{n}"),
            EditKey::MidiRemove(i, n) => write!(f, "midi-:{i}:{n}"),
            EditKey::LedAdd(i, n) => write!(f, "led+:{i}:{n}"),
            EditKey::LedRemove(i, n) => write!(f, "led-:{i}:{n}"),
            EditKey::ChoreoBeats(i) => write!(f, "choreo-beats:{i}"),
            EditKey::ChoreoTrackAdd(i, n) => write!(f, "choreo-track+:{i}:{n}"),
            EditKey::ChoreoTrackRemove(i, t) => write!(f, "choreo-track-:{i}:{t}"),
            EditKey::ChoreoTrackRename(i, t) => write!(f, "choreo-rename:{i}:{t}"),
            EditKey::ChoreoTrackMove(i) => write!(f, "choreo-move:{i}"),
            EditKey::ChoreoTrackSettings(i, t) => write!(f, "choreo-settings:{i}:{t}"),
            EditKey::ChoreoData(i, t) => write!(f, "choreo-data:{i}:{t}"),
            EditKey::MathExpr(i) => write!(f, "math-expr:{i}"),
            EditKey::Knob(i, j) => write!(f, "knob:{i}:{j}"),
            EditKey::KnobConfig(i, j) => write!(f, "knobcfg:{i}:{j}"),
            EditKey::KnobReset(i, j) => write!(f, "knobreset:{i}:{j}"),
            EditKey::AttenOffset(i, j) => write!(f, "attoff:{i}:{j}"),
            EditKey::WireStyle(i, j) => write!(f, "wirestyle:{i}:{j}"),
            EditKey::ModuleReset(i) => write!(f, "modreset:{i}"),
            EditKey::ModuleResetMany => write!(f, "modreset_many"),
            EditKey::Preset(i, p) => write!(f, "preset:{i}:{p}"),
            EditKey::Move => write!(f, "move"),
            EditKey::Param(i, p) => write!(f, "param:{i}:{p}"),
            EditKey::Bypass(i) => write!(f, "bypass:{i}"),
            EditKey::Load(d) => write!(f, "load:{d}"),
            EditKey::NewPatch => write!(f, "new_patch"),
            EditKey::Paste => write!(f, "paste"),
            EditKey::RemoveMany => write!(f, "remove_many"),
            EditKey::CollapseMacro => write!(f, "collapse_macro"),
            EditKey::BreakMacro(i) => write!(f, "break_macro:{i}"),
            EditKey::PullMacro(i) => write!(f, "pull_macro:{i}"),
            EditKey::ResetMacro(i) => write!(f, "reset_macro:{i}"),
            EditKey::Track(i) => write!(f, "track:{i}"),
            EditKey::DeckSlot(i, s) => write!(f, "deckslot:{i}:{s}"),
            EditKey::DeckSlotControl(i, s, c) => write!(f, "deckctl:{i}:{s}:{c}"),
            EditKey::DeckMaster(i, b) => write!(f, "deckmaster:{i}:{b}"),
        }
    }
}

/// Record the pre-edit snapshot for an undoable edit. Failures to lock the
/// history never block the edit itself.
fn record_edit(state: &State<AppState>, engine: &Engine, key: &EditKey) {
    if let Ok(mut history) = state.history.lock() {
        history.record(&key.to_string(), engine.snapshot("undo"));
    }
}

/// `last_saved` slot for a workspace. Baselines use a fixed snapshot name
/// so the dirty comparison ignores patch renames, and a failure to lock is
/// never allowed to block the save/load/new itself.
fn ws_index(ws: Workspace) -> usize {
    match ws {
        Workspace::Rack => 0,
        Workspace::Decks => 1,
    }
}

/// Record ONE workspace's clean baseline (its save/load/new just landed).
fn mark_saved_ws(state: &State<AppState>, engine: &Engine, ws: Workspace) {
    if let Ok(mut last) = state.last_saved.lock() {
        last[ws_index(ws)] = Some(workspace_doc(engine, ws, "baseline"));
    }
}

/// Record both baselines (a whole-engine load/new just landed).
fn mark_saved(state: &State<AppState>, engine: &Engine) {
    mark_saved_ws(state, engine, Workspace::Rack);
    mark_saved_ws(state, engine, Workspace::Decks);
}

/// True when a workspace's patch differs from its last saved/loaded/new
/// state, i.e. a destructive action (New Patch, Open) would lose work.
/// Each tab asks about ITS OWN workspace — an edit on the other tab never
/// dirties this one. Rack layout is ignored: positions are UI passthrough
/// kept in the local layout store too (and captured by autosave), so a
/// mere rearrange — or the engine lazily adopting frontend positions via
/// `sync_positions` — must not trigger save prompts.
#[tauri::command]
fn patch_dirty(state: State<AppState>, workspace: Option<String>) -> CmdResult<bool> {
    let ws = ws_arg(workspace.as_deref())?;
    let engine = engine_lock(&state)?;
    let last = state.last_saved.lock().map_err(err)?;
    let Some(last) = last[ws_index(ws)].as_ref() else {
        return Ok(true);
    };
    let mut current = workspace_doc(&engine, ws, "baseline");
    current.layout = last.layout.clone();
    Ok(*last != current)
}

/// Lock the engine with NO undo snapshot: queries, telemetry taps, backend
/// start/stop, and DJ performance controls whose state is canonical in the
/// library DB rather than the patch. A command that mutates the patch must
/// use [`patch_edit`] instead so the edit lands in undo history.
fn engine_lock<'a>(state: &'a State<AppState>) -> CmdResult<std::sync::MutexGuard<'a, Engine>> {
    state.engine.lock().map_err(err)
}

/// Lock the engine for a patch-mutating edit, recording the pre-edit
/// snapshot under `key` so the edit is undoable.
fn patch_edit<'a>(
    state: &'a State<AppState>,
    key: EditKey,
) -> CmdResult<std::sync::MutexGuard<'a, Engine>> {
    let engine = engine_lock(state)?;
    record_edit(state, &engine, &key);
    Ok(engine)
}

/// Morph the live engine to a snapshot (undo/redo), preserving the running
/// backend. `apply_doc` diffs instead of rebuilding, so modules untouched
/// by the edit keep their DSP state AND telemetry — nothing visibly resets.
fn restore_doc(state: &State<AppState>, engine: &mut Engine, doc: &PatchDoc) -> CmdResult<()> {
    let recreated = engine.apply_doc(doc).map_err(err)?;
    // Deck metadata (grids/cues/loops) is canonical in the library DB;
    // re-apply it to decks apply_doc had to recreate.
    for instance in recreated {
        if engine
            .nodes
            .iter()
            .any(|n| n.instance_id == instance && n.is_deck())
        {
            apply_deck_metadata(state, engine, &instance)?;
        }
    }
    // Beat Clip modules and Decks slots apply_doc recreated hold a
    // binding but no audio.
    beat_clip::hydrate(state, engine);
    decks::hydrate(state, engine);
    Ok(())
}

/// Restart the backend that was running before a stop/mutate cycle. A cpal
/// failure downgrades to the null backend (with a warning) instead of
/// erroring: audio dying beats the whole edit failing.
fn restart_backend(engine: &mut Engine, backend: Option<Backend>, what: &str) -> CmdResult<()> {
    match backend {
        Some(Backend::Cpal) => {
            if let Err(e) = engine.start_cpal() {
                // A downgrade here means audio dies after the edit even
                // though the UI still shows "engine connected".
                eprintln!(
                    "[dj-audio] WARNING: cpal restart after {what} failed ({e}); \
                     falling back to the silent null backend"
                );
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
    let mut engine = engine_lock(&state)?;
    let doc = {
        let mut history = state.history.lock().map_err(err)?;
        history.undo(engine.snapshot("undo"))
    };
    match doc {
        Some(doc) => restore_doc(&state, &mut engine, &doc).map(|()| true),
        None => Ok(false),
    }
}

/// Remove a module and all wires touching it (undoable). Incremental: no
/// other module's state, telemetry or wiring is touched.
#[tauri::command]
fn remove_module(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::Remove(&instance))?;
    engine
        .remove_module(&instance)
        .map_err(|e| CmdError::not_found(e.to_string()))
}

/// Rename a module (undoable). The typed name keeps caps/spaces for
/// display; its normalized form becomes the new instance id, which is
/// returned. Rejected without side effects (InvalidInput) when the
/// normalized name is empty or collides with another module — the history
/// is recorded only on success so a rejected rename never adds a no-op
/// undo step.
#[tauri::command]
fn rename_module(state: State<AppState>, instance: String, name: String) -> CmdResult<String> {
    let mut engine = engine_lock(&state)?;
    let pre = engine.snapshot("undo");
    let new_id = engine
        .rename_module(&instance, &name)
        .map_err(|e| CmdError::invalid(e.to_string()))?;
    if let Ok(mut history) = state.history.lock() {
        history.record(&EditKey::Rename(&instance).to_string(), pre);
    }
    Ok(new_id)
}

/// Mark the end of an edit gesture (pointer-up after a knob/segment drag)
/// so the next edit of the same control is a separate undo step.
#[tauri::command]
fn end_edit(state: State<AppState>) -> CmdResult<()> {
    state.history.lock().map_err(err)?.end_gesture();
    Ok(())
}

/// One module's move within a drag gesture: where it started and where it
/// ended (unzoomed rack coordinates).
#[derive(serde::Deserialize)]
struct ModuleMove {
    instance: String,
    from: (f32, f32),
    to: (f32, f32),
}

/// Commit a completed drag gesture (undoable): the frontend batches every
/// module the gesture displaced — group/macro members, co-operative bumps —
/// into ONE call at pointer-up, so a whole drag is exactly one undo step.
/// Modules the engine has no position for yet are seeded with the gesture's
/// start position BEFORE the undo snapshot, so undo restores them there.
#[tauri::command]
fn move_modules(state: State<AppState>, moves: Vec<ModuleMove>) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    for m in &moves {
        if engine.module_position(&m.instance).is_none() {
            engine
                .set_module_position(&m.instance, m.from)
                .map_err(|e| CmdError::not_found(e.to_string()))?;
        }
    }
    record_edit(&state, &engine, &EditKey::Move);
    for m in &moves {
        engine
            .set_module_position(&m.instance, m.to)
            .map_err(|e| CmdError::not_found(e.to_string()))?;
    }
    // The gesture is complete: the next drag is its own undo step.
    if let Ok(mut history) = state.history.lock() {
        history.end_gesture();
    }
    Ok(())
}

/// Adopt frontend-computed rack positions WITHOUT an undo step: layout
/// seeding before a delete (so undoing the delete puts modules back) and
/// post-render placement fixups. Unknown ids (stale local layout entries)
/// are skipped, not errors.
#[tauri::command]
fn sync_positions(
    state: State<AppState>,
    positions: BTreeMap<String, (f32, f32)>,
) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    for (instance, pos) in &positions {
        let _ = engine.set_module_position(instance, *pos);
    }
    Ok(())
}

/// Redo the last undone edit. Returns false when there is nothing to redo.
#[tauri::command]
fn redo(state: State<AppState>) -> CmdResult<bool> {
    let mut engine = engine_lock(&state)?;
    let doc = {
        let mut history = state.history.lock().map_err(err)?;
        history.redo(engine.snapshot("undo"))
    };
    match doc {
        Some(doc) => restore_doc(&state, &mut engine, &doc).map(|()| true),
        None => Ok(false),
    }
}

pub(crate) type CmdResult<T> = Result<T, CmdError>;

/// Structured IPC error. `kind` is machine-readable so the frontend can
/// react programmatically (suppress, restyle, retry); `message` is the
/// human-readable detail for the error banner.
#[derive(Clone, Serialize)]
pub(crate) struct CmdError {
    kind: ErrorKind,
    message: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ErrorKind {
    /// The request referenced something that no longer exists — often a
    /// benign race against undo/reload; polling callers can ignore it.
    NotFound,
    /// The caller sent something unusable (bad patch name, empty
    /// selection); fix the input and retry.
    InvalidInput,
    /// Everything else: engine faults, IO, poisoned locks. Engine errors
    /// stay here until the engine crate grows typed errors — do NOT
    /// classify by sniffing message strings.
    Internal,
}

impl ErrorKind {
    fn tag(self) -> &'static str {
        match self {
            ErrorKind::NotFound => "not_found",
            ErrorKind::InvalidInput => "invalid_input",
            ErrorKind::Internal => "internal",
        }
    }
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl CmdError {
    /// The one place a command failure is born, so it is also the one place
    /// it gets logged: everything the frontend banner shows must leave a
    /// trail in the terminal too (a bug report rarely carries both).
    fn new(kind: ErrorKind, message: String) -> Self {
        log_cmd_error(kind, &message);
        CmdError { kind, message }
    }

    fn not_found(message: impl Into<String>) -> Self {
        CmdError::new(ErrorKind::NotFound, message.into())
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        CmdError::new(ErrorKind::InvalidInput, message.into())
    }
}

/// Consecutive identical failures collapse, exactly like the frontend banner
/// does: polled commands (`tap`, `*_status`) fail every tick while they race
/// a live edit, and 10 lines a second would bury everything else.
fn log_cmd_error(kind: ErrorKind, message: &str) {
    static LAST: Mutex<String> = Mutex::new(String::new());
    let line = format!("[dj-ipc] {}: {message}", kind.tag());
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if *last == line {
        return;
    }
    eprintln!("{line}");
    *last = line;
}

/// Default conversion for `map_err(err)`: kind `internal`.
pub(crate) fn err<E: std::fmt::Display>(e: E) -> CmdError {
    CmdError::new(ErrorKind::Internal, e.to_string())
}

#[derive(Serialize)]
struct KnobSnapshot {
    position: f32,
    atten: f32,
    offset: f32,
    wire_style: WireStyle,
    config: Option<KnobConfig>,
}

#[derive(Serialize)]
struct WireSnapshot {
    from_instance: String,
    from_jack: String,
    to_instance: String,
    to_jack: String,
}

/// Wrap an edit that genuinely needs a stopped engine (whole-engine swaps
/// like New Patch, or macro collapse/update rebuilds) in
/// stop -> edit -> restart-same-backend (the cpal backend hands the graph
/// back on stop, so audio resumes with the edit applied). Ordinary
/// structural edits (module add/remove, wires) no longer need this: the
/// engine applies them live at a block boundary.
fn with_stopped<T>(
    engine: &mut Engine,
    f: impl FnOnce(&mut Engine) -> CmdResult<T>,
) -> CmdResult<T> {
    let backend = engine.backend();
    if backend.is_some() {
        engine.stop().map_err(err)?;
    }
    let result = f(engine);
    restart_backend(engine, backend, "graph edit")?;
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
    /// User-typed display name; `None` displays as the instance id.
    display_name: Option<String>,
    type_id: String,
    manifest: Manifest,
    knobs: BTreeMap<String, KnobSnapshot>,
    params: BTreeMap<String, f32>,
    wired_inputs: Vec<String>,
    midi_mappings: Vec<MidiMappingSnapshot>,
    /// LED feedback mappings (M4, PRD §7.1); each is also an input jack.
    midi_led_mappings: Vec<MidiMappingSnapshot>,
    /// Module bypassed: its manifest's `bypass` routes carry input to
    /// output and its DSP is skipped. Whether the toggle exists at all is
    /// the manifest's `bypass` map, which rides in `manifest`.
    bypassed: bool,
    /// Engine-known rack position (unzoomed rack coordinates). The
    /// frontend adopts it on refresh — this is how undo/redo moves panels
    /// back. `None` = engine has no opinion; the local layout store wins.
    position: Option<(f32, f32)>,
    /// Which rack workspace ("rack" or "decks") the module lives in: each
    /// tab renders only its own.
    workspace: Workspace,
}

#[tauri::command]
fn list_extensions(state: State<AppState>) -> CmdResult<Vec<Manifest>> {
    let engine = engine_lock(&state)?;
    Ok(engine
        .registry
        .extensions
        .values()
        .map(|e| e.manifest.clone())
        .collect())
}

#[tauri::command]
fn engine_nodes(state: State<AppState>) -> CmdResult<Vec<NodeSnapshot>> {
    let engine = engine_lock(&state)?;
    // Fully expanded view: macro internals render as ordinary panels (the
    // macro grouping travels separately via `macro_groups`), so wired
    // inputs come from the raw wire list, not the macro-collapsed patch
    // snapshot.
    let mut wired: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for w in engine.wire_specs() {
        let to = engine.nodes[w.to_node].instance_id.clone();
        let jack = engine.input_jack_name(w.to_node, w.to_jack);
        wired.entry(to).or_default().push(jack);
    }
    let out: Vec<NodeSnapshot> = engine
        .nodes
        .iter()
        .map(|n| NodeSnapshot {
            instance_id: n.instance_id.clone(),
            display_name: n.display_name.clone(),
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
                            display: None,
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
                            audio: false,
                            capture: false,
                            knob: None,
                            display: None,
                        })
                        .collect();
                }
                // Choreography output jacks are dynamic: one (or two, for
                // note tracks) per track, in track display order. Ids are
                // the stable `t<slot>` names so wires survive renames.
                if let Some(c) = &n.choreo {
                    m.outputs = c
                        .tracks
                        .iter()
                        .flat_map(|t| {
                            let mut outs = vec![dj_engine::manifest::OutputDecl {
                                id: format!("t{}", t.jack),
                                name: t.name.clone(),
                                display: None,
                            }];
                            if t.data.jack_count() == 2 {
                                outs.push(dj_engine::manifest::OutputDecl {
                                    id: format!("t{}", t.jack + 1),
                                    name: format!("{} vel", t.name),
                                    display: None,
                                });
                            }
                            outs
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
                            wire_style: k.wire_style,
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
            bypassed: n.bypassed,
            position: n.position,
            workspace: n.workspace,
        })
        .collect();
    Ok(out)
}

/// All module types that can be added to the rack (built-ins + extensions
/// + user-library macros, PRD §6).
#[tauri::command]
fn list_modules(state: State<AppState>) -> CmdResult<Vec<Manifest>> {
    let engine = engine_lock(&state)?;
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
    let engine = engine_lock(&state)?;
    // Raw, fully expanded wires: with macro internals rendered as real
    // panels, every wire (including macro-internal ones) draws between the
    // concrete nodes it actually connects.
    Ok(engine
        .wire_specs()
        .iter()
        .map(|w| WireSnapshot {
            from_instance: engine.nodes[w.from_node].instance_id.clone(),
            from_jack: engine.output_jack_name(w.from_node, w.from_jack),
            to_instance: engine.nodes[w.to_node].instance_id.clone(),
            to_jack: engine.input_jack_name(w.to_node, w.to_jack),
        })
        .collect())
}

#[derive(Serialize)]
struct MacroGroup {
    /// Top-level macro instance id (the UI's bounding-box label anchor).
    instance: String,
    macro_id: String,
    name: String,
    /// Concrete engine nodes expanded under this instance (nested macros
    /// flattened) — the members of the bounding box.
    members: Vec<String>,
}

/// Macro instance groupings for the rack's bounding-box overlay. Only
/// top-level instances are reported; nested macros are part of their
/// owner's box.
#[tauri::command]
fn macro_groups(state: State<AppState>) -> CmdResult<Vec<MacroGroup>> {
    let engine = engine_lock(&state)?;
    Ok(engine
        .macro_instances()
        .iter()
        .filter(|(iid, _)| !iid.contains('/'))
        .map(|(iid, mi)| {
            let prefix = format!("{iid}/");
            MacroGroup {
                instance: iid.clone(),
                macro_id: mi.macro_id.clone(),
                name: engine
                    .macros
                    .get(&mi.macro_id)
                    .map(|d| d.name.clone())
                    .unwrap_or_else(|| mi.macro_id.clone()),
                members: engine
                    .nodes
                    .iter()
                    .filter(|n| n.instance_id.starts_with(&prefix))
                    .map(|n| n.instance_id.clone())
                    .collect(),
            }
        })
        .collect())
}

/// Right-click "Break Macro": the instance's expanded internal modules
/// become ordinary top-level modules in place (wires, DSP state and
/// positions survive); the macro definition stays in the library. Returns
/// old id -> new id so the frontend can remap positions.
#[tauri::command]
fn break_macro(state: State<AppState>, instance: String) -> CmdResult<BTreeMap<String, String>> {
    let mut engine = patch_edit(&state, EditKey::BreakMacro(&instance))?;
    engine.break_macro(&instance).map_err(err)
}

/// Saved definition layout for a macro: relative rack positions for the
/// concrete nodes a fresh instance expands to (empty for macros saved
/// before positions were recorded).
#[tauri::command]
fn macro_layout(
    state: State<AppState>,
    macro_id: String,
) -> CmdResult<BTreeMap<String, (f32, f32)>> {
    let engine = engine_lock(&state)?;
    engine.macro_layout(&macro_id).map_err(err)
}

/// What a fresh instance of a macro expands to, for the module picker's
/// composite thumbnail: concrete internal nodes with their manifests,
/// definition-saved knobs and relative positions.
#[tauri::command]
fn macro_preview(
    state: State<AppState>,
    macro_id: String,
) -> CmdResult<Vec<dj_engine::MacroPreviewNode>> {
    let engine = engine_lock(&state)?;
    engine.macro_preview(&macro_id).map_err(err)
}

#[tauri::command]
fn add_module(
    state: State<AppState>,
    instance: String,
    type_id: String,
    workspace: Option<String>,
) -> CmdResult<()> {
    let ws = ws_arg(workspace.as_deref())?;
    let mut engine = patch_edit(&state, EditKey::Add(&instance))?;
    engine.add_module(&instance, &type_id).map_err(err)?;
    // The module lands in the workspace of the tab that added it (macro
    // members follow their instance).
    engine.set_module_workspace(&instance, ws).map_err(err)
}

#[tauri::command]
fn connect_wire(
    state: State<AppState>,
    from_instance: String,
    from_jack: String,
    to_instance: String,
    to_jack: String,
) -> CmdResult<()> {
    let mut engine = patch_edit(
        &state,
        EditKey::WireAdd(&from_instance, &from_jack, &to_instance, &to_jack),
    )?;
    engine
        .connect(&from_instance, &from_jack, &to_instance, &to_jack)
        .map_err(err)?;
    // First-wire auto blend mode (pitch pair => Override, else CV);
    // same undo step as the connect. See the engine method's docs.
    engine
        .auto_wire_style_on_connect(&from_instance, &from_jack, &to_instance, &to_jack)
        .map_err(err)
}

#[tauri::command]
fn set_knob_wire_style(
    state: State<AppState>,
    instance: String,
    jack: String,
    style: String,
) -> CmdResult<()> {
    let style = match style.as_str() {
        "cv" => WireStyle::Cv,
        "override" => WireStyle::Override,
        other => return Err(err(format!("unknown wire style {other:?}"))),
    };
    let mut engine = patch_edit(&state, EditKey::WireStyle(&instance, &jack))?;
    engine
        .set_knob_wire_style(&instance, &jack, style)
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
    let mut engine = patch_edit(
        &state,
        EditKey::WireRemove(&from_instance, &from_jack, &to_instance, &to_jack),
    )?;
    engine
        .disconnect(&from_instance, &from_jack, &to_instance, &to_jack)
        .map_err(err)?;
    // Legacy patches from before wired-input blending saved an automatic
    // wire-style override; undo it so the knob comes back (only when it
    // is still set to wire — respect manual choices).
    if let Ok(k) = engine.knob_state(&to_instance, &to_jack) {
        if k.config
            .as_ref()
            .is_some_and(|c| c.style == KnobStyle::Wire)
        {
            engine
                .set_knob_config(&to_instance, &to_jack, None)
                .map_err(err)?;
        }
    }
    Ok(())
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
    let mut engine = patch_edit(&state, EditKey::MidiAdd(&instance, &name))?;
    engine
        .add_midi_mapping(&instance, kind, num, &name)
        .map(|_| ())
        .map_err(err)
}

/// Remove a MIDI mapping. Any wires from its jack are disconnected first
/// (restoring auto wire-style knobs), which needs the engine stopped.
#[tauri::command]
fn remove_midi_mapping(state: State<AppState>, instance: String, name: String) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::MidiRemove(&instance, &name))?;
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
    for (to_instance, to_jack) in &doomed {
        engine
            .disconnect(&instance, &name, to_instance, to_jack)
            .map_err(err)?;
        if let Ok(k) = engine.knob_state(to_instance, to_jack) {
            if k.config
                .as_ref()
                .is_some_and(|c| c.style == KnobStyle::Wire)
            {
                engine
                    .set_knob_config(to_instance, to_jack, None)
                    .map_err(err)?;
            }
        }
    }
    engine.remove_midi_mapping(&instance, &name).map_err(err)
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
    let mut engine = patch_edit(&state, EditKey::LedAdd(&instance, &name))?;
    engine
        .add_midi_led_mapping(&instance, kind, num, &name)
        .map(|_| ())
        .map_err(err)
}

/// Remove a MIDI LED mapping. The engine drops wires into its jack (a
/// live structural edit; audio keeps running).
#[tauri::command]
fn remove_midi_led_mapping(
    state: State<AppState>,
    instance: String,
    name: String,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::LedRemove(&instance, &name))?;
    engine
        .remove_midi_led_mapping(&instance, &name)
        .map_err(err)
}

/// Everything the choreography panel needs per poll: the timeline plus
/// the live playhead beat.
#[derive(serde::Serialize)]
struct ChoreoStatus {
    beats: usize,
    tracks: Vec<dj_engine::ChoreoTrack>,
    playhead: i64,
}

#[tauri::command]
fn choreo_status(state: State<AppState>, instance: String) -> CmdResult<ChoreoStatus> {
    let engine = engine_lock(&state)?;
    let st = engine.choreo(&instance).map_err(err)?;
    Ok(ChoreoStatus {
        beats: st.beats,
        tracks: st.tracks.clone(),
        playhead: engine.choreo_playhead(&instance).map_err(err)?,
    })
}

#[tauri::command]
fn choreo_set_beats(state: State<AppState>, instance: String, beats: usize) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoBeats(&instance))?;
    engine.choreo_set_beats(&instance, beats).map_err(err)
}

/// Add a track ("boolean" | "continuous" | "note"); it materializes as
/// one (or two, for note tracks) output jacks.
#[tauri::command]
fn choreo_add_track(
    state: State<AppState>,
    instance: String,
    name: String,
    kind: String,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackAdd(&instance, &name))?;
    engine
        .choreo_add_track(&instance, &name, &kind)
        .map(|_| ())
        .map_err(err)
}

/// Remove a track. Wires from its jack(s) are disconnected first
/// (restoring auto wire-style knobs), which needs the engine stopped.
#[tauri::command]
fn choreo_remove_track(state: State<AppState>, instance: String, track: usize) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackRemove(&instance, track))?;
    let jacks: Vec<String> = {
        let st = engine.choreo(&instance).map_err(err)?;
        let t = st
            .tracks
            .get(track)
            .ok_or_else(|| CmdError::not_found(format!("no track {track}")))?;
        (t.jack..t.jack + t.data.jack_count())
            .map(|j| format!("t{j}"))
            .collect()
    };
    let doomed: Vec<(String, String, String)> = engine
        .wire_specs()
        .iter()
        .filter(|w| {
            engine.nodes[w.from_node].instance_id == instance
                && jacks.contains(&engine.output_jack_name(w.from_node, w.from_jack))
        })
        .map(|w| {
            (
                engine.output_jack_name(w.from_node, w.from_jack),
                engine.nodes[w.to_node].instance_id.clone(),
                engine.nodes[w.to_node].manifest.inputs[w.to_jack]
                    .id
                    .clone(),
            )
        })
        .collect();
    if doomed.is_empty() {
        return engine.choreo_remove_track(&instance, track).map_err(err);
    }
    for (from_jack, to_instance, to_jack) in &doomed {
        engine
            .disconnect(&instance, from_jack, to_instance, to_jack)
            .map_err(err)?;
        if let Ok(k) = engine.knob_state(to_instance, to_jack) {
            if k.config
                .as_ref()
                .is_some_and(|c| c.style == KnobStyle::Wire)
            {
                engine
                    .set_knob_config(to_instance, to_jack, None)
                    .map_err(err)?;
            }
        }
    }
    engine.choreo_remove_track(&instance, track).map_err(err)
}

#[tauri::command]
fn choreo_rename_track(
    state: State<AppState>,
    instance: String,
    track: usize,
    name: String,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackRename(&instance, track))?;
    engine
        .choreo_rename_track(&instance, track, &name)
        .map_err(err)
}

/// Reorder tracks (display order only; jacks stay with their tracks).
#[tauri::command]
fn choreo_move_track(
    state: State<AppState>,
    instance: String,
    from: usize,
    to: usize,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackMove(&instance))?;
    engine.choreo_move_track(&instance, from, to).map_err(err)
}

#[tauri::command]
fn choreo_set_bool(
    state: State<AppState>,
    instance: String,
    track: usize,
    beat: usize,
    on: bool,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoData(&instance, track))?;
    engine
        .choreo_set_bool(&instance, track, beat, on)
        .map_err(err)
}

/// Write a run of continuous values from `start` (drag paints batch).
#[tauri::command]
fn choreo_set_values(
    state: State<AppState>,
    instance: String,
    track: usize,
    start: usize,
    values: Vec<f32>,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoData(&instance, track))?;
    engine
        .choreo_set_values(&instance, track, start, &values)
        .map_err(err)
}

/// Set or clear the note at a beat (`degree`/`velocity` together; None
/// clears).
#[tauri::command]
fn choreo_set_note(
    state: State<AppState>,
    instance: String,
    track: usize,
    beat: usize,
    note: Option<dj_engine::NoteStep>,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoData(&instance, track))?;
    engine
        .choreo_set_note(&instance, track, beat, note)
        .map_err(err)
}

#[tauri::command]
fn choreo_set_note_settings(
    state: State<AppState>,
    instance: String,
    track: usize,
    octaves: u8,
    scale: String,
    base_note: u8,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackSettings(&instance, track))?;
    engine
        .choreo_set_note_settings(&instance, track, octaves, &scale, base_note)
        .map_err(err)
}

/// The Math panel's whole state: the expression as typed and why it is
/// not running, if it is not.
#[derive(serde::Serialize)]
struct MathStatus {
    expr: String,
    error: Option<String>,
}

#[tauri::command]
fn math_status(state: State<AppState>, instance: String) -> CmdResult<MathStatus> {
    let engine = engine_lock(&state)?;
    Ok(MathStatus {
        expr: engine.math(&instance).map_err(err)?.expr.clone(),
        error: engine.math_error(&instance).map_err(err)?,
    })
}

/// Set the expression. A text that does not compile is still the module's
/// state (it is what the user typed and it round-trips through the patch);
/// the message comes back for the panel to show while the last expression
/// that DID compile keeps running.
#[tauri::command]
fn math_set_expr(state: State<AppState>, instance: String, expr: String) -> CmdResult<MathStatus> {
    let mut engine = patch_edit(&state, EditKey::MathExpr(&instance))?;
    let error = engine.math_set_expr(&instance, &expr).map_err(err)?;
    Ok(MathStatus { expr, error })
}

/// One tracked camera frame into a Hands node (the camera panel calls
/// this at camera rate while tracking is on). Pure live control data —
/// nothing persists, so `engine_lock`, not `patch_edit`. Errors are
/// returned (not fatal): the panel drops the frame and keeps going, and
/// the RT side holds last values, matching the dropout policy.
#[tauri::command]
fn hands_feed(
    state: State<AppState>,
    instance: String,
    detection: dj_engine::hands::HandsDetection,
) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    let frame = engine.current_frame();
    engine
        .hands_feed(&instance, frame, Some(&detection))
        .map_err(err)
}

#[tauri::command]
fn load_demo_patch(state: State<AppState>) -> CmdResult<()> {
    {
        let engine = engine_lock(&state)?;
        if !engine.nodes.is_empty() {
            return Ok(());
        }
    }
    // Crash/quit recovery: restore the autosaved patch when one exists.
    let autosave = autosave_dir();
    if autosave.join("patch.json").is_file() {
        match load_patch_dir(&state, &autosave) {
            // Load warnings are logged by load_patch_dir itself.
            Ok(_) => {
                if let Some(name) = std::fs::read_to_string(autosave.join("patch.json"))
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .and_then(|v| v["name"].as_str().map(str::to_string))
                {
                    *state.patch_name.lock().map_err(err)? = name;
                }
                if let Ok(deck_name) = std::fs::read_to_string(autosave.join("deck_name.txt")) {
                    let deck_name = deck_name.trim();
                    if !deck_name.is_empty() {
                        *state.deck_patch_name.lock().map_err(err)? = deck_name.to_string();
                    }
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
    let mut engine = engine_lock(&state)?;
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
    // Building the demo patch is startup state, not an undoable edit —
    // and it is the session's clean baseline for the unsaved-changes
    // prompt.
    state.history.lock().map_err(err)?.clear();
    mark_saved(&state, &engine);
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
    let mut engine = patch_edit(&state, EditKey::Knob(&instance, &jack))?;
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
    let mut engine = patch_edit(&state, EditKey::KnobConfig(&instance, &jack))?;
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
    let mut engine = patch_edit(&state, EditKey::AttenOffset(&instance, &jack))?;
    engine
        .set_knob_atten_offset(&instance, &jack, atten, offset)
        .map_err(err)
}

/// Double-click knob reset: position back to the manifest default, wire
/// atten/offset and config override back to their defaults.
#[tauri::command]
fn reset_knob(state: State<AppState>, instance: String, jack: String) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::KnobReset(&instance, &jack))?;
    engine.reset_knob(&instance, &jack).map_err(err)
}

/// Module context menu "Reset to defaults": every knob and param back to
/// the state a freshly added module would have. Non-structural — wires,
/// MIDI mappings and loaded tracks stay.
#[tauri::command]
fn reset_module(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ModuleReset(&instance))?;
    engine.reset_module(&instance).map_err(err)
}

/// Group "Reset to defaults": one undo step for the whole selection.
#[tauri::command]
fn reset_modules(state: State<AppState>, instances: Vec<String>) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ModuleResetMany)?;
    for instance in &instances {
        engine.reset_module(instance).map_err(err)?;
    }
    Ok(())
}

/// Module context menu "Presets" submenu: recall one of the module's
/// built-in presets (a named set of input-jack values from its manifest).
#[tauri::command]
fn apply_preset(state: State<AppState>, instance: String, preset: String) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::Preset(&instance, &preset))?;
    engine.apply_preset(&instance, &preset).map_err(err)
}

/// Copy: the selected modules (with wires internal to the selection) as a
/// clipboard document, serialized to JSON. The frontend owns the clipboard
/// so it survives engine edits.
#[tauri::command]
fn copy_modules(state: State<AppState>, instances: Vec<String>) -> CmdResult<String> {
    let engine = engine_lock(&state)?;
    let doc = engine.snapshot("clipboard").extract_selection(&instances);
    if doc.modules.is_empty() {
        return Err(CmdError::invalid("nothing to copy".to_string()));
    }
    serde_json::to_string(&doc).map_err(err)
}

/// Paste a [`copy_modules`] clipboard as new instances (fresh ids, internal
/// wires remapped). One undo step; returns copied id -> created id so the
/// frontend can place each paste near its source module.
#[tauri::command]
fn paste_modules(
    state: State<AppState>,
    clipboard: String,
    workspace: Option<String>,
) -> CmdResult<BTreeMap<String, String>> {
    let ws = ws_arg(workspace.as_deref())?;
    let clip: PatchDoc = serde_json::from_str(&clipboard)
        .map_err(|e| CmdError::invalid(format!("bad clipboard: {e}")))?;
    let mut engine = patch_edit(&state, EditKey::Paste)?;
    let mut doc = engine.snapshot("paste");
    let renames = doc.paste(&clip);
    // The copies land in the workspace of the tab pasting them, wherever
    // the copy came from.
    for id in renames.values() {
        if let Some(mf) = doc.modules.get_mut(id) {
            mf.workspace = ws;
        }
    }
    engine.apply_doc(&doc).map_err(err)?;
    // A pasted Beat Clip carries only its binding; hand each copy the
    // audio its source already holds — nothing to re-assemble, and it
    // works even for a clip whose project has since gone. Pairs the
    // source cannot serve (a clipboard from another patch) fall through
    // to the usual assembly.
    let is_clip = |id: &String| {
        engine
            .nodes
            .iter()
            .any(|n| &n.instance_id == id && n.is_beat_clip())
    };
    let clip_pairs: Vec<(String, String)> = renames
        .iter()
        .filter(|(from, to)| is_clip(from) && is_clip(to))
        .map(|(from, to)| (from.clone(), to.clone()))
        .collect();
    for (from, to) in clip_pairs {
        engine.beat_clip_copy(&from, &to).map_err(err)?;
    }
    beat_clip::hydrate(&state, &mut engine);
    decks::hydrate(&state, &mut engine);
    Ok(renames)
}

/// Delete the whole selection as one undo step.
#[tauri::command]
fn remove_modules(state: State<AppState>, instances: Vec<String>) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::RemoveMany)?;
    for instance in &instances {
        engine
            .remove_module(instance)
            .map_err(|e| CmdError::not_found(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
fn set_param(state: State<AppState>, instance: String, param: String, value: f32) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::Param(&instance, &param))?;
    engine.set_param(&instance, &param, value).map_err(err)
}

/// Bypass a module: its declared in -> out routes carry the signal and its
/// DSP stops running. Per-module state like a knob — undoable, and saved
/// in the patch.
#[tauri::command]
fn set_module_bypass(state: State<AppState>, instance: String, bypass: bool) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::Bypass(&instance))?;
    engine.set_bypass(&instance, bypass).map_err(err)
}

#[tauri::command]
fn tap(state: State<AppState>, instance: String, jack: String) -> CmdResult<JackTelemetry> {
    let engine = engine_lock(&state)?;
    engine.tap(&instance, &jack).map_err(err)
}

/// A window of raw samples from a `capture` jack — the Scope's trace and
/// spectrum are drawn from this, never from the scalar telemetry (which
/// cannot describe a waveform). Poll-rate, like `tap`.
#[tauri::command]
fn jack_capture(
    state: State<AppState>,
    instance: String,
    jack: String,
) -> CmdResult<CaptureWindow> {
    let engine = engine_lock(&state)?;
    engine.jack_capture(&instance, &jack).map_err(err)
}

/// Batched telemetry for the UI's 100 ms poll: one lock acquisition and one
/// IPC round-trip for the whole rack instead of one `tap` per jack. Keys
/// mirror the `engine_nodes` snapshot the UI renders from: every concrete
/// node (macro internals included), MIDI nodes expose their LED-mapping
/// input jacks and mapped output jacks by name, choreo nodes their
/// mapping outputs. Output jacks are namespaced as `out:<jack>` so they
/// can never collide with an input of the same name.
#[tauri::command]
fn tap_all(state: State<AppState>) -> CmdResult<BTreeMap<String, BTreeMap<String, JackTelemetry>>> {
    let mut engine = engine_lock(&state)?;
    // Live structural edits ship replaced modules/buffers back over the
    // garbage ring; this 100 ms poll is the periodic control-side drop
    // point (a removed deck can hold a whole decoded track).
    engine.drain_garbage();
    let mut out: BTreeMap<String, BTreeMap<String, JackTelemetry>> = BTreeMap::new();
    for n in &engine.nodes {
        let jacks = out.entry(n.instance_id.clone()).or_default();
        if n.is_midi() {
            for m in &n.midi_led_mappings {
                if let Some(slot) = n.telemetry.get(m.jack) {
                    jacks.insert(m.name.clone(), slot.read());
                }
            }
            for m in &n.midi_mappings {
                if let Some(slot) = n.out_telemetry.get(m.jack) {
                    jacks.insert(format!("out:{}", m.name), slot.read());
                }
            }
        } else {
            for (i, decl) in n.manifest.inputs.iter().enumerate() {
                if let Some(slot) = n.telemetry.get(i) {
                    jacks.insert(decl.id.clone(), slot.read());
                }
            }
            if let Some(c) = &n.choreo {
                // Choreo output jacks are dynamic, 1-2 per track, keyed by
                // the stable `t<slot>` ids the snapshot exposes.
                for t in &c.tracks {
                    for j in t.jack..t.jack + t.data.jack_count() {
                        if let Some(slot) = n.out_telemetry.get(j) {
                            jacks.insert(format!("out:t{j}"), slot.read());
                        }
                    }
                }
            } else {
                for (i, decl) in n.manifest.outputs.iter().enumerate() {
                    if let Some(slot) = n.out_telemetry.get(i) {
                        jacks.insert(format!("out:{}", decl.id), slot.read());
                    }
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn save_patch(
    state: State<AppState>,
    dir: String,
    name: String,
    workspace: Option<String>,
) -> CmdResult<()> {
    let ws = ws_arg(workspace.as_deref())?;
    let engine = engine_lock(&state)?;
    workspace_doc(&engine, ws, &name)
        .write(Path::new(&dir))
        .map_err(err)?;
    mark_saved_ws(&state, &engine, ws);
    Ok(())
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

/// The current-patch-name cell for a workspace.
fn ws_name(state: &AppState, ws: Workspace) -> &Mutex<String> {
    match ws {
        Workspace::Rack => &state.patch_name,
        Workspace::Decks => &state.deck_patch_name,
    }
}

#[tauri::command]
fn save_patch_as(state: State<AppState>, name: String, workspace: Option<String>) -> CmdResult<()> {
    let ws = ws_arg(workspace.as_deref())?;
    let name = name.trim().to_string();
    if !valid_patch_name(&name) {
        return Err(CmdError::invalid(format!("invalid patch name: {name:?}")));
    }
    let engine = engine_lock(&state)?;
    workspace_doc(&engine, ws, &name)
        .write(&workspace_patches_dir(ws).join(&name))
        .map_err(err)?;
    mark_saved_ws(&state, &engine, ws);
    *ws_name(&state, ws).lock().map_err(err)? = name;
    Ok(())
}

/// File > New Patch, for ONE workspace: clear its modules out of the live
/// engine (undoable) and reset its working name to "untitled". The other
/// workspace — the other tab's rack — is untouched: the engine keeps
/// running and only the emptied side goes quiet. A decks New leaves the
/// workspace truly empty; the page's next `decks_ensure` builds the fresh
/// bank, exactly like the first visit ever did.
#[tauri::command]
fn new_patch(state: State<AppState>, workspace: Option<String>) -> CmdResult<()> {
    let ws = ws_arg(workspace.as_deref())?;
    let mut engine = patch_edit(&state, EditKey::NewPatch)?;
    let mut doc = engine.snapshot("new");
    doc.retain_workspace(other_workspace(ws));
    restore_doc(&state, &mut engine, &doc)?;
    mark_saved_ws(&state, &engine, ws);
    *ws_name(&state, ws).lock().map_err(err)? = "untitled".into();
    Ok(())
}

#[tauri::command]
fn list_patches(workspace: Option<String>) -> CmdResult<Vec<String>> {
    let ws = ws_arg(workspace.as_deref())?;
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(workspace_patches_dir(ws)) {
        for entry in entries.flatten() {
            if entry.path().join("patch.json").is_file() {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Open a named patch INTO one workspace of the live engine: the
/// workspace's current modules leave, the patch's arrive under its tag
/// (renamed only away from a collision with the other workspace), and the
/// other workspace is untouched — DSP state, telemetry and all. One undo
/// step. Returns non-fatal load warnings for the UI banner.
#[tauri::command]
fn load_patch_by_name(
    state: State<AppState>,
    name: String,
    workspace: Option<String>,
) -> CmdResult<Vec<String>> {
    let ws = ws_arg(workspace.as_deref())?;
    if !valid_patch_name(&name) {
        return Err(CmdError::invalid(format!("invalid patch name: {name:?}")));
    }
    let dir = workspace_patches_dir(ws).join(&name);
    let incoming = PatchDoc::read(&dir).map_err(err)?;
    let mut engine = patch_edit(&state, EditKey::Load(&dir.display().to_string()))?;
    // Warnings accumulate on the engine; report only this load's.
    engine.load_warnings.clear();
    let mut doc = engine.snapshot("load");
    doc.retain_workspace(other_workspace(ws));
    doc.merge_workspace(&incoming, ws);
    restore_doc(&state, &mut engine, &doc)?;
    mark_saved_ws(&state, &engine, ws);
    *ws_name(&state, ws).lock().map_err(err)? = name;
    let warnings = engine.load_warnings.clone();
    for w in &warnings {
        eprintln!("[dj-audio] patch load ({}): {w}", dir.display());
    }
    Ok(warnings)
}

#[tauri::command]
fn current_patch(state: State<AppState>, workspace: Option<String>) -> CmdResult<String> {
    let ws = ws_arg(workspace.as_deref())?;
    Ok(ws_name(&state, ws).lock().map_err(err)?.clone())
}

/// Returns the engine's non-fatal load warnings (dropped stale wires/params).
fn load_patch_dir(state: &State<AppState>, dir: &Path) -> CmdResult<Vec<String>> {
    let mut engine = patch_edit(state, EditKey::Load(&dir.display().to_string()))?;
    // The loaded engine replaces this one and comes up stopped, so the
    // pre-load backend must be restarted afterwards — the frontend only
    // calls engine_start once, at app startup. Which PAGE is open is the
    // session's, not the patch's, so it survives the swap too.
    let backend = engine.backend();
    let focus = engine.audio_focus();
    engine.stop().map_err(err)?;
    let registry = ExtensionRegistry::discover(&extension_dirs()).map_err(err)?;
    // Seed the replacement engine's view of the macro store so every
    // published macro stays instantiable regardless of what the patch
    // itself uses (the patch's own per-instance copies are what its
    // instances run). Without this, an engine swap silently dropped every
    // macro the patch didn't use — e.g. break the last instance, quit,
    // restart: the autosave restore came up knowing no macros at all.
    let doc = PatchDoc::read(dir).map_err(err)?;
    *engine = Engine::from_doc_with_macros(&doc, registry, store_macro_library()).map_err(err)?;
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
    // Beat Clip modules and Decks slots: the patch names the clip, the
    // app assembles it.
    beat_clip::hydrate(state, &mut engine);
    decks::hydrate(state, &mut engine);
    engine.set_audio_focus(focus).map_err(err)?;
    restart_backend(&mut engine, backend, "patch load")?;
    mark_saved(state, &engine);
    let warnings = engine.load_warnings.clone();
    for w in &warnings {
        eprintln!("[dj-audio] patch load ({}): {w}", dir.display());
    }
    Ok(warnings)
}

/// The global macro store: `<data_dir>/macros/`, a sibling of `patches/`.
fn macro_store() -> MacroStore {
    MacroStore::new(dj_library::default_data_dir().join(MACROS_DIR_NAME))
}

/// Every published macro, as an engine-side `MacroLibrary`. A store that
/// cannot be read is logged and treated as empty — a broken definition
/// file must not stop the app from opening a patch.
fn store_macro_library() -> MacroLibrary {
    match macro_store().load() {
        Ok(lib) => lib,
        Err(e) => {
            eprintln!("[dj-macros] loading the macro store failed: {e:#}");
            MacroLibrary::default()
        }
    }
}

fn persist_macro(def: &MacroDef) -> CmdResult<()> {
    macro_store().save(def).map_err(err)
}

/// One-shot migration to the global macro store, run at startup: patches
/// that embedded one shared definition per macro id get per-instance
/// copies, and macros left in the retired `macros` DB table move into the
/// store. Idempotent, and never fatal — a failure just leaves the old
/// state in place.
fn migrate_macros_to_store(library: &Library) {
    let store = macro_store();
    match library.legacy_macros() {
        Ok(rows) => {
            let mut moved = 0;
            for row in &rows {
                match serde_json::from_str::<MacroDef>(&row.definition) {
                    Ok(def) => match store.save(&def) {
                        Ok(()) => moved += 1,
                        Err(e) => eprintln!("[dj-macros] storing {}: {e:#}", row.id),
                    },
                    Err(e) => eprintln!("[dj-macros] bad stored definition for {}: {e}", row.id),
                }
            }
            if moved == rows.len() && !rows.is_empty() {
                if let Err(e) = library.drop_legacy_macros() {
                    eprintln!("[dj-macros] dropping the legacy macros table: {e:#}");
                } else {
                    println!("[dj-macros] moved {moved} macro(s) out of the library DB");
                }
            }
        }
        Err(e) => eprintln!("[dj-macros] reading the legacy macros table: {e:#}"),
    }
    match store.import_patch_macros(&patches_dir()) {
        Ok(report) if report.is_empty() => {}
        Ok(report) => println!(
            "[dj-macros] migrated {} patch instance(s) to per-instance copies; \
             published {} macro(s) ({} duplicate definition(s) collapsed)",
            report.instances.len(),
            report.bases.len(),
            report.deduped
        ),
        Err(e) => eprintln!("[dj-macros] migrating patch macros: {e:#}"),
    }
}

/// Load a patch from an arbitrary directory. Patches are self-contained
/// (each macro instance carries its own definition), so this is a plain
/// load; the macro store only seeds the bases for the picker.
/// Returns non-fatal load warnings for the UI banner.
#[tauri::command]
fn load_patch(state: State<AppState>, dir: String) -> CmdResult<Vec<String>> {
    load_patch_dir(&state, Path::new(&dir))
}

#[derive(Serialize)]
struct MacroInfo {
    id: String,
    name: String,
}

/// Macros available for instantiation (the global store, PRD §6).
#[tauri::command]
fn list_macros(state: State<AppState>) -> CmdResult<Vec<MacroInfo>> {
    let engine = engine_lock(&state)?;
    Ok(engine
        .macros
        .list()
        .into_iter()
        .map(|d| MacroInfo {
            id: d.id.clone(),
            name: d.name.clone(),
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
/// `positions` carries each selected module's rack position so the
/// definition remembers the arrangement (stored relative to the group's
/// top-left corner).
///
/// The outcome is either the new instance id, or — when a macro with the
/// same name already exists and `overwrite` wasn't set — the existing
/// definition's info so the UI can ask before clobbering it.
#[derive(Serialize)]
struct CollapseOutcome {
    instance: Option<String>,
    conflict: Option<MacroInfo>,
}

#[tauri::command]
fn collapse_macro(
    state: State<AppState>,
    selection: Vec<String>,
    name: String,
    positions: Option<BTreeMap<String, (f32, f32)>>,
    overwrite: Option<bool>,
) -> CmdResult<CollapseOutcome> {
    if selection.is_empty() {
        return Err(CmdError::invalid("empty selection"));
    }
    let mut engine = engine_lock(&state)?;
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    // Same name ⇒ same id (the id IS the name's slug): saving under an
    // existing name means overwriting that macro, which needs the caller's
    // explicit consent. Checked before record_edit so a declined overwrite
    // leaves no phantom undo entry.
    let macro_id = format!("macro.{slug}");
    let existing = engine.macros.get(&macro_id).cloned();
    if let Some(old) = &existing {
        if overwrite != Some(true) {
            return Ok(CollapseOutcome {
                instance: None,
                conflict: Some(MacroInfo {
                    id: old.id.clone(),
                    name: old.name.clone(),
                }),
            });
        }
    }
    record_edit(&state, &engine, &EditKey::CollapseMacro);
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
    let mut def = with_stopped(&mut engine, |e| {
        if existing.is_some() {
            e.recollapse_macro(&sel_refs, &instance, &macro_id, &name, interface)
                .map_err(err)
        } else {
            e.collapse_to_macro(&sel_refs, &instance, &macro_id, &name, interface)
                .map_err(err)
        }
    })?;
    // Remember the arrangement: positions normalized to the group's
    // top-left corner so a fresh instance lays out the same shape anywhere.
    if let Some(positions) = positions {
        let x0 = positions
            .values()
            .map(|p| p.0)
            .fold(f32::INFINITY, f32::min);
        let y0 = positions
            .values()
            .map(|p| p.1)
            .fold(f32::INFINITY, f32::min);
        let rel: BTreeMap<String, (f32, f32)> = positions
            .into_iter()
            .filter(|(id, _)| def.modules.contains_key(id))
            .map(|(id, (x, y))| (id, (x - x0, y - y0)))
            .collect();
        if !rel.is_empty() {
            def = engine.set_macro_positions(&macro_id, rel).map_err(err)?;
        }
    }
    persist_macro(&def)?;
    Ok(CollapseOutcome {
        instance: Some(instance),
        conflict: None,
    })
}

/// *Pull latest* on one macro instance: replace its private copy of the
/// definition with the current published one and re-expand it. DESTRUCTIVE
/// — every edit made inside this instance is discarded — so the UI warns
/// first. Returns the wires the new interface could not keep (empty when
/// the instance already matched the base, which is a no-op).
#[tauri::command]
fn pull_macro_instance(state: State<AppState>, instance: String) -> CmdResult<Vec<String>> {
    let mut engine = patch_edit(&state, EditKey::PullMacro(&instance))?;
    let mut warnings = Vec::new();
    with_stopped(&mut engine, |e| {
        warnings = e.pull_macro_instance(&instance).map_err(err)?;
        Ok(())
    })?;
    for w in &warnings {
        eprintln!("[dj-macros] pull {instance}: {w}");
    }
    Ok(warnings)
}

/// *Save macro*: publish this instance's current state as the macro's new
/// definition. Other instances keep what they have until they pull.
/// Returns false when nothing had changed.
#[tauri::command]
fn save_macro_instance(state: State<AppState>, instance: String) -> CmdResult<bool> {
    let mut engine = engine_lock(&state)?;
    let Some(def) = engine.save_macro_instance(&instance).map_err(err)? else {
        return Ok(false);
    };
    persist_macro(&def)?;
    Ok(true)
}

/// *Reset to defaults*: discard local edits inside one instance, back to
/// the copy of the definition it was adopted with. Undoable.
#[tauri::command]
fn reset_macro_instance(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ResetMacro(&instance))?;
    with_stopped(&mut engine, |e| {
        e.reset_macro_instance(&instance).map_err(err)
    })
}

/// Rename a published macro (stable id, display name only). Library
/// state, not patch state (so not undoable, like [`delete_macro`]):
/// instances keep their own copies, so this only retitles the base.
#[tauri::command]
fn rename_macro(state: State<AppState>, macro_id: String, name: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    let def = engine.rename_macro(&macro_id, &name).map_err(err)?;
    persist_macro(&def)
}

/// Delete a macro from the global store. Refused while any rack instance
/// still uses it (break or delete the instances first) — a live instance
/// with no base couldn't re-publish or be pulled again. Not undoable: the
/// definition is library state, not patch state (like DJ metadata).
#[tauri::command]
fn delete_macro(state: State<AppState>, macro_id: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    if let Some(mi) = engine
        .macro_instances()
        .iter()
        .find(|(_, mi)| mi.macro_id == macro_id)
    {
        return Err(CmdError::invalid(format!(
            "macro is in use by instance {:?} — break or delete it first",
            mi.0
        )));
    }
    engine
        .unregister_macro(&macro_id)
        .ok_or_else(|| CmdError::invalid(format!("unknown macro {macro_id:?}")))?;
    macro_store().remove(&macro_id).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn inject_midi(
    state: State<AppState>,
    instance: String,
    frame: u64,
    data: [u8; 3],
) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.inject_midi(&instance, frame, data).map_err(err)
}

/// One key transition into a QWERTY node (the panel's window key
/// listeners call this). Pure live control data — nothing persists, so
/// `engine_lock`, not `patch_edit`.
#[tauri::command]
fn qwerty_key(state: State<AppState>, instance: String, key: String, down: bool) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    let frame = engine.current_frame();
    engine.qwerty_key(&instance, frame, &key, down).map_err(err)
}

/// Where the two buses play: the hardware outputs, the pair currently
/// chosen, and the pair actually REACHED. The names are the machine's, so
/// the pickers can show what is there, and the `playing_*` pair is what
/// lets them say "your headphones are gone, this is coming out of the
/// speakers" instead of leaving the user staring at a dead choice.
#[derive(Serialize)]
struct AudioOutputSettings {
    devices: Vec<String>,
    live: Option<String>,
    monitor: Option<String>,
    playing_live: Option<String>,
    playing_monitor: Option<String>,
    /// One line on why the engine is not playing where it was asked to.
    note: Option<String>,
}

/// Device choices live beside the app's other data, NOT in the patch: a
/// patch travels between machines, and a sound card does not.
fn audio_outputs_path() -> PathBuf {
    dj_library::default_data_dir().join("audio_outputs.json")
}

fn load_audio_outputs() -> AudioOutputs {
    std::fs::read_to_string(audio_outputs_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn audio_outputs(state: State<AppState>) -> CmdResult<AudioOutputSettings> {
    let engine = engine_lock(&state)?;
    let chosen = engine.audio_outputs().clone();
    let playing = engine.audio_device_status();
    Ok(AudioOutputSettings {
        devices: dj_engine::audio_output_devices(),
        live: chosen.live,
        monitor: chosen.monitor,
        playing_live: playing.live,
        playing_monitor: playing.monitor,
        note: playing.note,
    })
}

/// Point a bus at a device. The streams are opened at backend start, so a
/// running engine is stopped and started again — the graph, and every
/// deck's position in it, is untouched by that.
#[tauri::command]
fn set_audio_outputs(
    state: State<AppState>,
    live: Option<String>,
    monitor: Option<String>,
) -> CmdResult<()> {
    let outputs = AudioOutputs { live, monitor };
    let path = audio_outputs_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, serde_json::to_string_pretty(&outputs).map_err(err)?).map_err(err)?;
    let mut engine = engine_lock(&state)?;
    // Re-picking what is already chosen is a no-op — unless nothing is
    // playing, in which case the user has just told a silent engine to try
    // that device again, and it should.
    if engine.audio_outputs() == &outputs && engine.audio_device_status().live.is_some() {
        return Ok(());
    }
    engine.set_audio_outputs(outputs);
    let was_running = engine.is_running();
    if was_running {
        engine.stop().map_err(err)?;
        restart_backend(&mut engine, Some(Backend::Cpal), "audio output change")?;
    }
    Ok(())
}

/// Play for the page the user is looking at. ONE PAGE SOUNDS AT A TIME:
/// the Rack is the whole patch, the Decks page is its bank (and whatever
/// the bank is played through), and a page that makes its own sound —
/// Clip, Beatify — or none at all leaves the engine silent. Ephemeral
/// session state, so it is not an undoable edit and never reaches the
/// patch; the engine keeps running either way, so a page comes back
/// exactly where it was.
#[tauri::command]
fn set_audio_focus(state: State<AppState>, focus: AudioFocus) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.set_audio_focus(focus).map_err(err)
}

#[tauri::command]
fn engine_start(state: State<AppState>) -> CmdResult<String> {
    let mut engine = engine_lock(&state)?;
    if engine.is_running() {
        return Ok("already-running".into());
    }
    // Whatever devices the user picked last time they were here.
    engine.set_audio_outputs(load_audio_outputs());
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
    let mut engine = engine_lock(&state)?;
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

/// Search one store, with that store's filter selections. Runs on a
/// worker thread (`async`): a provider search is a network round-trip, and
/// the YouTube one spawns yt-dlp — neither may block the main thread.
#[tauri::command(async)]
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

/// Rename a track (Library page): title and artist only — everything
/// else about the row is derived from the file or the analysis.
#[tauri::command]
fn set_track_names(
    state: State<AppState>,
    track_id: i64,
    title: String,
    artist: String,
) -> CmdResult<Track> {
    state
        .library
        .set_track_names(track_id, &title, &artist)
        .map_err(err)
}

/// Delete a track and everything the app derived from it: the row with
/// its DJ metadata (cues, loops, beatgrid, tags, crate membership), the
/// stem cache keyed by its content, the Clip page's decoded copy, and the
/// audio file itself when the app owns it (a provider download or a
/// rendered clip — a file in the user's own folders always stays).
///
/// It does NOT chase the references pointing AT the track: a beatify
/// seed, a clip source and a saved patch's deck each name a track that
/// may already be gone, and each degrades on its own (a seed falls back
/// to its own render, a patch load warns and comes up without the track).
#[tauri::command]
fn delete_track(state: State<AppState>, track_id: i64) -> CmdResult<dj_library::DeletedTrack> {
    // A separation in flight would write stems back into the cache we are
    // about to remove, so stop it before the row goes.
    state.stems.cancel_track(track_id);
    let deleted = state.library.delete_track(track_id).map_err(err)?;
    state.clips.forget(track_id);
    let hash = &deleted.track.content_hash;
    if let Err(e) = dj_analysis::remove_stems(state.library.data_dir(), hash) {
        eprintln!("[dj-analysis] removing stems for {hash}: {e:#}");
    }
    Ok(deleted)
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

/// Start acquiring a result in the background and return the job id. The
/// transfer never runs on this thread: yt-dlp fetches take seconds to
/// minutes, and even HTTP downloads would stall the window.
#[tauri::command]
fn start_download(state: State<AppState>, result: TrackResult) -> CmdResult<u64> {
    Ok(state.downloads.start(result))
}

/// Snapshot of running/recent download jobs (polled by the library view).
#[tauri::command]
fn download_jobs(state: State<AppState>) -> CmdResult<Vec<dj_library::DownloadJob>> {
    Ok(state.downloads.jobs())
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
        return Err(CmdError::invalid(format!(
            "refusing to open non-http(s) URL: {url}"
        )));
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
    let mut engine = patch_edit(&state, EditKey::Track(&instance))?;
    engine
        .playback_load(&instance, &PathBuf::from(track.file_path))
        .map_err(err)
}

/// Load a library track into an Audio module instance. The track's tempo
/// comes from the library (canonical, like deck beatgrids): the module
/// adopts it on the BPM input and resets speed to 1x.
#[tauri::command]
fn audio_load(state: State<AppState>, instance: String, track_id: i64) -> CmdResult<()> {
    let track = state.library.track(track_id).map_err(err)?;
    let mut engine = patch_edit(&state, EditKey::Track(&instance))?;
    engine
        .audio_load(&instance, &PathBuf::from(track.file_path), track.bpm)
        .map_err(err)
}

/// Track + transport + tempo snapshot for the Audio module panel.
#[tauri::command]
fn audio_status(
    state: State<AppState>,
    instance: String,
) -> CmdResult<dj_engine::audio::AudioStatus> {
    let engine = engine_lock(&state)?;
    engine.audio_status(&instance).map_err(err)
}

/// Waveform overview peaks (0..=1) of an Audio module's track.
#[tauri::command]
fn audio_waveform(state: State<AppState>, instance: String, buckets: usize) -> CmdResult<Vec<f32>> {
    let engine = engine_lock(&state)?;
    engine
        .audio_waveform(&instance, buckets.min(20_000))
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
    let mut engine = engine_lock(&state)?;
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
    let mut engine = engine_lock(&state)?;
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
    let mut engine = patch_edit(&state, EditKey::Track(&instance))?;
    engine
        .deck_load(&instance, &PathBuf::from(track.file_path))
        .map_err(err)?;
    apply_deck_metadata(&state, &mut engine, &instance)
}

#[tauri::command]
fn deck_status(state: State<AppState>, instance: String) -> CmdResult<dj_engine::deck::DeckStatus> {
    let engine = engine_lock(&state)?;
    engine.deck_status(&instance).map_err(err)
}

/// Waveform overview peaks (0..=1), `buckets` values.
#[tauri::command]
fn deck_waveform(state: State<AppState>, instance: String, buckets: usize) -> CmdResult<Vec<f32>> {
    let engine = engine_lock(&state)?;
    engine
        .deck_waveform(&instance, buckets.min(20_000))
        .map_err(err)
}

#[tauri::command]
fn deck_seek(state: State<AppState>, instance: String, position: f64) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
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
    let mut engine = engine_lock(&state)?;
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
    let mut engine = engine_lock(&state)?;
    engine.deck_set_loop(&instance, start, end).map_err(err)
}

#[tauri::command]
fn deck_loop_enable(state: State<AppState>, instance: String, enabled: bool) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_loop_enable(&instance, enabled).map_err(err)
}

#[tauri::command]
fn deck_loop_halve(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_loop_halve(&instance).map_err(err)
}

#[tauri::command]
fn deck_loop_double(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_loop_double(&instance).map_err(err)
}

/// Save the current loop region as a named library loop for the track.
#[tauri::command]
fn deck_save_loop(state: State<AppState>, instance: String, name: String) -> CmdResult<i64> {
    let engine = engine_lock(&state)?;
    let status = engine.deck_status(&instance).map_err(err)?;
    let (Some(start), Some(end)) = (status.loop_start_secs, status.loop_end_secs) else {
        return Err(CmdError::invalid("no loop region set"));
    };
    let track = deck_library_track(&state, &engine, &instance)
        .ok_or_else(|| CmdError::not_found("deck track is not in the library"))?;
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
    let engine = engine_lock(&state)?;
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
    let mut engine = engine_lock(&state)?;
    engine
        .deck_set_beatgrid(&instance, bpm, anchor)
        .map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)
}

/// Tap tempo at the live playhead; the resulting grid persists.
#[tauri::command]
fn deck_tap_tempo(state: State<AppState>, instance: String) -> CmdResult<Option<(f64, f64)>> {
    let mut engine = engine_lock(&state)?;
    let grid = engine.deck_tap_tempo(&instance).map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)?;
    Ok(grid)
}

/// Nudge the beatgrid anchor by `delta` seconds.
#[tauri::command]
fn deck_nudge_beatgrid(state: State<AppState>, instance: String, delta: f64) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_nudge_beatgrid(&instance, delta).map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)
}

/// Re-anchor the beatgrid at the current playhead.
#[tauri::command]
fn deck_anchor_here(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_anchor_here(&instance).map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)
}

/// Beat-sync a deck to another deck (None clears sync).
#[tauri::command]
fn deck_sync(state: State<AppState>, instance: String, master: Option<String>) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
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
    // `custom/` in the repo checkout unless DJ_STATION_DATA_DIR says
    // otherwise; the first run there copies any pre-`custom/` platform
    // data dir across (see dj_library::paths).
    let data_dir = dj_library::init_data_dir().expect("data dir setup failed");
    let library = Arc::new(Library::open(&data_dir).expect("library open failed"));
    // A beat clip wears one name: fold the second label older records
    // carried into it, in place, before anything lists them.
    dj_analysis::clip::migrate_beat_clips(&data_dir);
    // Published macros are instantiable from the start (PRD §6).
    migrate_macros_to_store(&library);
    for def in store_macro_library().defs.into_values() {
        engine.register_macro(def);
    }
    let watcher =
        dj_library::start_watcher(library.clone(), dj_library::watch::DEFAULT_POLL_INTERVAL);
    let hub = Arc::new(AcquisitionHub::from_env());
    // Provider downloads run on their own threads (yt-dlp fetches take
    // seconds to minutes) and report progress into a polled snapshot.
    let downloads = dj_library::DownloadManager::new(library.clone(), hub.clone());
    // M3: background analysis worker. Defaults to the DSP stem separator;
    // an ONNX model can be swapped in via the `onnx` feature of
    // dj-analysis (CoreML EP on macOS, CPU EP elsewhere).
    let analysis =
        dj_analysis::start_worker(library.clone(), dj_analysis::AnalysisSettings::default());
    // Stems: htdemucs_ft through the external demucs CLI. The tooling is
    // optional — nothing here fails at startup if it is absent, the Clip
    // page just reports it (see `clip_stem_backend`). The service behind
    // them separates downloads on its own, one at a time, backfilling
    // everything a previous run never got to.
    let stems = Arc::new(dj_analysis::StemJobs::new(
        library.clone(),
        Arc::new(dj_analysis::DemucsSeparator::from_env()),
    ));
    let auto_stems = dj_analysis::AutoStemService::start(
        library.clone(),
        stems.clone(),
        dj_analysis::AutoStemSettings::from_env(),
    );

    tauri::Builder::default()
        .manage(AppState {
            engine: Mutex::new(engine),
            history: Mutex::new(UndoHistory::new()),
            library,
            hub,
            downloads,
            patch_name: Mutex::new("untitled".into()),
            deck_patch_name: Mutex::new("untitled".into()),
            last_autosave: Mutex::new(None),
            last_saved: Mutex::new([None, None]),
            _watcher: watcher,
            analysis,
            clips: clip::ClipCache::default(),
            stems,
            auto_stems,
            beatify: beatify::BeatifySession::default(),
        })
        .setup(|app| {
            // Camera module (getUserMedia) permission plumbing. macOS: wry's
            // WKUIDelegate already grants media-capture requests (the OS
            // then shows its own consent prompt, gated on the
            // NSCameraUsageDescription in Info.plist). Linux/webkitgtk has
            // no such handler and denies by default, so grant user-media
            // requests on the raw webview and enable media streams.
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                let _ = window.with_webview(|webview| {
                    let wv = webview.inner();
                    if let Some(settings) = WebViewExt::settings(&wv) {
                        settings.set_enable_media_stream(true);
                    }
                    wv.connect_permission_request(|_, request| {
                        use webkit2gtk::glib::object::Cast;
                        if let Some(user_media) =
                            request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>()
                        {
                            user_media.allow();
                            return true;
                        }
                        false
                    });
                });
            }
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
            // Launch Control XL (PRD §7.1): hot-plug watcher for the
            // control surface. No device, no thread work — it simply
            // never finds a port (CI and headless runs included).
            launch_control::spawn_watcher(app.handle().clone());
            // System menu: platform defaults (App/Edit/Window on macOS)
            // plus File (save/load) and Debug (web inspector) submenus.
            let new_patch = MenuItemBuilder::with_id("file_new", "New Patch")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
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
                .item(&new_patch)
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
            // The save targets the workspace of the page the user is ON —
            // the audio focus the frontend reports on every tab switch is
            // exactly "which page is open".
            "file_save" => {
                let state = app.state::<AppState>();
                let ws = match state.engine.lock().map(|e| e.audio_focus()) {
                    Ok(AudioFocus::Decks) => Workspace::Decks,
                    _ => Workspace::Rack,
                };
                let name = ws_name(&state, ws)
                    .lock()
                    .map(|n| n.clone())
                    .unwrap_or_else(|_| "untitled".into());
                let ws_str = match ws {
                    Workspace::Rack => None,
                    Workspace::Decks => Some("decks".to_string()),
                };
                if let Err(e) = save_patch_as(app.state::<AppState>(), name, ws_str) {
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
            // New Patch is destructive: hand it to the frontend, which
            // prompts to save/discard when there are unsaved changes and
            // then calls the new_patch command itself.
            "file_new" => {
                let _ = app.emit("dj-menu", "request-new");
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
            rename_module,
            connect_wire,
            disconnect_wire,
            load_demo_patch,
            set_knob_position,
            set_knob_config,
            set_knob_atten_offset,
            set_knob_wire_style,
            reset_knob,
            reset_module,
            reset_modules,
            apply_preset,
            copy_modules,
            paste_modules,
            remove_modules,
            set_param,
            set_module_bypass,
            tap,
            tap_all,
            jack_capture,
            save_patch,
            save_patch_as,
            new_patch,
            patch_dirty,
            list_patches,
            load_patch_by_name,
            current_patch,
            load_patch,
            list_macros,
            collapse_macro,
            rename_macro,
            delete_macro,
            pull_macro_instance,
            save_macro_instance,
            reset_macro_instance,
            macro_groups,
            macro_layout,
            macro_preview,
            break_macro,
            inject_midi,
            qwerty_key,
            launch_control::launchcontrol_status,
            launch_control::launchcontrol_set_active,
            add_midi_mapping,
            remove_midi_mapping,
            add_midi_led_mapping,
            remove_midi_led_mapping,
            choreo_status,
            choreo_set_beats,
            choreo_add_track,
            choreo_remove_track,
            choreo_rename_track,
            choreo_move_track,
            choreo_set_bool,
            choreo_set_values,
            choreo_set_note,
            choreo_set_note_settings,
            math_status,
            math_set_expr,
            hands_feed,
            undo,
            redo,
            end_edit,
            move_modules,
            sync_positions,
            engine_start,
            engine_stop,
            audio_outputs,
            set_audio_outputs,
            set_audio_focus,
            library_tracks,
            library_search,
            providers,
            search_provider,
            import_track,
            set_track_names,
            delete_track,
            import_rekordbox,
            start_download,
            download_jobs,
            open_store_page,
            open_external,
            add_watch_folder,
            watch_folders,
            playback_load,
            audio_load,
            audio_status,
            audio_waveform,
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
            clip::clip_load_source,
            clip::clip_render_preview,
            clip::clip_preview_audio,
            clip::clip_detect_beats,
            clip::clip_tap_beats,
            clip::clip_save_beat_clip,
            clip::clip_stem_backend,
            clip::clip_stem_status,
            beatify::beatify_tracker_status,
            beatify::beatify_analyze,
            beatify::beatify_set_reading,
            beatify::beatify_set_seed,
            beatify::beatify_taps,
            beatify::beatify_meters,
            beatify::beatify_preview,
            beatify::beatify_sync_check,
            beatify::beatify_scope,
            beatify::beatify_save,
            beatify::beatify_projects,
            beatify::beatify_project_new,
            beatify::beatify_project_open,
            beatify::beatify_project_set_bpm,
            beatify::beatify_seed_delete,
            beatify::beatify_seed_rename,
            beatify::beatify_project_rename,
            beatify::beatify_project_delete,
            beatify::beatify_project_audio,
            beatify::beatify_cancel,
            beatify::beatify_warp_map,
            beatify_clip::beatify_clip_sources,
            beatify_clip::beatify_clip_open,
            beatify_clip::beatify_clip_audio,
            beatify_clip::beatify_clip_preview,
            beatify_clip::beatify_clip_save,
            beatify_clip::beatify_clip_delete,
            beat_clip::beat_clip_list,
            beat_clip::beat_clip_delete,
            beat_clip::beat_clip_load,
            beat_clip::beat_clip_status,
            decks::decks_banks,
            decks::decks_ensure,
            decks::decks_status,
            decks::decks_load,
            decks::decks_clear,
            decks::decks_set_control,
            decks::decks_set_master,
            decks::decks_arm,
            decks::decks_set_tail,
            decks::decks_set_phase,
            decks::decks_set_bpm,
            decks::decks_set_surface,
            decks::decks_set_running,
            decks::decks_rehydrate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
