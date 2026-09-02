//! Demucs stem separation (PRD §8.2): production-quality stems from the
//! `htdemucs_ft` model.
//!
//! The app's DEFAULT model backend, because it is the faster of the two:
//! [`ScnetSeparator`](crate::scnet::ScnetSeparator) separates better but
//! takes long enough that a whole library is a different proposition, so
//! SCNet is picked per track (`chosen-model`, see
//! [`choose_separator`](crate::stems::choose_separator)) rather than run
//! over everything.
//!
//! Unlike [`BandSeparator`](crate::stems::BandSeparator) (pure DSP, always
//! available) and `OnnxSeparator` (needs a hand-exported `.onnx` graph),
//! this backend drives the **external `demucs` CLI** — the same shape as
//! the library's `yt-dlp` provider:
//!
//! ```text
//! demucs -n htdemucs_ft --out <tmp> <input.wav>
//!   → <tmp>/htdemucs_ft/<stem-name>/{vocals,drums,bass,other}.wav
//! ```
//!
//! That is the only officially supported way to run `htdemucs_ft`: its
//! weights ship as four bag-of-models checkpoints that the Python package
//! downloads and caches itself, so there is nothing for us to vendor.
//!
//! `demucs` is an OPTIONAL runtime dependency, provisioned by
//! `scripts/install-demucs.sh` into the app's data dir. When it is missing
//! every call fails with an install hint instead of panicking, and
//! [`DemucsSeparator::probe`] reports that up-front so the UI can say so
//! rather than starting a job that cannot finish. Point `DJ_DEMUCS_BIN` at
//! a specific binary (e.g. a venv's `demucs`, or `python -m demucs` via a
//! wrapper script) and `DJ_DEMUCS_MODEL` at another model name.
//!
//! Separation is minutes of CPU work: nothing here may run on the RT or UI
//! thread. Callers go through [`StemJobs`](crate::stem_jobs::StemJobs).

use anyhow::{anyhow, bail, Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::decode::{decode_audio, AudioData};
use crate::stems::{
    conform_to_source, tool_failure, CancelToken, StemSeparator, Stems, N_STEMS, STEM_NAMES,
};

/// Override the `demucs` binary (name on `PATH` or absolute path).
pub const ENV_DEMUCS_BIN: &str = "DJ_DEMUCS_BIN";
/// Override the model name passed to `-n` (default [`DEFAULT_MODEL`]).
pub const ENV_DEMUCS_MODEL: &str = "DJ_DEMUCS_MODEL";
/// Extra whitespace-separated flags added to every invocation — the escape
/// hatch for machine-specific needs (`--device cuda`, `--segment 8`, ...).
pub const ENV_DEMUCS_ARGS: &str = "DJ_DEMUCS_ARGS";

pub const DEFAULT_BIN: &str = "demucs";
/// Subdirectory of the data dir the provisioning script installs into.
pub const DEMUCS_DIR: &str = "demucs";
/// The fine-tuned Hybrid Transformer Demucs: slower than `htdemucs` (it is
/// a bag of four specialised models) but the best separation demucs ships.
pub const DEFAULT_MODEL: &str = "htdemucs_ft";

/// Stem separation by the external `demucs` CLI.
#[derive(Debug, Clone)]
pub struct DemucsSeparator {
    bin: String,
    model: String,
    extra_args: Vec<String>,
}

impl Default for DemucsSeparator {
    fn default() -> Self {
        Self::from_env()
    }
}

impl DemucsSeparator {
    /// Configure from the environment (see the `DJ_DEMUCS_*` constants),
    /// resolving the binary under the app's data dir.
    pub fn from_env() -> Self {
        Self::from_env_in(&dj_library::paths::default_data_dir())
    }

    /// [`from_env`](Self::from_env) against an explicit data dir — the app
    /// already resolved one (and may have been pointed elsewhere by
    /// `DJ_STATION_DATA_DIR`).
    pub fn from_env_in(data_dir: &Path) -> Self {
        DemucsSeparator {
            bin: env_path(ENV_DEMUCS_BIN)
                .unwrap_or_else(|| default_bin(&data_dir.join(DEMUCS_DIR))),
            model: env_or(ENV_DEMUCS_MODEL, DEFAULT_MODEL),
            extra_args: std::env::var(ENV_DEMUCS_ARGS)
                .unwrap_or_default()
                .split_whitespace()
                .map(str::to_string)
                .collect(),
        }
    }

    /// Point at a specific binary and model (tests use a fake script).
    pub fn with_bin(bin: &str, model: &str) -> Self {
        DemucsSeparator {
            bin: bin.into(),
            model: model.into(),
            extra_args: Vec::new(),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn bin(&self) -> &str {
        &self.bin
    }

    fn spawn_error(&self, e: std::io::Error) -> anyhow::Error {
        if e.kind() == std::io::ErrorKind::NotFound {
            anyhow!(
                "`{}` not found — run scripts/install-demucs.sh (or set \
                 {ENV_DEMUCS_BIN} to a demucs of your own)",
                self.bin
            )
        } else {
            anyhow::Error::new(e).context(format!("running {}", self.bin))
        }
    }

    /// Run the CLI over `input`, returning the directory demucs filled.
    ///
    /// The child is handed to `cancel` so a cancelled job can kill it; the
    /// run is minutes long, and the process is the only thing that can be
    /// stopped. Its stderr is drained on this thread while it works —
    /// demucs writes a progress bar there, and an unread pipe would wedge
    /// it once the buffer filled.
    fn run(&self, input: &Path, out_dir: &Path, cancel: &CancelToken) -> Result<()> {
        let mut child = Command::new(&self.bin)
            .args(["-n", &self.model])
            .arg("--out")
            .arg(out_dir)
            .args(&self.extra_args)
            .arg(input)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| self.spawn_error(e))?;
        let mut pipe = child.stderr.take().expect("stderr is piped");
        cancel.adopt(child);

        // Drained on its own thread rather than here: waiting for EOF
        // would outlive a cancel, because demucs' `-j` workers inherit the
        // pipe and hold it open after their parent is killed.
        let reader = std::thread::spawn(move || {
            let mut stderr = Vec::new();
            let _ = pipe.read_to_end(&mut stderr);
            stderr
        });
        let status = cancel
            .wait_child()
            .with_context(|| format!("waiting for {}", self.bin))?
            .expect("the child was adopted");
        if cancel.is_cancelled() {
            // The reader ends when the last writer does; nobody is
            // waiting on it now.
            return Ok(());
        }
        let stderr = reader.join().unwrap_or_default();
        if !status.success() {
            bail!("{}", tool_failure(&self.bin, &stderr, status));
        }
        Ok(())
    }
}

fn env_or(key: &str, default: &str) -> String {
    env_path(key).unwrap_or_else(|| default.to_string())
}

/// A non-empty environment override.
fn env_path(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The provisioning script's venv when it is there, else whatever `demucs`
/// is on `PATH`: an app launched from Finder does not inherit a user's
/// tool directories, so the binary in the data dir is the one to prefer.
fn default_bin(home: &Path) -> String {
    let venv = home.join("venv").join("bin").join(DEFAULT_BIN);
    if venv.is_file() {
        return venv.to_string_lossy().into_owned();
    }
    DEFAULT_BIN.to_string()
}

/// Locate `<out>/<model>/<track>/<stem>.wav`. demucs derives the track
/// directory from the input file stem, but it also rewrites some
/// characters, so the single subdirectory it produced is authoritative.
fn stem_files(out_dir: &Path, model: &str) -> Result<[PathBuf; N_STEMS]> {
    let model_dir = out_dir.join(model);
    let track_dir = std::fs::read_dir(&model_dir)
        .with_context(|| format!("demucs produced no output under {}", model_dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.is_dir())
        .ok_or_else(|| {
            anyhow!(
                "demucs produced no stem directory in {}",
                model_dir.display()
            )
        })?;

    let paths: [PathBuf; N_STEMS] = std::array::from_fn(|i| {
        let wav = track_dir.join(format!("{}.wav", STEM_NAMES[i]));
        if wav.is_file() {
            wav
        } else {
            // `--mp3`/`--flac` users, and future demucs defaults.
            for ext in ["flac", "mp3"] {
                let p = track_dir.join(format!("{}.{ext}", STEM_NAMES[i]));
                if p.is_file() {
                    return p;
                }
            }
            wav
        }
    });
    for (path, name) in paths.iter().zip(STEM_NAMES) {
        if !path.is_file() {
            bail!(
                "demucs did not write a {name} stem ({} missing) — does model `{}` output \
                 the standard four stems?",
                path.display(),
                model
            );
        }
    }
    Ok(paths)
}

impl StemSeparator for DemucsSeparator {
    /// The model name keys the stem cache, so `htdemucs_ft` stems never
    /// collide with another model's (or the DSP fallback's).
    fn id(&self) -> &str {
        &self.model
    }

    fn separate(&self, audio: &AudioData) -> Result<Stems> {
        self.separate_cancellable(audio, &CancelToken::new())
    }

    /// Runs `demucs --help`, which is cheap and needs no weights (the
    /// model downloads itself lazily on the first separation). `Err`
    /// carries a user-facing install hint.
    fn probe(&self) -> Result<()> {
        let out = Command::new(&self.bin)
            .arg("--help")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| self.spawn_error(e))?;
        if !out.status.success() {
            bail!("{}", tool_failure(&self.bin, &out.stderr, out.status));
        }
        Ok(())
    }

    fn separate_cancellable(&self, audio: &AudioData, cancel: &CancelToken) -> Result<Stems> {
        let frames = audio.frames();
        let channels = audio.channels.len();
        anyhow::ensure!(channels >= 1 && frames > 0, "empty audio");

        let tmp = tempfile::tempdir().context("creating a demucs work directory")?;
        let input = tmp.path().join("input.wav");
        std::fs::write(&input, crate::clip::wav16_bytes(audio))
            .with_context(|| format!("writing {}", input.display()))?;

        let out_dir = tmp.path().join("out");
        self.run(&input, &out_dir, cancel)?;
        // A killed run left a half-written output tree behind; the caller
        // discards cancelled stems, so hand back something shaped right
        // rather than an error about demucs producing nothing.
        if cancel.is_cancelled() {
            return Ok(Stems(std::array::from_fn(|_| AudioData {
                sample_rate: audio.sample_rate,
                channels: vec![Vec::new(); channels],
            })));
        }

        let paths = stem_files(&out_dir, &self.model)?;
        let mut decoded = Vec::with_capacity(N_STEMS);
        for (path, name) in paths.iter().zip(STEM_NAMES) {
            let stem = decode_audio(path).with_context(|| format!("reading the {name} stem"))?;
            decoded.push(conform_to_source(stem, audio.sample_rate, frames, channels));
        }
        let stems: [AudioData; N_STEMS] = decoded
            .try_into()
            .map_err(|_| anyhow!("demucs returned the wrong number of stems"))?;
        Ok(Stems(stems))
    }
}
