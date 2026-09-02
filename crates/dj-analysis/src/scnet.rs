//! SCNet XL IHF stem separation (PRD §8.2): the app's production stem
//! model, replacing the `htdemucs_ft` demucs CLI it used before (SDR 10.09
//! vs 9.0 on MUSDB18, and better on everything but bass).
//!
//! Unlike [`BandSeparator`](crate::stems::BandSeparator) (pure DSP, always
//! available) and `OnnxSeparator` (needs a hand-exported `.onnx` graph),
//! this backend drives an **external Python CLI** — the same shape as
//! `beat_this` and the library's `yt-dlp` provider. SCNet has no packaged
//! CLI of its own: the weights are an MSST (Music Source Separation
//! Training) checkpoint, and MSST's own `inference` module is the only
//! supported way to run them:
//!
//! ```text
//! python -m inference --model_type scnet --config_path <cfg>
//!     --start_check_point <ckpt> --input_folder <tmp>/in --store_dir <tmp>/out
//!   → <tmp>/out/input/{vocals,drums,bass,other}.wav
//! ```
//!
//! Both the interpreter (MSST + torch) and the ~214 MB checkpoint are
//! OPTIONAL runtime dependencies — `scripts/install-scnet.sh` provisions
//! them under the data dir. When either is missing every call fails with
//! an install hint instead of panicking, and [`ScnetSeparator::probe`]
//! reports that up-front so the UI can say so rather than starting a job
//! that cannot finish.
//!
//! Separation is minutes of CPU work: nothing here may run on the RT or
//! UI thread. Callers go through [`StemJobs`](crate::stem_jobs::StemJobs).

use anyhow::{anyhow, bail, Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::decode::{decode_audio, AudioData};
use crate::stems::{CancelToken, StemSeparator, Stems, N_STEMS, STEM_NAMES};

/// Override the Python interpreter that can `import inference` (MSST).
pub const ENV_SCNET_PYTHON: &str = "DJ_SCNET_PYTHON";
/// Override the model config YAML (default: [`CONFIG_FILE`] under the
/// data dir's [`SCNET_DIR`]).
pub const ENV_SCNET_CONFIG: &str = "DJ_SCNET_CONFIG";
/// Override the model checkpoint (default: [`CHECKPOINT_FILE`] there).
pub const ENV_SCNET_CKPT: &str = "DJ_SCNET_CKPT";
/// Override the separator id, which keys the stem cache. Change it
/// whenever the config/checkpoint point at a different model, so two
/// models never share a cache directory.
pub const ENV_SCNET_MODEL: &str = "DJ_SCNET_MODEL";
/// Extra whitespace-separated flags added to every invocation — the escape
/// hatch for machine-specific needs (`--device_ids 0`, `--use_tta`, ...).
pub const ENV_SCNET_ARGS: &str = "DJ_SCNET_ARGS";

/// Separator id, and the name of the model directory under the data dir.
pub const DEFAULT_MODEL: &str = "scnet_xl_ihf";
/// Where the tooling and weights live: `<data_dir>/scnet/`.
pub const SCNET_DIR: &str = "scnet";
pub const CONFIG_FILE: &str = "config.yaml";
pub const CHECKPOINT_FILE: &str = "model.ckpt";
/// Interpreter used when nothing else is configured and the provisioning
/// script's venv is absent.
pub const DEFAULT_PYTHON: &str = "python3";
/// MSST's inference entry point, run as a module.
pub const INFERENCE_MODULE: &str = "inference";
/// MSST architecture name for the SCNet family.
pub const MODEL_TYPE: &str = "scnet";

const INSTALL_HINT: &str = "run scripts/install-scnet.sh (MSST + torch + the SCNet XL IHF \
     checkpoint), or point DJ_SCNET_PYTHON / DJ_SCNET_CONFIG / DJ_SCNET_CKPT at an existing install";

/// Stem separation by MSST's `inference` CLI, running SCNet XL IHF.
#[derive(Debug, Clone)]
pub struct ScnetSeparator {
    python: String,
    config: PathBuf,
    checkpoint: PathBuf,
    model: String,
    extra_args: Vec<String>,
}

impl Default for ScnetSeparator {
    fn default() -> Self {
        Self::from_env()
    }
}

impl ScnetSeparator {
    /// Configure from the environment, with everything unset resolved
    /// under the app's data dir (see the `DJ_SCNET_*` constants).
    pub fn from_env() -> Self {
        Self::from_env_in(&dj_library::paths::default_data_dir())
    }

    /// [`from_env`](Self::from_env) against an explicit data dir — the
    /// app already resolved one (and may have been pointed elsewhere by
    /// `DJ_STATION_DATA_DIR`).
    pub fn from_env_in(data_dir: &Path) -> Self {
        let home = data_dir.join(SCNET_DIR);
        ScnetSeparator {
            python: env_path(ENV_SCNET_PYTHON).unwrap_or_else(|| default_python(&home)),
            config: env_path(ENV_SCNET_CONFIG)
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(CONFIG_FILE)),
            checkpoint: env_path(ENV_SCNET_CKPT)
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(CHECKPOINT_FILE)),
            model: env_path(ENV_SCNET_MODEL).unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            extra_args: std::env::var(ENV_SCNET_ARGS)
                .unwrap_or_default()
                .split_whitespace()
                .map(str::to_string)
                .collect(),
        }
    }

    /// Point at a specific interpreter and model files (tests use a fake
    /// script in place of the interpreter).
    pub fn with_model(python: &str, config: &Path, checkpoint: &Path) -> Self {
        ScnetSeparator {
            python: python.into(),
            config: config.into(),
            checkpoint: checkpoint.into(),
            model: DEFAULT_MODEL.into(),
            extra_args: Vec::new(),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn python(&self) -> &str {
        &self.python
    }

    fn spawn_error(&self, e: std::io::Error) -> anyhow::Error {
        if e.kind() == std::io::ErrorKind::NotFound {
            anyhow!("`{}` not found — {INSTALL_HINT}", self.python)
        } else {
            anyhow::Error::new(e).context(format!("running {}", self.python))
        }
    }

    /// The weights this backend needs, or a user-facing install hint.
    fn check_weights(&self) -> Result<()> {
        for (what, path) in [("config", &self.config), ("checkpoint", &self.checkpoint)] {
            if !path.is_file() {
                bail!(
                    "the SCNet XL IHF {what} is missing ({}) — {INSTALL_HINT}",
                    path.display()
                );
            }
        }
        Ok(())
    }

    /// Run MSST inference over `input_dir`, filling `out_dir`.
    ///
    /// The child is handed to `cancel` so a cancelled job can kill it; the
    /// run is minutes long, and the process is the only thing that can be
    /// stopped. Its stderr is drained on another thread while it works —
    /// inference writes a progress bar there, and an unread pipe would
    /// wedge it once the buffer filled.
    fn run(&self, input_dir: &Path, out_dir: &Path, cancel: &CancelToken) -> Result<()> {
        let mut child = Command::new(&self.python)
            .args(["-m", INFERENCE_MODULE, "--model_type", MODEL_TYPE])
            .arg("--config_path")
            .arg(&self.config)
            .arg("--start_check_point")
            .arg(&self.checkpoint)
            .arg("--input_folder")
            .arg(input_dir)
            .arg("--store_dir")
            .arg(out_dir)
            .arg("--disable_detailed_pbar")
            .args(&self.extra_args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| self.spawn_error(e))?;
        let mut pipe = child.stderr.take().expect("stderr is piped");
        cancel.adopt(child);

        // Drained on its own thread rather than here: waiting for EOF
        // would outlive a cancel, because torch's worker processes
        // inherit the pipe and hold it open after their parent is killed.
        let reader = std::thread::spawn(move || {
            let mut stderr = Vec::new();
            let _ = pipe.read_to_end(&mut stderr);
            stderr
        });
        let status = cancel
            .wait_child()
            .with_context(|| format!("waiting for {}", self.python))?
            .expect("the child was adopted");
        if cancel.is_cancelled() {
            // The reader ends when the last writer does; nobody is
            // waiting on it now.
            return Ok(());
        }
        let stderr = reader.join().unwrap_or_default();
        if !status.success() {
            bail!("{}", tool_failure(&self.python, &stderr, status));
        }
        Ok(())
    }
}

/// A non-empty environment override.
fn env_path(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The provisioning script's venv when it is there, else `python3`: an
/// app launched from Finder does not inherit a user's tool directories,
/// so the interpreter beside the weights is the one to prefer.
fn default_python(home: &Path) -> String {
    let venv = home.join("venv").join("bin").join("python");
    if venv.is_file() {
        return venv.to_string_lossy().into_owned();
    }
    DEFAULT_PYTHON.to_string()
}

fn tool_failure(bin: &str, stderr: &[u8], status: std::process::ExitStatus) -> String {
    let text = String::from_utf8_lossy(stderr);
    let detail = text
        .lines()
        .rfind(|l| !l.trim().is_empty())
        .unwrap_or("no output");
    format!("{bin} failed ({status}): {detail}")
}

/// Locate the four stems MSST wrote under `out_dir`.
///
/// Its default template puts them in a per-track subdirectory
/// (`<out>/<track>/vocals.wav`), older versions and a custom
/// `--filename_template` flatten them (`<out>/input_vocals.wav`), so the
/// search is by file name across the tree rather than by exact path.
fn stem_files(out_dir: &Path) -> Result<[PathBuf; N_STEMS]> {
    let mut found: [Option<PathBuf>; N_STEMS] = std::array::from_fn(|_| None);
    let mut stack = vec![out_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .with_context(|| format!("SCNet produced no output under {}", dir.display()))?;
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Some(name) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !matches!(ext.as_str(), "wav" | "flac" | "mp3") {
                continue;
            }
            for (i, stem) in STEM_NAMES.iter().enumerate() {
                let matches = name == *stem || name.ends_with(&format!("_{stem}"));
                if matches && found[i].is_none() {
                    found[i] = Some(path.clone());
                }
            }
        }
    }
    let mut paths = Vec::with_capacity(N_STEMS);
    for (slot, name) in found.into_iter().zip(STEM_NAMES) {
        paths.push(slot.ok_or_else(|| {
            anyhow!(
                "SCNet did not write a {name} stem under {} — does the configured model output \
                 the standard four stems?",
                out_dir.display()
            )
        })?);
    }
    paths
        .try_into()
        .map_err(|_| anyhow!("SCNet returned the wrong number of stems"))
}

/// Fit a decoded stem back onto the source's timebase: the model works at
/// its config's rate (44.1 kHz), so a 48 kHz track comes back resampled
/// and a frame or two short/long. The [`StemSeparator`] contract is that
/// stems line up with the input sample-for-sample (the deck plays them
/// against it).
fn conform(stem: AudioData, sample_rate: u32, frames: usize, channels: usize) -> AudioData {
    let src_frames = stem.frames();
    let ratio = stem.sample_rate as f64 / sample_rate as f64;
    let out = (0..channels)
        .map(|c| {
            let chan = match stem.channels.get(c) {
                Some(chan) => chan,
                // Mono model output feeding a stereo track.
                None => match stem.channels.first() {
                    Some(first) => first,
                    None => return vec![0.0; frames],
                },
            };
            (0..frames)
                .map(|i| {
                    if src_frames == 0 {
                        return 0.0;
                    }
                    if stem.sample_rate == sample_rate {
                        return chan.get(i).copied().unwrap_or(0.0);
                    }
                    let pos = i as f64 * ratio;
                    let k = pos.floor() as usize;
                    let frac = (pos - k as f64) as f32;
                    let a = chan[k.min(src_frames - 1)];
                    let b = chan[(k + 1).min(src_frames - 1)];
                    a + (b - a) * frac
                })
                .collect()
        })
        .collect();
    AudioData {
        channels: out,
        sample_rate,
    }
}

impl StemSeparator for ScnetSeparator {
    /// The model name keys the stem cache, so SCNet stems never collide
    /// with another model's (or the DSP fallback's).
    fn id(&self) -> &str {
        &self.model
    }

    fn separate(&self, audio: &AudioData) -> Result<Stems> {
        self.separate_cancellable(audio, &CancelToken::new())
    }

    /// Checks the weights are on disk and that the interpreter can
    /// `import inference` — both cheap next to a separation, and between
    /// them they are the whole "can this run here" question. `Err`
    /// carries a user-facing install hint.
    fn probe(&self) -> Result<()> {
        self.check_weights()?;
        let out = Command::new(&self.python)
            .args(["-c", "import inference"])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| self.spawn_error(e))?;
        if !out.status.success() {
            bail!(
                "{} cannot import MSST's inference module — {INSTALL_HINT} ({})",
                self.python,
                tool_failure(&self.python, &out.stderr, out.status)
            );
        }
        Ok(())
    }

    fn separate_cancellable(&self, audio: &AudioData, cancel: &CancelToken) -> Result<Stems> {
        let frames = audio.frames();
        let channels = audio.channels.len();
        anyhow::ensure!(channels >= 1 && frames > 0, "empty audio");
        self.check_weights()?;

        let tmp = tempfile::tempdir().context("creating an SCNet work directory")?;
        // MSST reads a FOLDER of mixtures, not a file.
        let input_dir = tmp.path().join("in");
        std::fs::create_dir_all(&input_dir)
            .with_context(|| format!("creating {}", input_dir.display()))?;
        let input = input_dir.join("input.wav");
        std::fs::write(&input, crate::clip::wav16_bytes(audio))
            .with_context(|| format!("writing {}", input.display()))?;

        let out_dir = tmp.path().join("out");
        self.run(&input_dir, &out_dir, cancel)?;
        // A killed run left a half-written output tree behind; the caller
        // discards cancelled stems, so hand back something shaped right
        // rather than an error about SCNet producing nothing.
        if cancel.is_cancelled() {
            return Ok(Stems(std::array::from_fn(|_| AudioData {
                sample_rate: audio.sample_rate,
                channels: vec![Vec::new(); channels],
            })));
        }

        let paths = stem_files(&out_dir)?;
        let mut decoded = Vec::with_capacity(N_STEMS);
        for (path, name) in paths.iter().zip(STEM_NAMES) {
            let stem = decode_audio(path).with_context(|| format!("reading the {name} stem"))?;
            decoded.push(conform(stem, audio.sample_rate, frames, channels));
        }
        let stems: [AudioData; N_STEMS] = decoded
            .try_into()
            .map_err(|_| anyhow!("SCNet returned the wrong number of stems"))?;
        Ok(Stems(stems))
    }
}
