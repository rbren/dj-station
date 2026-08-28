//! Module bypass: a module that declares `bypass` routes in its manifest
//! can be switched to pass its inputs straight to its outputs, with its
//! DSP not running at all. The flag is per-module state and round-trips
//! through the patch like a knob.

use dj_engine::{Engine, EngineConfig, PatchDoc};

const SR: f32 = 48_000.0;

fn mono_engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap()
}

fn stereo_engine() -> Engine {
    Engine::new(EngineConfig::default(), crate::common::registry()).unwrap()
}

/// Saw -> filter (cutoff four octaves below the fundamental) -> out.
fn filter_patch(e: &mut Engine) {
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("flt", "com.dj.filter").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "flt", "in").unwrap();
    e.connect("flt", "lp", "out1", "l").unwrap();
    e.set_knob_value("osc1", "waveform", 1.0).unwrap();
    e.set_knob_value("flt", "cutoff", -4.0).unwrap();
}

fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

#[test]
fn a_bypassed_module_passes_its_input_through_sample_for_sample() {
    let frames = (0.1 * SR) as usize;

    // The same oscillator wired straight to the output is what "no
    // processing at all" has to sound like.
    let mut dry = mono_engine();
    dry.add_module("osc1", "com.dj.oscillator").unwrap();
    dry.add_module("out1", "builtin.audio_out").unwrap();
    dry.connect("osc1", "audio", "out1", "l").unwrap();
    dry.set_knob_value("osc1", "waveform", 1.0).unwrap();
    let dry = dry.render_offline(frames).unwrap().pop().unwrap();

    let mut e = mono_engine();
    filter_patch(&mut e);
    let filtered = e.render_offline(frames).unwrap().pop().unwrap();
    let tail = |x: &[f32]| rms(&x[x.len() / 2..]);
    assert!(
        tail(&filtered) < tail(&dry) * 0.5,
        "the filter should be doing something to start with ({} vs {})",
        tail(&filtered),
        tail(&dry)
    );

    let mut e = mono_engine();
    filter_patch(&mut e);
    e.set_bypass("flt", true).unwrap();
    let bypassed = e.render_offline(frames).unwrap().pop().unwrap();
    assert_eq!(bypassed, dry, "bypassed filter must pass the input through");

    // ...and back: taking the bypass off returns the module to work.
    let mut e = mono_engine();
    filter_patch(&mut e);
    e.set_bypass("flt", true).unwrap();
    e.set_bypass("flt", false).unwrap();
    let live = e.render_offline(frames).unwrap().pop().unwrap();
    assert_eq!(live, filtered);
}

#[test]
fn bypass_follows_every_declared_route_including_a_split_to_two_channels() {
    let frames = (0.05 * SR) as usize;
    let mut e = stereo_engine();
    // The resonator is one input feeding a stereo pair: bypassed, BOTH
    // outputs carry the dry signal.
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("res", "com.dj.resonator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "res", "in").unwrap();
    e.connect("res", "out_l", "out1", "l").unwrap();
    e.connect("res", "out_r", "out1", "r").unwrap();
    e.set_bypass("res", true).unwrap();
    let out = e.render_offline(frames).unwrap();
    assert!(peak(&out[0]) > 0.1, "left channel silent under bypass");
    assert_eq!(out[0], out[1], "both routes carry the same input");
}

#[test]
fn an_output_with_no_route_is_silent_while_bypassed() {
    let frames = (0.05 * SR) as usize;
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("comp", "com.dj.compressor").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "comp", "in_l").unwrap();
    // `gr` (gain reduction) is a readout, not audio: it declares no route.
    e.connect("comp", "gr", "out1", "l").unwrap();
    e.set_knob_value("comp", "threshold", -40.0).unwrap();
    e.set_knob_value("comp", "ratio", 8.0).unwrap();
    let reducing = e.render_offline(frames).unwrap().pop().unwrap();
    assert!(peak(&reducing) > 0.0, "compressor should be reducing gain");

    e.set_bypass("comp", true).unwrap();
    let bypassed = e.render_offline(frames).unwrap().pop().unwrap();
    assert_eq!(peak(&bypassed), 0.0);
}

#[test]
fn only_modules_that_declare_routes_can_be_bypassed() {
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    let bypassable = |e: &Engine, id: &str| {
        e.nodes
            .iter()
            .find(|n| n.instance_id == id)
            .unwrap()
            .is_bypassable()
    };
    assert!(!bypassable(&e, "osc1"));
    assert!(bypassable(&e, "vca1"));
    assert!(e.set_bypass("osc1", true).is_err());
    assert!(!e.is_bypassed("osc1").unwrap());
    e.set_bypass("vca1", true).unwrap();
    assert!(e.is_bypassed("vca1").unwrap());
}

#[test]
fn bypass_round_trips_through_a_saved_patch() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = mono_engine();
    filter_patch(&mut e);
    e.set_bypass("flt", true).unwrap();
    e.save_patch(dir.path(), "bypass").unwrap();

    let mut loaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert!(loaded.is_bypassed("flt").unwrap());
    let frames = (0.05 * SR) as usize;
    let after = loaded.render_offline(frames).unwrap().pop().unwrap();
    let before = e.render_offline(frames).unwrap().pop().unwrap();
    assert_eq!(after, before);

    // Off is the default and stays out of the file (old patches, and every
    // module nobody bypassed, keep their bytes).
    let text = std::fs::read_to_string(dir.path().join("modules/osc1.json")).unwrap();
    assert!(!text.contains("bypassed"), "{text}");
    let text = std::fs::read_to_string(dir.path().join("modules/flt.json")).unwrap();
    assert!(text.contains("\"bypassed\": true"), "{text}");
}

#[test]
fn apply_doc_restores_bypass_in_place() {
    let mut e = mono_engine();
    filter_patch(&mut e);
    e.set_bypass("flt", true).unwrap();
    let bypassed: PatchDoc = e.snapshot("undo");
    e.set_bypass("flt", false).unwrap();
    let live = e.snapshot("undo");

    e.apply_doc(&bypassed).unwrap();
    assert!(e.is_bypassed("flt").unwrap());
    e.apply_doc(&live).unwrap();
    assert!(!e.is_bypassed("flt").unwrap());
}

#[test]
fn bypass_reaches_a_running_engine_through_the_command_ring() {
    let mut e = mono_engine();
    filter_patch(&mut e);
    e.start_null_realtime().unwrap();
    e.set_bypass("flt", true).unwrap();
    // Give the RT thread a few blocks to pop the command.
    std::thread::sleep(std::time::Duration::from_millis(50));
    e.stop().unwrap();

    let frames = (0.05 * SR) as usize;
    let running = e.render_offline(frames).unwrap().pop().unwrap();
    let mut fresh = mono_engine();
    filter_patch(&mut fresh);
    let filtered = fresh.render_offline(frames).unwrap().pop().unwrap();
    let tail = |x: &[f32]| rms(&x[x.len() / 2..]);
    assert!(
        tail(&running) > tail(&filtered) * 2.0,
        "the RT thread never applied the bypass ({} vs {})",
        tail(&running),
        tail(&filtered)
    );
}
