//! DSP fallback stem separator tests (M3):
//! - energy conservation: the four stems sum back to the original signal;
//! - component separation on a synthetic mix with known parts;
//! - determinism;
//! - FLAC cache: compute-if-missing keyed by content hash (cache hits do
//!   not invoke the separator and are near-instant).

use dj_analysis::{
    ensure_stems, mix_stems, stem_paths, stems_cached, AudioData, BandSeparator, StemSeparator,
    Stems,
};
use std::sync::atomic::{AtomicUsize, Ordering};

const SR: u32 = 44_100;

/// Deterministic noise (splitmix64).
struct Rng(u64);
impl Rng {
    fn f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^= z >> 31;
        ((z >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
}

/// Synthetic stereo mix with four ground-truth components:
/// - "bass": 60 Hz sine, both channels;
/// - "vocals": 1 kHz sine, center-panned (identical L/R);
/// - "other": 3 kHz sine, hard side-panned (L = -R);
/// - "drums": broadband noise clicks every 0.25 s.
fn fixture(secs: f64) -> (AudioData, [Vec<f32>; 4]) {
    let n = (secs * SR as f64) as usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let mut bass = vec![0.0f32; n];
    let mut vox = vec![0.0f32; n];
    let mut other = vec![0.0f32; n];
    let mut drums = vec![0.0f32; n];
    let mut rng = Rng(7);
    for i in 0..n {
        let t = i as f64 / SR as f64;
        let b = (0.5 * (2.0 * std::f64::consts::PI * 60.0 * t).sin()) as f32;
        let v = (0.4 * (2.0 * std::f64::consts::PI * 1000.0 * t).sin()) as f32;
        let o = (0.3 * (2.0 * std::f64::consts::PI * 3000.0 * t).sin()) as f32;
        bass[i] = b;
        vox[i] = v;
        other[i] = o;
        l[i] = b + v + o;
        r[i] = b + v - o; // side-panned "other"
    }
    // Clicks: 6 ms noise bursts every 0.25 s.
    let mut t = 0.1;
    while t < secs {
        let start = (t * SR as f64) as usize;
        for i in 0..(0.006 * SR as f64) as usize {
            if start + i >= n {
                break;
            }
            let s = rng.f32() * 0.6 * (1.0 - i as f32 / (0.006 * SR as f32));
            drums[start + i] = s;
            l[start + i] += s;
            r[start + i] += s;
        }
        t += 0.25;
    }
    (
        AudioData {
            channels: vec![l, r],
            sample_rate: SR,
        },
        [vox, drums, bass, other],
    )
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / x.len() as f64).sqrt()
}

/// RMS of the projection error when approximating `target` from `est`:
/// how much of `target` is *missing* from `est` (both same length).
fn component_capture(est: &[f32], target: &[f32]) -> f64 {
    // Correlation-based capture: fraction of target energy present in est.
    let dot: f64 = est
        .iter()
        .zip(target)
        .map(|(&a, &b)| a as f64 * b as f64)
        .sum();
    let t_energy: f64 = target.iter().map(|&s| (s as f64).powi(2)).sum();
    if t_energy <= 0.0 {
        return 0.0;
    }
    dot / t_energy
}

#[test]
fn stems_sum_to_original_within_tolerance() {
    let (audio, _) = fixture(3.0);
    let Stems(stems) = BandSeparator.separate(&audio).unwrap();
    for ch in 0..2 {
        let orig = &audio.channels[ch];
        let mut err_max = 0.0f64;
        let mut err_sq = 0.0f64;
        for (i, &o) in orig.iter().enumerate() {
            let sum: f32 = stems.iter().map(|s| s.channels[ch][i]).sum();
            let e = (sum - o) as f64;
            err_max = err_max.max(e.abs());
            err_sq += e * e;
        }
        let err_rms = (err_sq / orig.len() as f64).sqrt();
        let orig_rms = rms(orig);
        println!(
            "ch{ch}: sum-vs-orig rms err {err_rms:.2e} (orig rms {orig_rms:.3}), max {err_max:.2e}"
        );
        assert!(
            err_rms < orig_rms * 1e-3,
            "stems do not sum to the original: rms err {err_rms}"
        );
    }
}

#[test]
fn each_component_lands_mostly_in_its_stem() {
    let (audio, [vox, drums, bass, other]) = fixture(3.0);
    let Stems(stems) = BandSeparator.separate(&audio).unwrap();
    // Compare on the left channel (all components present there).
    let targets = [&vox, &drums, &bass, &other];
    let names = dj_analysis::STEM_NAMES;
    for (s, target) in targets.iter().enumerate() {
        let own = component_capture(&stems[s].channels[0], target);
        println!("{}: captures {:.2} of its component", names[s], own);
        assert!(
            own > 0.6,
            "{} stem captures only {:.2} of its component",
            names[s],
            own
        );
        for (o, other_stem) in stems.iter().enumerate() {
            if o == s {
                continue;
            }
            let leak = component_capture(&other_stem.channels[0], target);
            assert!(
                leak < 0.35,
                "{} component leaks {:.2} into the {} stem",
                names[s],
                leak,
                names[o]
            );
        }
    }
}

/// What the Clip page asks for when some stem switches are off: the
/// chosen ones summed, and nothing of the ones left out.
#[test]
fn a_subset_of_stems_mixes_to_exactly_those_stems() {
    let (audio, parts) = fixture(2.0);
    let Stems(stems) = BandSeparator.separate(&audio).unwrap();

    // "Everything but the vocals" — the classic instrumental. STEM_NAMES
    // is vocals, drums, bass, other.
    let keep: Vec<&AudioData> = [1usize, 2, 3].iter().map(|i| &stems[*i]).collect();
    let mix = mix_stems(&keep).unwrap();
    assert_eq!(mix.sample_rate, audio.sample_rate);
    assert_eq!(mix.channels.len(), audio.channels.len());
    assert_eq!(mix.frames(), audio.frames());

    for ch in 0..2 {
        for (i, &m) in mix.channels[ch].iter().enumerate() {
            let want: f32 = keep.iter().map(|s| s.channels[ch][i]).sum();
            assert!((m - want).abs() < 1e-6, "frame {i} is not the plain sum");
        }
    }

    // And the point of leaving a stem out: the vocal is gone. The whole
    // track carries essentially all of the vocal component; the
    // instrumental carries almost none of it.
    let vox = &parts[0];
    let in_whole = component_capture(&audio.channels[0], vox);
    let in_mix = component_capture(&mix.channels[0], vox);
    println!("vocal capture: whole {in_whole:.3}, instrumental {in_mix:.3}");
    assert!(in_whole > 0.9, "the fixture should contain its own vocal");
    assert!(in_mix < 0.2, "the vocal survived being switched off");

    // Every stem on is the whole track again.
    let all: Vec<&AudioData> = stems.iter().collect();
    let whole = mix_stems(&all).unwrap();
    for ch in 0..2 {
        let err = rms(&whole.channels[ch]
            .iter()
            .zip(&audio.channels[ch])
            .map(|(a, b)| a - b)
            .collect::<Vec<_>>());
        assert!(err < rms(&audio.channels[ch]) * 1e-3, "err {err}");
    }
}

#[test]
fn mixing_no_stems_is_an_error_rather_than_silence() {
    // The UI must not be able to ask for "nothing" and get a track of
    // silence back; it has to keep at least one switch on.
    assert!(mix_stems(&[]).is_err());
}

#[test]
fn separation_is_deterministic() {
    let (audio, _) = fixture(1.0);
    let Stems(a) = BandSeparator.separate(&audio).unwrap();
    let Stems(b) = BandSeparator.separate(&audio).unwrap();
    for (sa, sb) in a.iter().zip(&b) {
        assert_eq!(sa.channels, sb.channels);
    }
}

/// Counting wrapper to prove cache hits never recompute.
struct Counting(BandSeparator, AtomicUsize);
impl StemSeparator for Counting {
    fn id(&self) -> &'static str {
        "counting"
    }
    fn separate(&self, audio: &AudioData) -> anyhow::Result<Stems> {
        self.1.fetch_add(1, Ordering::SeqCst);
        self.0.separate(audio)
    }
}

#[test]
fn stem_cache_hit_is_instant_and_does_not_recompute() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("stems").join("deadbeefhash");
    let (audio, _) = fixture(2.0);
    let sep = Counting(BandSeparator, AtomicUsize::new(0));

    assert!(!stems_cached(&dir));
    let computed = ensure_stems(&dir, &audio, &sep).unwrap();
    assert!(computed);
    assert_eq!(sep.1.load(Ordering::SeqCst), 1);
    assert!(stems_cached(&dir));
    for p in stem_paths(&dir) {
        assert!(p.is_file(), "missing stem {}", p.display());
        assert!(std::fs::metadata(&p).unwrap().len() > 0);
    }

    // Cache hit: no recompute, and effectively instant.
    let t0 = std::time::Instant::now();
    let computed = ensure_stems(&dir, &audio, &sep).unwrap();
    let dt = t0.elapsed();
    assert!(!computed);
    assert_eq!(sep.1.load(Ordering::SeqCst), 1, "cache hit recomputed");
    assert!(
        dt < std::time::Duration::from_millis(50),
        "cache hit took {dt:?}"
    );
}

#[test]
fn cached_stems_decode_back_to_the_same_audio() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("s");
    let (audio, _) = fixture(1.0);
    let Stems(stems) = BandSeparator.separate(&audio).unwrap();
    dj_analysis::stems::write_stems(&dir, &Stems(stems.clone())).unwrap();
    for (i, p) in stem_paths(&dir).iter().enumerate() {
        let decoded = dj_analysis::decode_audio(p).unwrap();
        assert_eq!(decoded.sample_rate, SR);
        assert_eq!(decoded.channels.len(), 2);
        // The encoder zero-pads the final FLAC block; content must match
        // for all real frames and the padding must be silent.
        assert!(decoded.frames() >= audio.frames());
        assert!(decoded.frames() < audio.frames() + 4096);
        for ch in 0..2 {
            // 16-bit quantization tolerance.
            for (a, b) in decoded.channels[ch].iter().zip(&stems[i].channels[ch]) {
                assert!((a - b).abs() < 2.0 / 32768.0 + 1e-4);
            }
            for &a in &decoded.channels[ch][audio.frames()..] {
                assert_eq!(a, 0.0);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// htdemucs_ft backend (external `demucs` CLI) + background jobs
// ---------------------------------------------------------------------------
//
// No real demucs and no model weights: the plumbing runs against a fake
// `demucs` script that records its argv and writes prepared stem WAVs, so
// CI never depends on the multi-GB checkpoints (AGENTS.md).

use dj_analysis::demucs::{DemucsSeparator, DEFAULT_MODEL, ENV_DEMUCS_BIN};
use dj_analysis::stems_dir_for;

/// Stereo tone at an explicit rate.
fn tone(freq: f64, secs: f64, sr: u32) -> AudioData {
    let n = (secs * sr as f64) as usize;
    let chan: Vec<f32> = (0..n)
        .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr as f64).sin() as f32 * 0.5)
        .collect();
    AudioData {
        channels: vec![chan.clone(), chan],
        sample_rate: sr,
    }
}

fn write_wav(path: &std::path::Path, audio: &AudioData) {
    let spec = hound::WavSpec {
        channels: audio.channels.len() as u16,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..audio.frames() {
        for c in &audio.channels {
            w.write_sample((c[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                .unwrap();
        }
    }
    w.finalize().unwrap();
}

/// A fake `demucs` honouring the real CLI's file contract:
/// `<--out>/<-n model>/<track>/{vocals,drums,bass,other}.wav`. Each stem is
/// a distinct tone so the read-back order can be checked. Returns the
/// (script, argv log) paths.
#[cfg(unix)]
fn fake_demucs(dir: &std::path::Path, stem_secs: f64) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    // Demucs always emits 44.1 kHz, whatever the input's rate is.
    let stems_src = dir.join("prepared");
    std::fs::create_dir_all(&stems_src).unwrap();
    for (i, name) in dj_analysis::STEM_NAMES.iter().enumerate() {
        let freq = 220.0 * (i + 1) as f64;
        write_wav(
            &stems_src.join(format!("{name}.wav")),
            &tone(freq, stem_secs, 44_100),
        );
    }

    let argv_log = dir.join("argv.txt");
    let script = dir.join("fake-demucs");
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
if [ "$1" = "--help" ]; then echo "usage: demucs"; exit 0; fi
# printf, not echo: the argv starts with `-n`, which echo would eat.
# Appended, so the log doubles as a count of model runs.
printf '%s\n' "$*" >> '{argv}'
out=""; model=""; prev=""
for arg in "$@"; do
  case "$prev" in
    --out) out="$arg" ;;
    -n) model="$arg" ;;
  esac
  prev="$arg"
done
dir="$out/$model/input"
mkdir -p "$dir"
for s in vocals drums bass other; do
  cp '{src}'/$s.wav "$dir/$s.wav"
done
echo "Separating track" >&2
"#,
            argv = argv_log.display(),
            src = stems_src.display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, argv_log)
}

#[test]
fn stem_cache_is_keyed_by_backend_so_models_never_collide() {
    let data = std::path::Path::new("/data");
    // The DSP fallback keeps the flat layout the deck already auto-loads.
    assert_eq!(
        stems_dir_for(data, "hash1", "band"),
        dj_analysis::stems_dir(data, "hash1")
    );
    // Every model gets its own subdirectory.
    let ft = stems_dir_for(data, "hash1", DEFAULT_MODEL);
    assert_eq!(ft, data.join("stems").join("hash1").join("htdemucs_ft"));
    assert_ne!(ft, stems_dir_for(data, "hash1", "htdemucs"));
    assert_ne!(ft, stems_dir_for(data, "hash1", "band"));
}

#[test]
fn demucs_separator_defaults_to_the_fine_tuned_model() {
    let sep = DemucsSeparator::with_bin("demucs", DEFAULT_MODEL);
    assert_eq!(sep.model(), "htdemucs_ft");
    assert_eq!(sep.id(), "htdemucs_ft", "the model keys the stem cache");
}

#[cfg(unix)]
#[test]
fn demucs_cli_runs_the_model_and_conforms_its_output_to_the_source() {
    let tmp = tempfile::tempdir().unwrap();
    // Demucs emits 2.0 s @ 44.1 kHz; the source is 48 kHz, so the stems
    // come back needing both a resample and an exact length fit.
    let (script, argv_log) = fake_demucs(tmp.path(), 2.0);
    let sep = DemucsSeparator::with_bin(&script.to_string_lossy(), DEFAULT_MODEL);

    let source = tone(440.0, 2.0, 48_000);
    let Stems(stems) = sep.separate(&source).unwrap();

    let argv = std::fs::read_to_string(&argv_log).unwrap();
    assert!(
        argv.contains("-n htdemucs_ft"),
        "the fine-tuned model must be requested: {argv}"
    );
    assert!(argv.contains("--out"), "missing --out: {argv}");

    for (stem, name) in stems.iter().zip(dj_analysis::STEM_NAMES) {
        assert_eq!(stem.sample_rate, 48_000, "{name} kept demucs' rate");
        assert_eq!(
            stem.frames(),
            source.frames(),
            "{name} must line up with the source sample-for-sample"
        );
        assert_eq!(stem.channels.len(), 2, "{name} channel count");
        assert!(rms(&stem.channels[0]) > 0.1, "{name} is silent");
    }
    // Stems are read back in STEM_NAMES order, not directory order: each
    // fake stem is a different tone, so a swap shows up as a different
    // dominant frequency.
    let crossings = |x: &[f32]| x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
    let vocals = crossings(&stems[0].channels[0]);
    let drums = crossings(&stems[1].channels[0]);
    assert!(
        drums > vocals,
        "stem order is wrong: vocals={vocals} drums={drums} crossings"
    );
}

#[cfg(unix)]
#[test]
fn missing_demucs_tooling_fails_with_an_install_hint_and_never_panics() {
    let sep = DemucsSeparator::with_bin("definitely-not-installed-demucs", DEFAULT_MODEL);

    let probe = sep.probe().unwrap_err().to_string();
    assert!(probe.contains("install demucs"), "unhelpful probe: {probe}");
    assert!(probe.contains(ENV_DEMUCS_BIN), "no env hint: {probe}");

    // The same clear error on the real call path, rather than a panic.
    let err = sep
        .separate(&tone(440.0, 0.2, 44_100))
        .err()
        .expect("must fail");
    let msg = format!("{err:#}");
    assert!(msg.contains("install demucs"), "unhelpful error: {msg}");
}

#[cfg(unix)]
#[test]
fn a_failing_demucs_run_surfaces_its_stderr() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let script = tmp.path().join("broken-demucs");
    std::fs::write(
        &script,
        "#!/bin/sh\necho 'error: model htdemucs_ft not downloaded' >&2\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let sep = DemucsSeparator::with_bin(&script.to_string_lossy(), DEFAULT_MODEL);
    let err = sep
        .separate(&tone(440.0, 0.2, 44_100))
        .err()
        .expect("must fail");
    let msg = format!("{err:#}");
    assert!(
        msg.contains("not downloaded"),
        "the tool's own reason must reach the user: {msg}"
    );
}

#[cfg(unix)]
#[test]
fn stem_jobs_separate_in_the_background_and_cache_under_the_backend() {
    use dj_analysis::{StemJobState, StemJobs};
    use dj_library::{ImportOptions, Library};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn wait_done(jobs: &StemJobs, id: u64, what: &str) {
        let t0 = Instant::now();
        loop {
            let job = jobs.jobs().into_iter().find(|j| j.id == id).unwrap();
            match job.state {
                StemJobState::Done => return,
                StemJobState::Failed => panic!("{what} failed: {:?}", job.error),
                StemJobState::Cancelled => panic!("{what} was cancelled by nobody"),
                StemJobState::Running => {
                    assert!(t0.elapsed() < Duration::from_secs(30), "{what} hung");
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }

    let tmp = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(tmp.path()).unwrap());
    let wav = tmp.path().join("track.wav");
    write_wav(&wav, &tone(440.0, 1.0, 44_100));
    let track = library
        .import_file(&wav, ImportOptions::default())
        .unwrap()
        .track()
        .clone();

    let work = tempfile::tempdir().unwrap();
    let (script, _) = fake_demucs(work.path(), 1.0);
    let jobs = StemJobs::new(
        library.clone(),
        Arc::new(DemucsSeparator::with_bin(
            &script.to_string_lossy(),
            DEFAULT_MODEL,
        )),
    );

    assert_eq!(jobs.backend(), "htdemucs_ft");
    assert!(!jobs.cached(track.id), "nothing separated yet");
    assert!(jobs.cached_paths(track.id).is_none());

    let id = jobs.start(track.id);
    // Starting again while running joins the same job: a double click must
    // not launch a second multi-minute separation.
    assert_eq!(jobs.start(track.id), id, "duplicate job started");
    wait_done(&jobs, id, "separation");

    // Cached under the model's own directory, leaving the DSP cache (which
    // the deck auto-loads) alone.
    assert!(jobs.cached(track.id));
    let dir = stems_dir_for(library.data_dir(), &track.content_hash, DEFAULT_MODEL);
    assert!(stems_cached(&dir), "no stems in {}", dir.display());
    assert!(
        !stems_cached(&dj_analysis::stems_dir(
            library.data_dir(),
            &track.content_hash
        )),
        "a demucs run must not masquerade as the DSP cache"
    );
    for p in &jobs.cached_paths(track.id).expect("cached paths") {
        assert!(p.is_file(), "missing {}", p.display());
    }

    // A second request is a cache hit, so it finishes without re-running
    // the (real-world: multi-minute) model.
    let again = jobs.start(track.id);
    assert_ne!(again, id, "the finished job should not be reused");
    wait_done(&jobs, again, "cache hit");
}

#[cfg(unix)]
#[test]
fn a_stem_job_failure_is_reported_not_panicked() {
    use dj_analysis::{StemJobState, StemJobs};
    use dj_library::{ImportOptions, Library};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    let tmp = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(tmp.path()).unwrap());
    let wav = tmp.path().join("track.wav");
    write_wav(&wav, &tone(440.0, 0.5, 44_100));
    let track = library
        .import_file(&wav, ImportOptions::default())
        .unwrap()
        .track()
        .clone();

    // The machine has no demucs installed.
    let jobs = StemJobs::new(
        library.clone(),
        Arc::new(DemucsSeparator::with_bin("no-such-demucs", DEFAULT_MODEL)),
    );
    let id = jobs.start(track.id);

    let t0 = Instant::now();
    let job = loop {
        let job = jobs.jobs().into_iter().find(|j| j.id == id).unwrap();
        if !job.is_running() {
            break job;
        }
        assert!(t0.elapsed() < Duration::from_secs(20), "job hung");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(job.state, StemJobState::Failed);
    let error = job.error.unwrap_or_default();
    assert!(error.contains("install demucs"), "unhelpful: {error}");
    assert!(!jobs.cached(track.id), "a failed run must cache nothing");
}

/// A fake `demucs` that never finishes on its own: it writes its pid to
/// `pidfile`, then sleeps. Cancelling has to kill it.
#[cfg(unix)]
fn hanging_demucs(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let pidfile = dir.join("pid.txt");
    let script = dir.join("hanging-demucs");
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
if [ "$1" = "--help" ]; then echo "usage: demucs"; exit 0; fi
echo $$ > '{pid}'
# Progress chatter, then a wait no cancel-less run would ever escape.
echo "Separating track" >&2
sleep 600
"#,
            pid = pidfile.display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, pidfile)
}

#[cfg(unix)]
#[test]
fn cancelling_a_stem_job_kills_the_run_and_leaves_the_track_separable() {
    use dj_analysis::{StemJobState, StemJobs};
    use dj_library::{ImportOptions, Library};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let t0 = Instant::now();
        while !done() {
            assert!(
                t0.elapsed() < Duration::from_secs(30),
                "{what} never happened"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    let tmp = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(tmp.path()).unwrap());
    let wav = tmp.path().join("track.wav");
    write_wav(&wav, &tone(440.0, 1.0, 44_100));
    let track = library
        .import_file(&wav, ImportOptions::default())
        .unwrap()
        .track()
        .clone();

    let work = tempfile::tempdir().unwrap();
    let (hanging, pidfile) = hanging_demucs(work.path());
    let jobs = StemJobs::new(
        library.clone(),
        Arc::new(DemucsSeparator::with_bin(
            &hanging.to_string_lossy(),
            DEFAULT_MODEL,
        )),
    );

    let id = jobs.start(track.id);
    wait_for("demucs started", || pidfile.is_file());
    let pid: i32 = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(alive(pid), "the fake demucs should still be running");

    assert!(jobs.cancel_track(track.id), "there was a job to cancel");
    wait_for("the job finished", || {
        !jobs.jobs().iter().any(|j| j.id == id && j.is_running())
    });

    let job = jobs.jobs().into_iter().find(|j| j.id == id).unwrap();
    assert_eq!(
        job.state,
        StemJobState::Cancelled,
        "a killed run is cancelled, not failed: {:?}",
        job.error
    );
    // The point of the button: the work actually stops. Without the kill
    // the child would sit there for ten minutes.
    wait_for("the child was killed", || !alive(pid));
    assert!(!jobs.cached(track.id), "a cancelled run must cache nothing");

    // And the track is left separable — nothing half-written in the way.
    let work2 = tempfile::tempdir().unwrap();
    let (script, _) = fake_demucs(work2.path(), 1.0);
    let jobs = StemJobs::new(
        library.clone(),
        Arc::new(DemucsSeparator::with_bin(
            &script.to_string_lossy(),
            DEFAULT_MODEL,
        )),
    );
    let again = jobs.start(track.id);
    wait_for("the re-run finished", || {
        !jobs.jobs().iter().any(|j| j.id == again && j.is_running())
    });
    let job = jobs.jobs().into_iter().find(|j| j.id == again).unwrap();
    assert_eq!(
        job.state,
        StemJobState::Done,
        "re-run failed: {:?}",
        job.error
    );
    assert!(jobs.cached(track.id));
}

#[cfg(unix)]
#[test]
fn cancelling_nothing_says_so() {
    use dj_analysis::StemJobs;
    use dj_library::Library;
    use std::sync::Arc;

    let tmp = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(tmp.path()).unwrap());
    let jobs = StemJobs::new(
        library,
        Arc::new(DemucsSeparator::with_bin("no-such-demucs", DEFAULT_MODEL)),
    );
    assert!(!jobs.cancel_track(1), "no job, nothing to stop");
}

/// Is `pid` still around? `kill -0` in Rust: signal 0 only checks.
#[cfg(unix)]
fn alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Automatic stem separation (the background service)
// ---------------------------------------------------------------------------

/// How many times the fake model was actually run.
#[cfg(unix)]
fn model_runs(argv_log: &std::path::Path) -> usize {
    std::fs::read_to_string(argv_log)
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0)
}

#[cfg(unix)]
fn wait_until(what: &str, secs: u64, mut done: impl FnMut() -> bool) {
    let t0 = std::time::Instant::now();
    while !done() {
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(secs),
            "{what} never happened"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// A library holding one track per `sources` entry, imported under that
/// source name (as a provider download would be).
#[cfg(unix)]
fn library_of(
    dir: &std::path::Path,
    sources: &[&str],
) -> (
    std::sync::Arc<dj_library::Library>,
    Vec<dj_library::db::Track>,
) {
    use dj_library::{ImportOptions, Library};
    let library = std::sync::Arc::new(Library::open(dir).unwrap());
    let tracks = sources
        .iter()
        .enumerate()
        .map(|(i, source)| {
            let wav = dir.join(format!("track{i}.wav"));
            // A different tone per track: same content would dedupe to one
            // library row (and one stem cache entry).
            write_wav(&wav, &tone(220.0 + 30.0 * i as f64, 1.0, 44_100));
            library
                .import_file(
                    &wav,
                    ImportOptions {
                        source: (*source).into(),
                        ..Default::default()
                    },
                )
                .unwrap()
                .track()
                .clone()
        })
        .collect();
    (library, tracks)
}

#[cfg(unix)]
fn auto_settings(scope: dj_analysis::AutoStemScope) -> dj_analysis::AutoStemSettings {
    dj_analysis::AutoStemSettings {
        scope,
        poll_interval: std::time::Duration::from_millis(50),
        probe_interval: std::time::Duration::from_millis(50),
        max_attempts: 2,
    }
}

#[cfg(unix)]
fn demucs_jobs(
    library: std::sync::Arc<dj_library::Library>,
    script: &std::path::Path,
) -> std::sync::Arc<dj_analysis::StemJobs> {
    std::sync::Arc::new(dj_analysis::StemJobs::new(
        library,
        std::sync::Arc::new(DemucsSeparator::with_bin(
            &script.to_string_lossy(),
            DEFAULT_MODEL,
        )),
    ))
}

/// The headline: downloads get separated with nobody asking, including
/// the ones that were downloaded long before the service existed.
#[cfg(unix)]
#[test]
fn downloaded_tracks_are_separated_without_anyone_asking() {
    use dj_analysis::{AutoStemScope, AutoStemService, TrackStems};

    let tmp = tempfile::tempdir().unwrap();
    // Two YouTube downloads already sitting in the library, plus a local
    // file: this is the backfill case — history, not new arrivals.
    let (library, tracks) = library_of(tmp.path(), &["youtube", "youtube", "local"]);
    let work = tempfile::tempdir().unwrap();
    let (script, argv_log) = fake_demucs(work.path(), 1.0);
    let jobs = demucs_jobs(library.clone(), &script);

    // Before the service runs, the editor is told to wait, not to press
    // a button.
    let service = AutoStemService::start(
        library.clone(),
        jobs.clone(),
        auto_settings(AutoStemScope::Downloads),
    );
    assert!(
        matches!(
            service.track_stems(tracks[0].id),
            TrackStems::Ready | TrackStems::Loading { .. }
        ),
        "a download should be on its way to having stems"
    );

    wait_until("both downloads separated", 60, || {
        jobs.cached(tracks[0].id) && jobs.cached(tracks[1].id)
    });
    assert_eq!(service.track_stems(tracks[0].id), TrackStems::Ready);
    assert_eq!(service.track_stems(tracks[1].id), TrackStems::Ready);
    assert_eq!(model_runs(&argv_log), 2, "one model run per track, no more");

    // Scoped to downloads, the local file is left alone — and says so,
    // rather than claiming stems are coming.
    assert!(
        !jobs.cached(tracks[2].id),
        "local track was separated anyway"
    );
    assert!(
        matches!(
            service.track_stems(tracks[2].id),
            TrackStems::Unavailable { .. }
        ),
        "a track nothing will separate must not read as loading"
    );

    // The service settles instead of spinning: the queue empties.
    wait_until("the queue to drain", 10, || service.status().pending == 0);
}

/// Stems are the expensive thing here, so they must survive the app
/// quitting: a second run reuses what the first one wrote.
#[cfg(unix)]
#[test]
fn stems_written_by_one_run_are_reused_by_the_next() {
    use dj_analysis::{AutoStemScope, AutoStemService, TrackStems};

    let tmp = tempfile::tempdir().unwrap();
    let (library, tracks) = library_of(tmp.path(), &["youtube"]);
    let work = tempfile::tempdir().unwrap();
    let (script, argv_log) = fake_demucs(work.path(), 1.0);

    {
        let jobs = demucs_jobs(library.clone(), &script);
        let _service = AutoStemService::start(
            library.clone(),
            jobs.clone(),
            auto_settings(AutoStemScope::All),
        );
        wait_until("the first run to separate", 60, || {
            jobs.cached(tracks[0].id)
        });
    } // dropping the service stops it, as quitting the app would

    assert_eq!(model_runs(&argv_log), 1);
    let stem_dir = stems_dir_for(library.data_dir(), &tracks[0].content_hash, DEFAULT_MODEL);
    let written: Vec<std::time::SystemTime> = stem_paths(&stem_dir)
        .iter()
        .map(|p| std::fs::metadata(p).unwrap().modified().unwrap())
        .collect();

    // A fresh instance over the same data dir: same library, same cache.
    let library2 = std::sync::Arc::new(dj_library::Library::open(tmp.path()).unwrap());
    let jobs2 = demucs_jobs(library2.clone(), &script);
    let service2 =
        AutoStemService::start(library2, jobs2.clone(), auto_settings(AutoStemScope::All));
    assert_eq!(service2.track_stems(tracks[0].id), TrackStems::Ready);
    wait_until("the second run to settle", 10, || {
        service2.status().pending == 0
    });
    std::thread::sleep(std::time::Duration::from_millis(300));

    assert_eq!(
        model_runs(&argv_log),
        1,
        "the second run separated a track that was already done"
    );
    let after: Vec<std::time::SystemTime> = stem_paths(&stem_dir)
        .iter()
        .map(|p| std::fs::metadata(p).unwrap().modified().unwrap())
        .collect();
    assert_eq!(written, after, "cached stems were rewritten");
}

/// A separation interrupted part-way is NOT a cache hit — neither the
/// obvious case (files missing) nor the nasty one (a file that survived
/// as zero bytes, which a presence check would trust forever).
#[test]
fn a_half_written_stem_cache_is_redone_rather_than_trusted() {
    let tmp = tempfile::tempdir().unwrap();
    let (audio, _) = fixture(1.0);

    // Quit between stems: two of the four ever made it to disk.
    let missing = tmp.path().join("stems").join("interrupted");
    std::fs::create_dir_all(&missing).unwrap();
    let paths = stem_paths(&missing);
    std::fs::write(&paths[0], b"a stem that finished writing").unwrap();
    std::fs::write(&paths[1], b"and another").unwrap();
    assert!(!stems_cached(&missing), "two of four is not a cache");
    assert!(ensure_stems(&missing, &audio, &BandSeparator).unwrap());
    assert!(stems_cached(&missing));

    // Power cut after the rename, before the data: the file is there and
    // empty. This is the one a presence check gets wrong.
    let hollow = tmp.path().join("stems").join("hollowed-out");
    std::fs::create_dir_all(&hollow).unwrap();
    let paths = stem_paths(&hollow);
    let Stems(stems) = BandSeparator.separate(&audio).unwrap();
    dj_analysis::stems::write_stems(&hollow, &Stems(stems)).unwrap();
    assert!(stems_cached(&hollow), "a real separation is a cache hit");
    std::fs::write(&paths[2], b"").unwrap();
    assert!(
        !stems_cached(&hollow),
        "an empty stem file must not count as cached"
    );

    assert!(
        ensure_stems(&hollow, &audio, &BandSeparator).unwrap(),
        "the hollowed-out cache should be separated again"
    );
    assert!(stems_cached(&hollow));
    for path in &paths {
        let len = std::fs::metadata(path).unwrap().len();
        assert!(
            len > 100,
            "{} is still a stub ({len} bytes)",
            path.display()
        );
    }
    // And what came back is really audio, not a leftover stub.
    let decoded = dj_analysis::decode_audio(&paths[2]).expect("the bass stem must decode");
    assert_eq!(decoded.sample_rate, audio.sample_rate);
}

/// Ordering: somebody waiting on a track beats the backfill, and the
/// backfill does downloads before local files (newest first within each).
#[test]
fn the_queue_serves_whoever_is_waiting_before_the_backfill() {
    use dj_analysis::auto_stems::{next_in_line, Candidate};
    use dj_analysis::AutoStemScope;

    let track = |id: i64, source: &str| Candidate {
        track_id: id,
        source: source.into(),
    };
    // Newest first, as the library hands them over.
    let tracks = vec![
        track(5, "local"),
        track(4, "youtube"),
        track(3, "youtube"),
        track(2, "watch"),
    ];
    let all = |_: i64| true;

    let (pick, pending) = next_in_line(&[], &tracks, AutoStemScope::All, all);
    assert_eq!(
        pick,
        Some(4),
        "the newest download comes before local files"
    );
    assert_eq!(pending, 4);

    let (pick, pending) = next_in_line(&[], &tracks, AutoStemScope::Downloads, all);
    assert_eq!(pick, Some(4));
    assert_eq!(pending, 2, "only downloads are in scope");

    // The editor opened track 5: it goes first, whatever the backfill
    // would have chosen.
    let (pick, _) = next_in_line(&[5], &tracks, AutoStemScope::All, all);
    assert_eq!(pick, Some(5));

    // ...unless it no longer needs stems, in which case the backfill
    // carries on rather than stalling.
    let (pick, _) = next_in_line(&[5], &tracks, AutoStemScope::All, |id| id != 5);
    assert_eq!(pick, Some(4));

    // Nothing left to do.
    let (pick, pending) = next_in_line(&[], &tracks, AutoStemScope::All, |_| false);
    assert_eq!(pick, None);
    assert_eq!(pending, 0);
}

/// Missing tooling is a reported state: the service says why instead of
/// leaving the editor waiting on stems that will never arrive.
#[cfg(unix)]
#[test]
fn missing_tooling_is_reported_instead_of_a_forever_wait() {
    use dj_analysis::{AutoStemScope, AutoStemService, TrackStems};

    let tmp = tempfile::tempdir().unwrap();
    let (library, tracks) = library_of(tmp.path(), &["youtube"]);
    let jobs = std::sync::Arc::new(dj_analysis::StemJobs::new(
        library.clone(),
        std::sync::Arc::new(DemucsSeparator::with_bin(
            "definitely-not-installed-demucs",
            DEFAULT_MODEL,
        )),
    ));
    let service = AutoStemService::start(library, jobs.clone(), auto_settings(AutoStemScope::All));

    wait_until("the missing tool to be noticed", 30, || {
        matches!(
            service.track_stems(tracks[0].id),
            TrackStems::Unavailable { .. }
        )
    });
    let TrackStems::Unavailable { detail } = service.track_stems(tracks[0].id) else {
        unreachable!("just checked");
    };
    assert!(detail.contains("install demucs"), "unhelpful: {detail}");
    let status = service.status();
    assert!(status.enabled && !status.available);
    assert!(!jobs.cached(tracks[0].id));
}

/// A track that cannot be separated is retried a few times and then left
/// alone, rather than spinning the loop forever.
#[cfg(unix)]
#[test]
fn a_track_that_keeps_failing_is_given_up_on() {
    use dj_analysis::{AutoStemScope, AutoStemService, TrackStems};
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().unwrap();
    let (library, tracks) = library_of(tmp.path(), &["youtube"]);
    let work = tempfile::tempdir().unwrap();
    let script = work.path().join("broken-demucs");
    let runs = work.path().join("runs.txt");
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
if [ "$1" = "--help" ]; then echo "usage: demucs"; exit 0; fi
echo run >> '{runs}'
echo "torch.cuda.OutOfMemoryError" >&2
exit 1
"#,
            runs = runs.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let jobs = demucs_jobs(library.clone(), &script);
    let service = AutoStemService::start(library, jobs, auto_settings(AutoStemScope::All));

    wait_until("the track to be given up on", 60, || {
        matches!(service.track_stems(tracks[0].id), TrackStems::Failed { .. })
    });
    let TrackStems::Failed { detail } = service.track_stems(tracks[0].id) else {
        unreachable!("just checked");
    };
    assert!(detail.contains("OutOfMemory"), "lost the reason: {detail}");

    // max_attempts is 2 here: it stops there rather than hammering.
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert_eq!(model_runs(&runs), 2, "retried past max_attempts");
}
