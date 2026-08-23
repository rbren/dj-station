//! Beat detection for Beatify (PRD §2.1).
//!
//! Two trackers behind one [`BeatTracker`] trait, mirroring the stem
//! separator split (deterministic DSP default, heavy model behind an
//! availability probe):
//!
//! - [`BeatThisTracker`] — the PRD's primary tracker, `beat_this`
//!   (CPJKU, ISMIR 2024). It is a PyTorch package, so it is an OPTIONAL
//!   runtime dependency reached through a Python subprocess (the same
//!   shape as the library's `yt-dlp` dependency): the embedded script in
//!   [`SCRIPT`] runs `File2Beats` once per seeded checkpoint and prints
//!   the beat times as JSON. Downbeats are discarded before they ever
//!   reach Rust (ANL-3).
//! - [`DspTracker`] — a deterministic fallback that always works offline:
//!   the shared onset envelope ([`crate::tempo::onset_envelope`]) plus a
//!   period estimate from [`crate::tempo::detect_tempo`], then per-beat
//!   peak picking that FOLLOWS the material (each beat snaps to the local
//!   onset peak), so genuine drift survives into the detections. It is the
//!   tested path; `beat_this` is used whenever it is installed.
//!
//! Availability is reported to the UI by [`tracker_status`] so the tab can
//! annotate itself with an install hint instead of failing. Finding the
//! model is [`probe_beat_this`]'s job: it searches for an interpreter that
//! can import the package (a `uv tool` / `pipx` environment usually, NOT
//! `python3`) and asks torch which device to use, so an installed
//! `beat_this` is used without any configuration.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use crate::decode::AudioData;
use crate::tempo;

/// Python interpreter used to reach `beat_this`. Unset means "find one"
/// ([`python_candidates`]).
pub const ENV_PYTHON: &str = "DJ_BEAT_THIS_PYTHON";
/// Torch device handed to `File2Beats` ("auto", "cpu", "cuda", "mps").
pub const ENV_DEVICE: &str = "DJ_BEAT_THIS_DEVICE";
/// Comma-separated checkpoint list; the default is the three seeds.
pub const ENV_CHECKPOINTS: &str = "DJ_BEAT_THIS_CHECKPOINTS";
/// Force the DSP fallback even when `beat_this` is importable (tests).
pub const ENV_FORCE_DSP: &str = "DJ_BEATIFY_FORCE_DSP";

pub const DEFAULT_PYTHON: &str = "python3";
/// Ask torch what the machine has (cuda > mps > cpu) instead of assuming.
pub const DEFAULT_DEVICE: &str = "auto";
/// What "auto" resolves to when nothing can be asked.
pub const FALLBACK_DEVICE: &str = "cpu";
/// ANL-1: three independently-seeded checkpoints, one inference each.
pub const DEFAULT_CHECKPOINTS: [&str; 3] = ["final0", "final1", "final2"];

pub const INSTALL_HINT: &str =
    "install it with `uv tool install beat_this`, `pipx install beat-this` or \
     `pip install beat-this torch tqdm einops soxr rotary-embedding-torch` \
     (DJ_BEAT_THIS_PYTHON pins the interpreter, DJ_BEAT_THIS_DEVICE=cuda|mps|cpu the device)";

/// One tracker pass: beat times in source seconds, ascending.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeatRun {
    /// Checkpoint / seed name ("final0", or "dsp" for the fallback).
    pub seed: String,
    pub beats: Vec<f64>,
}

/// A beat tracker. Implementations must be deterministic for a given input
/// and must return beats in ascending source-time seconds.
pub trait BeatTracker: Send + Sync {
    /// Id recorded in the payload's `analysis.tracker`.
    fn id(&self) -> String;
    /// Detect beats over `span` (source seconds; whole file when `None`).
    ///
    /// ANL-2a/MOD-A12: implementations read a few beats of context beyond
    /// the span and drop the context detections, because a hard boundary
    /// distorts the outermost beats.
    fn detect(&self, audio: &AudioData, span: Option<(f64, f64)>) -> Result<Vec<BeatRun>>;
}

/// Context read beyond a detection span before the edge beats are dropped
/// (ANL-2a). Seconds — a few beats at any sane tempo.
pub const CONTEXT_SECS: f64 = 3.0;

/// What the UI needs to decide whether to offer the model tracker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    /// Tracker actually in use ("beat_this/final0+1+2" or "dsp").
    pub tracker: String,
    /// Is `beat_this` importable?
    pub beat_this: bool,
    pub seeds: Vec<String>,
    /// Device inference will run on, already resolved ("cpu"/"mps"/"cuda").
    pub device: String,
    /// Interpreter the probe settled on (empty when none worked).
    pub python: String,
    /// Why `beat_this` is unavailable (empty when it is).
    pub detail: String,
    pub install_hint: &'static str,
}

fn env_or(name: &str, default: &str) -> String {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => default.to_string(),
    }
}

fn env_flag(name: &str) -> bool {
    matches!(std::env::var(name), Ok(v) if !v.trim().is_empty() && v != "0")
}

pub fn checkpoints() -> Vec<String> {
    match std::env::var(ENV_CHECKPOINTS) {
        Ok(v) if !v.trim().is_empty() => v
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => DEFAULT_CHECKPOINTS.iter().map(|s| s.to_string()).collect(),
    }
}

/// Probe the environment and report which tracker the tab will use.
pub fn tracker_status() -> TrackerStatus {
    if env_flag(ENV_FORCE_DSP) {
        return TrackerStatus {
            tracker: DspTracker.id(),
            beat_this: false,
            seeds: vec!["dsp".into()],
            device: FALLBACK_DEVICE.into(),
            python: String::new(),
            detail: format!("{ENV_FORCE_DSP} is set — using the built-in DSP tracker"),
            install_hint: INSTALL_HINT,
        };
    }
    match probe_beat_this() {
        Ok(probe) => TrackerStatus {
            tracker: BeatThisTracker::new().id(),
            beat_this: true,
            seeds: checkpoints(),
            device: device_for(&probe),
            python: probe.python,
            detail: String::new(),
            install_hint: INSTALL_HINT,
        },
        Err(e) => TrackerStatus {
            tracker: DspTracker.id(),
            beat_this: false,
            seeds: vec!["dsp".into()],
            device: env_device().unwrap_or_else(|| FALLBACK_DEVICE.into()),
            python: String::new(),
            detail: e.to_string(),
            install_hint: INSTALL_HINT,
        },
    }
}

/// The tracker Beatify runs: `beat_this` when installed, DSP otherwise.
pub fn default_tracker() -> Box<dyn BeatTracker> {
    if !env_flag(ENV_FORCE_DSP) && probe_beat_this().is_ok() {
        Box::new(BeatThisTracker::new())
    } else {
        Box::new(DspTracker)
    }
}

// ---------------------------------------------------------------------------
// Finding the interpreter (and the device)
// ---------------------------------------------------------------------------

/// An interpreter that can import `beat_this`, and the best device torch
/// reports there.
#[derive(Debug, Clone)]
pub struct Probe {
    pub python: String,
    pub device: String,
}

/// Import `beat_this` and ask torch what hardware it has. Both questions
/// in one interpreter start, because importing torch is seconds of work.
const PROBE_SCRIPT: &str = r#"
import json
import beat_this  # noqa: F401

device = "cpu"
try:
    import torch
    if torch.cuda.is_available():
        device = "cuda"
    elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        device = "mps"
except Exception:
    pass
print(json.dumps({"device": device}))
"#;

#[derive(Deserialize)]
struct ProbeOutput {
    device: String,
}

/// Explicit device override, if the user set one.
fn env_device() -> Option<String> {
    match std::env::var(ENV_DEVICE) {
        Ok(v) if !v.trim().is_empty() && v.trim() != DEFAULT_DEVICE => Some(v.trim().to_string()),
        _ => None,
    }
}

fn device_for(probe: &Probe) -> String {
    env_device().unwrap_or_else(|| probe.device.clone())
}

/// Successful probes, keyed by the [`ENV_PYTHON`] override in force.
///
/// Only successes are remembered: the search costs an interpreter start
/// per candidate (plus a torch import on the one that works), and it is
/// re-run on every analyze. Failures stay uncached so installing
/// `beat_this` takes effect without restarting the app.
fn probe_cache() -> &'static Mutex<HashMap<String, Probe>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Probe>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Find an interpreter that can `import beat_this`, the whole
/// availability test.
pub fn probe_beat_this() -> Result<Probe> {
    let key = std::env::var(ENV_PYTHON).unwrap_or_default();
    if let Ok(cache) = probe_cache().lock() {
        if let Some(hit) = cache.get(&key) {
            return Ok(hit.clone());
        }
    }
    let candidates = python_candidates();
    let mut detail = String::from("no Python interpreter found");
    for python in &candidates {
        match run_probe(python) {
            Ok(device) => {
                let probe = Probe {
                    python: python.clone(),
                    device,
                };
                if let Ok(mut cache) = probe_cache().lock() {
                    cache.insert(key, probe.clone());
                }
                return Ok(probe);
            }
            Err(e) => detail = e.to_string(),
        }
    }
    Err(anyhow!(
        "beat_this not importable ({detail}); tried {} — {INSTALL_HINT}",
        candidates.join(", ")
    ))
}

fn run_probe(python: &str) -> Result<String> {
    let out = Command::new(python)
        .args(["-c", PROBE_SCRIPT])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow!("`{python}` not found")
            } else {
                anyhow!("running {python}: {e}")
            }
        })?;
    if !out.status.success() {
        let text = String::from_utf8_lossy(&out.stderr);
        let last = text
            .lines()
            .rfind(|l| !l.trim().is_empty())
            .unwrap_or("import failed");
        return Err(anyhow!("{python}: {last}"));
    }
    let parsed: ProbeOutput = serde_json::from_slice(&out.stdout).unwrap_or(ProbeOutput {
        device: FALLBACK_DEVICE.into(),
    });
    Ok(parsed.device)
}

/// Interpreters tried, in order, when [`ENV_PYTHON`] is unset.
///
/// `beat_this` is normally installed into an environment of its own —
/// `uv tool install beat_this`, `pipx install beat-this`, a venv — so
/// plain `python3` usually CANNOT import it even though the machine has
/// it. Worse, a macOS app launched from Finder inherits
/// `/usr/bin:/bin:/usr/sbin:/sbin`, so the tool's own `bin` directory is
/// not even on `PATH`. The search therefore starts from a `beat_this`
/// launcher (its shebang names the interpreter that owns the package),
/// then the known tool roots, and only then the PATH interpreters.
pub fn python_candidates() -> Vec<String> {
    if let Ok(v) = std::env::var(ENV_PYTHON) {
        if !v.trim().is_empty() {
            return vec![v.trim().to_string()];
        }
    }
    let mut out: Vec<String> = Vec::new();
    for dir in launcher_dirs() {
        for python in interpreters_from_launcher(&dir) {
            push_unique(&mut out, python.to_string_lossy().into_owned());
        }
    }
    for python in tool_env_pythons() {
        if python.exists() {
            push_unique(&mut out, python.to_string_lossy().into_owned());
        }
    }
    push_unique(&mut out, DEFAULT_PYTHON.into());
    push_unique(&mut out, "python".into());
    for python in [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ] {
        if Path::new(python).exists() {
            push_unique(&mut out, python.into());
        }
    }
    out
}

fn push_unique(out: &mut Vec<String>, value: String) {
    if !out.contains(&value) {
        out.push(value);
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Where a `beat_this` launcher script might live: `PATH`, plus the
/// user-local bin directories a GUI process does not inherit.
fn launcher_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    if let Some(home) = home() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join("bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

/// Interpreters implied by a `beat_this` launcher in `dir`: the one named
/// in its shebang (console scripts point straight at their venv's python)
/// and, if the launcher resolves into a venv, that venv's python.
pub fn interpreters_from_launcher(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for name in ["beat_this", "beat-this"] {
        let launcher = dir.join(name);
        if !launcher.exists() {
            continue;
        }
        let resolved = std::fs::canonicalize(&launcher).unwrap_or(launcher);
        if let Some(python) = shebang_interpreter(&resolved) {
            if python.exists() && !out.contains(&python) {
                out.push(python);
            }
        }
        if let Some(bin) = resolved.parent() {
            for python in ["python3", "python"] {
                let sibling = bin.join(python);
                if sibling.exists() && !out.contains(&sibling) {
                    out.push(sibling);
                }
            }
        }
    }
    out
}

/// The interpreter named on a script's `#!` line, when it is an absolute
/// path. `#!/usr/bin/env python3` is skipped: it means "whatever `PATH`
/// says", which is tried anyway.
fn shebang_interpreter(script: &Path) -> Option<PathBuf> {
    let mut buf = [0u8; 256];
    let read = std::fs::File::open(script).ok()?.read(&mut buf).ok()?;
    let line = std::str::from_utf8(&buf[..read]).ok()?.lines().next()?;
    let mut words = line.strip_prefix("#!")?.split_whitespace();
    let first = words.next()?;
    let interpreter = if Path::new(first).file_name()?.to_str()? == "env" {
        words.next()?
    } else {
        first
    };
    let path = PathBuf::from(interpreter);
    path.is_absolute().then_some(path)
}

/// `uv tool` / `pipx` environments for the package, for the case where
/// the launcher itself was installed somewhere we do not look.
fn tool_env_pythons() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut add_root = |root: PathBuf| {
        if !roots.contains(&root) {
            roots.push(root);
        }
    };
    if let Some(dir) = std::env::var_os("UV_TOOL_DIR") {
        add_root(PathBuf::from(dir));
    }
    if let Some(dir) = std::env::var_os("PIPX_HOME") {
        add_root(PathBuf::from(dir).join("venvs"));
    }
    if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
        add_root(PathBuf::from(&data).join("uv/tools"));
        add_root(PathBuf::from(&data).join("pipx/venvs"));
    }
    if let Some(home) = home() {
        add_root(home.join(".local/share/uv/tools"));
        add_root(home.join(".local/share/pipx/venvs"));
        add_root(home.join(".local/pipx/venvs"));
        add_root(home.join("Library/Application Support/uv/tools"));
    }
    roots
        .iter()
        .flat_map(|root| {
            ["beat-this", "beat_this"]
                .into_iter()
                .flat_map(move |name| {
                    ["python3", "python"]
                        .into_iter()
                        .map(move |python| root.join(name).join("bin").join(python))
                })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// beat_this (optional, out of process)
// ---------------------------------------------------------------------------

/// The helper run by the interpreter. Kept tiny on purpose: it loads one
/// checkpoint at a time, discards the downbeats (ANL-3) and prints JSON.
pub const SCRIPT: &str = r#"
import json, sys
from beat_this.inference import File2Beats

path, device = sys.argv[1], sys.argv[2]
if device in ("", "auto"):
    import torch
    if torch.cuda.is_available():
        device = "cuda"
    elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"


def track(ckpt, dev):
    return File2Beats(checkpoint_path=ckpt, device=dev, dbn=False)(path)[0]


runs = []
for ckpt in sys.argv[3].split(","):
    try:
        beats = track(ckpt, device)
    except Exception:
        # An accelerator missing an op is a machine detail, not a failed
        # analysis: the CPU path gives the same beats, slower.
        if device == "cpu":
            raise
        device = "cpu"
        beats = track(ckpt, device)
    runs.append({"seed": ckpt, "beats": [float(b) for b in beats]})
json.dump({"runs": runs, "device": device}, sys.stdout)
"#;

pub struct BeatThisTracker {
    python: String,
    device: String,
    seeds: Vec<String>,
}

impl BeatThisTracker {
    /// The tracker as the machine can actually run it: the interpreter the
    /// probe found and the device torch reports there (both overridable).
    pub fn new() -> Self {
        let probe = probe_beat_this().ok();
        BeatThisTracker {
            python: probe
                .as_ref()
                .map(|p| p.python.clone())
                .unwrap_or_else(|| env_or(ENV_PYTHON, DEFAULT_PYTHON)),
            device: probe
                .as_ref()
                .map(device_for)
                .unwrap_or_else(|| env_device().unwrap_or_else(|| DEFAULT_DEVICE.into())),
            seeds: checkpoints(),
        }
    }

    /// Point at a specific interpreter (tests use a fake `beat_this`).
    pub fn with_python(python: &str) -> Self {
        BeatThisTracker {
            python: python.into(),
            device: env_device().unwrap_or_else(|| DEFAULT_DEVICE.into()),
            seeds: checkpoints(),
        }
    }

    pub fn python(&self) -> &str {
        &self.python
    }

    pub fn device(&self) -> &str {
        &self.device
    }
}

impl Default for BeatThisTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
struct ScriptOutput {
    runs: Vec<BeatRun>,
}

impl BeatTracker for BeatThisTracker {
    fn id(&self) -> String {
        format!("beat_this/{}", self.seeds.join("+"))
    }

    fn detect(&self, audio: &AudioData, span: Option<(f64, f64)>) -> Result<Vec<BeatRun>> {
        // The model reads a file, so the (context-extended) span is written
        // out as a temporary wav.
        let (lo, hi) = context_span(audio, span);
        let clip = crate::clip::slice(audio, lo, hi - lo);
        let temp = TempWav::write(&clip)?;
        let out = Command::new(&self.python)
            .arg("-c")
            .arg(SCRIPT)
            .arg(temp.path())
            .arg(&self.device)
            .arg(self.seeds.join(","))
            // Apple's backend is missing ops the model uses; without this
            // they raise instead of running on the CPU.
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    anyhow!("`{}` not found — {INSTALL_HINT}", self.python)
                } else {
                    anyhow!("running {}: {e}", self.python)
                }
            })?;
        if !out.status.success() {
            let text = String::from_utf8_lossy(&out.stderr);
            let detail = text
                .lines()
                .rfind(|l| !l.trim().is_empty())
                .unwrap_or("no output");
            return Err(anyhow!("beat_this failed ({}): {detail}", out.status));
        }
        let parsed: ScriptOutput =
            serde_json::from_slice(&out.stdout).context("parsing beat_this output")?;
        Ok(parsed
            .runs
            .into_iter()
            .map(|run| BeatRun {
                seed: run.seed,
                beats: trim_context(run.beats.iter().map(|b| b + lo), span),
            })
            .collect())
    }
}

/// A wav file that deletes itself when dropped.
struct TempWav(PathBuf);

impl TempWav {
    fn write(audio: &AudioData) -> Result<Self> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path =
            std::env::temp_dir().join(format!("dj-beatify-{}-{stamp}.wav", std::process::id()));
        std::fs::write(&path, crate::clip::wav16_bytes(audio))
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(TempWav(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

// ---------------------------------------------------------------------------
// DSP fallback
// ---------------------------------------------------------------------------

/// Fraction of the beat period searched around each predicted beat.
const SNAP_WINDOW: f64 = 0.3;
/// How strongly a snapped beat pulls the running period (drift tracking).
const PERIOD_ADAPT: f64 = 0.25;

#[derive(Debug, Default, Clone, Copy)]
pub struct DspTracker;

impl BeatTracker for DspTracker {
    fn id(&self) -> String {
        "dsp".into()
    }

    fn detect(&self, audio: &AudioData, span: Option<(f64, f64)>) -> Result<Vec<BeatRun>> {
        let (lo, hi) = context_span(audio, span);
        let clip = crate::clip::slice(audio, lo, hi - lo);
        let mono = clip.mono_mix();
        let sr = clip.sample_rate;
        let seed = tempo::detect_tempo(&mono, sr)
            .ok_or_else(|| anyhow!("no beats detected in that region"))?;
        let env = tempo::onset_envelope(&mono, sr);
        let beats = trim_weak_edges(&env, follow_beats(&env, 60.0 / seed.bpm, seed.anchor_secs));
        if beats.len() < 4 {
            return Err(anyhow!("too few beats detected in that region"));
        }
        Ok(vec![BeatRun {
            seed: "dsp".into(),
            beats: trim_context(beats.into_iter().map(|b| b + lo), span),
        }])
    }
}

/// Walk the onset envelope beat by beat, snapping each to the local peak
/// and letting the period follow what was found — the drift the grid fit
/// then measures and the warp removes.
fn follow_beats(env: &tempo::OnsetEnvelope, period_secs: f64, anchor_secs: f64) -> Vec<f64> {
    let flux = &env.flux;
    if flux.is_empty() || period_secs <= 0.0 {
        return Vec::new();
    }
    let end_secs = env.frame_secs(flux.len() as f64 - 1.0);
    let mut beats: Vec<f64> = Vec::new();
    let mut period = period_secs;
    let first_secs = env.frame_secs(0.0);
    let mut t = anchor_secs;
    while t < first_secs {
        t += period;
    }
    while t <= end_secs {
        match snap_to_peak(env, t, period * SNAP_WINDOW) {
            Some(found) => {
                if let Some(&prev) = beats.last() {
                    let observed = found - prev;
                    // Only believe intervals close to the running period; a
                    // wild one means the peak pick moved, not the tempo.
                    if (observed - period).abs() < 0.2 * period {
                        period += PERIOD_ADAPT * (observed - period);
                    }
                }
                beats.push(found);
                t = found + period;
            }
            None => {
                beats.push(t);
                t += period;
            }
        }
    }
    beats
}

/// Onset strength (relative to the median beat) below which an edge beat
/// is not a beat at all — the run-in before the music starts and the
/// run-out after it stops.
const EDGE_STRENGTH: f32 = 0.25;

/// Drop leading and trailing beats that carry no onset. The follower
/// coasts through silence at the running period, which is right in the
/// middle of a track and wrong at its edges.
fn trim_weak_edges(env: &tempo::OnsetEnvelope, beats: Vec<f64>) -> Vec<f64> {
    let strength = |t: f64| -> f32 {
        let frame = env.secs_frame(t).round();
        if frame < 0.0 || frame >= env.flux.len() as f64 {
            return 0.0;
        }
        env.flux[frame as usize]
    };
    let mut sorted: Vec<f32> = beats.iter().map(|t| strength(*t)).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if sorted.is_empty() {
        return beats;
    }
    let floor = sorted[sorted.len() / 2] * EDGE_STRENGTH;
    let start = beats.iter().position(|t| strength(*t) >= floor);
    let end = beats.iter().rposition(|t| strength(*t) >= floor);
    match (start, end) {
        (Some(a), Some(b)) if a <= b => beats[a..=b].to_vec(),
        _ => beats,
    }
}

/// Strongest onset peak within `radius` seconds of `t`, parabolically
/// interpolated; `None` when the window is flat (no onset to snap to).
fn snap_to_peak(env: &tempo::OnsetEnvelope, t: f64, radius: f64) -> Option<f64> {
    let flux = &env.flux;
    let center = env.secs_frame(t);
    let r = (radius * env.rate).max(1.0);
    let lo = (center - r).floor().max(0.0) as usize;
    let hi = ((center + r).ceil() as usize).min(flux.len().saturating_sub(1));
    if lo >= hi {
        return None;
    }
    let mut best = lo;
    for i in lo..=hi {
        if flux[i] > flux[best] {
            best = i;
        }
    }
    if flux[best] <= 0.0 {
        return None;
    }
    let frame = if best > 0 && best + 1 < flux.len() {
        let (a, b, c) = (
            flux[best - 1] as f64,
            flux[best] as f64,
            flux[best + 1] as f64,
        );
        let denom = a - 2.0 * b + c;
        if denom.abs() < 1e-12 {
            best as f64
        } else {
            best as f64 + 0.5 * (a - c) / denom
        }
    } else {
        best as f64
    };
    Some(env.frame_secs(frame))
}

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

/// The span actually handed to a tracker: the requested region plus
/// [`CONTEXT_SECS`] on each side, clamped to the file (ANL-2a).
pub fn context_span(audio: &AudioData, span: Option<(f64, f64)>) -> (f64, f64) {
    let dur = audio.duration_secs();
    match span {
        None => (0.0, dur),
        Some((a, b)) => {
            let (a, b) = if a <= b { (a, b) } else { (b, a) };
            (
                (a - CONTEXT_SECS).max(0.0),
                (b + CONTEXT_SECS).min(dur).max(0.0),
            )
        }
    }
}

/// Drop the context detections: only beats inside the requested span
/// survive (ANL-2a). Beats arrive in source seconds.
fn trim_context(beats: impl Iterator<Item = f64>, span: Option<(f64, f64)>) -> Vec<f64> {
    match span {
        None => beats.collect(),
        Some((a, b)) => {
            let (a, b) = if a <= b { (a, b) } else { (b, a) };
            beats.filter(|t| *t >= a && *t <= b).collect()
        }
    }
}
