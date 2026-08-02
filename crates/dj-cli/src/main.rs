//! Headless CLI harness for the dj-station engine.
//!
//! Subcommands:
//!   render <patch-dir> <out.wav> [--seconds N] [--extensions DIR]
//!   run [<patch-dir>] [--extensions DIR] [--seconds N] [--backend null|cpal]
//!   demo <patch-dir>   (writes the demo MIDI->ADSR->VCA patch)
//!   list-extensions [--extensions DIR]

use anyhow::{Context, Result};
use dj_engine::{Engine, EngineConfig, ExtensionRegistry};
use std::path::PathBuf;
use std::time::Duration;

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn extensions_dir(args: &[String]) -> PathBuf {
    arg_value(args, "--extensions")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("extensions"))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("render") => render(&args[1..]),
        Some("run") => run(&args[1..]),
        Some("demo") => demo(&args[1..]),
        Some("list-extensions") => list_extensions(&args[1..]),
        _ => {
            eprintln!(
                "usage: dj-cli <render|run|demo|list-extensions> [args]\n\
                 \n\
                 render <patch-dir> <out.wav> [--seconds N] [--extensions DIR]\n\
                 run [<patch-dir>] [--seconds N] [--backend null|cpal] [--extensions DIR]\n\
                 demo <patch-dir> [--extensions DIR]\n\
                 list-extensions [--extensions DIR]"
            );
            std::process::exit(2);
        }
    }
}

fn list_extensions(args: &[String]) -> Result<()> {
    let reg = ExtensionRegistry::discover(&[extensions_dir(args)])?;
    for (id, ext) in &reg.extensions {
        println!("{id}  v{}  ({})", ext.manifest.version, ext.dir.display());
    }
    println!("builtin.audio_out  (built-in)");
    println!("builtin.midi  (built-in)");
    Ok(())
}

/// Build the canonical M0 demo patch: MIDI -> ADSR(gate) -> VCA(cv),
/// Osc -> VCA -> Audio Out; save it to a patch directory.
fn demo(args: &[String]) -> Result<()> {
    let dir = PathBuf::from(args.first().context("demo needs a patch dir")?);
    let reg = ExtensionRegistry::discover(&[extensions_dir(args)])?;
    let mut engine = Engine::new(EngineConfig::default(), reg)?;
    engine.add_module("midi1", "builtin.midi")?;
    engine.add_module("osc1", "com.dj.oscillator")?;
    engine.add_module("adsr1", "com.dj.adsr")?;
    engine.add_module("vca1", "com.dj.vca")?;
    engine.add_module("out1", "builtin.audio_out")?;
    engine.add_midi_mapping("midi1", "note", 60, "pad_1")?;
    engine.connect("midi1", "pad_1", "adsr1", "gate")?;
    engine.connect("osc1", "audio", "vca1", "in")?;
    engine.connect("adsr1", "env", "vca1", "cv")?;
    engine.connect("vca1", "out", "out1", "ch1")?;
    engine.connect("vca1", "out", "out1", "ch2")?;
    engine.save_patch(&dir, "m0-demo")?;
    println!("wrote demo patch to {}", dir.display());
    Ok(())
}

fn render(args: &[String]) -> Result<()> {
    let patch = PathBuf::from(args.first().context("render needs a patch dir")?);
    let out = PathBuf::from(args.get(1).context("render needs an output wav path")?);
    let seconds: f32 = arg_value(args, "--seconds")
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(2.0);
    let reg = ExtensionRegistry::discover(&[extensions_dir(args)])?;
    let mut engine = Engine::load_patch(&patch, reg)?;
    let frames = (seconds * engine.config.sample_rate) as usize;
    let t0 = std::time::Instant::now();
    engine.render_offline_wav(frames, &out)?;
    let dt = t0.elapsed().as_secs_f32();
    println!(
        "rendered {seconds}s to {} in {dt:.2}s ({:.1}x realtime)",
        out.display(),
        seconds / dt.max(1e-6)
    );
    Ok(())
}

fn run(args: &[String]) -> Result<()> {
    let reg = ExtensionRegistry::discover(&[extensions_dir(args)])?;
    let mut engine = if let Some(patch) = args.first().filter(|a| !a.starts_with("--")) {
        Engine::load_patch(&PathBuf::from(patch), reg)?
    } else {
        let mut e = Engine::new(EngineConfig::default(), reg)?;
        e.add_module("out1", "builtin.audio_out")?;
        e
    };
    let backend = arg_value(args, "--backend").unwrap_or_else(|| "null".into());
    match backend.as_str() {
        "cpal" => engine.start_cpal()?,
        "null" => engine.start_null_realtime()?,
        other => anyhow::bail!("unknown backend {other:?} (headless build supports 'null')"),
    }
    let watcher = engine.start_watcher(Duration::from_millis(200))?;
    let seconds: Option<f32> = arg_value(args, "--seconds").map(|s| s.parse()).transpose()?;
    println!(
        "engine running ({} backend), hot-reload watcher active; blocks={} xruns={}",
        backend,
        engine.blocks_processed(),
        engine.xrun_count()
    );
    let start = std::time::Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(200));
        engine.pump_watcher(&watcher)?;
        if let Some(s) = seconds {
            if start.elapsed().as_secs_f32() >= s {
                break;
            }
        }
    }
    engine.stop()?;
    println!(
        "stopped: blocks={} xruns={}",
        engine.blocks_processed(),
        engine.xrun_count()
    );
    Ok(())
}
