//! GRID: the per-row track effects rack, bounced offline.
//!
//! The Grid plays in the webview, but every row with an effects rack on
//! it is rendered here first (`dj_engine::track_fx`) and crossfaded
//! against the dry clip. A set is fifty rows, so the cost of ONE row is
//! paid fifty times over — and it splits into a BUILD (an engine plus a
//! wasmtime instantiation per module, per row) and a RENDER (linear in
//! the clip's length). `TrackFxProfile` reports that split, which is what
//! says whether a slow grid load is the racks or the audio.

use dj_engine::track_fx::{render_track_fx_clip_profiled, TrackFxProfile, TrackFxSpec};

use super::bench::{expect_scaling, expect_throughput, render, sized, warmup};
use crate::common::registry;

const SR: u32 = 48_000;

/// A tone of `secs` seconds — one row's worth of material.
fn tone(secs: f64) -> Vec<f32> {
    let n = (secs * SR as f64) as usize;
    (0..n)
        .map(|i| (2.0 * std::f32::consts::PI * 220.0 * i as f32 / SR as f32).sin() * 0.5)
        .collect()
}

/// The Grid's own rack JSON, in the shape `app/src/gridFx.ts` writes: the
/// default rack plus a longer chain, so a row is a real effects rack
/// rather than a wire.
fn fx_json() -> String {
    r#"{
      "level": 1, "pan": 0, "wet": 1,
      "modules": [
        { "id": "eq1", "type": "com.dj.eq", "x": 0, "y": 0, "values": { "gain1": 3, "gain2": -2 } },
        { "id": "filt1", "type": "com.dj.filter", "x": 384, "y": 0, "values": {} },
        { "id": "shape1", "type": "com.dj.waveshaper", "x": 768, "y": 0, "values": {} },
        { "id": "scope1", "type": "com.dj.scope", "x": 1152, "y": 0, "values": {} },
        { "id": "clockmult1", "type": "com.dj.clock_mult", "x": 0, "y": 288, "values": { "mult": 2 } },
        { "id": "lfo1", "type": "com.dj.lfo", "x": 384, "y": 288, "values": {} }
      ],
      "wires": [
        { "from_instance": "chrome", "from_jack": "outL", "to_instance": "eq1", "to_jack": "in" },
        { "from_instance": "eq1", "from_jack": "out", "to_instance": "filt1", "to_jack": "in" },
        { "from_instance": "filt1", "from_jack": "lp", "to_instance": "shape1", "to_jack": "in" },
        { "from_instance": "shape1", "from_jack": "out", "to_instance": "scope1", "to_jack": "in" },
        { "from_instance": "scope1", "from_jack": "thru", "to_instance": "chrome", "to_jack": "inL" },
        { "from_instance": "chrome", "from_jack": "clock", "to_instance": "clockmult1", "to_jack": "clock" },
        { "from_instance": "clockmult1", "from_jack": "out", "to_instance": "lfo1", "to_jack": "clock" },
        { "from_instance": "lfo1", "from_jack": "bi", "to_instance": "filt1", "to_jack": "cutoff" }
      ]
    }"#
    .to_string()
}

/// Bounce one row of `secs` seconds through the rack above.
fn render_row(secs: f64) -> TrackFxProfile {
    let spec = TrackFxSpec::from_json(&fx_json()).unwrap();
    let input = vec![tone(secs)];
    let (out, profile) =
        render_track_fx_clip_profiled(registry(), &spec, &input, SR as f32, 124.0).unwrap();
    let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(peak > 0.0, "the track FX rack rendered silence");
    profile
}

/// Modules in the rack above — six, plus the chrome the harness adds.
const RACK_MODULES: usize = 6;

#[test]
fn a_grid_row_bounces_far_faster_than_realtime() {
    warmup(|| render_row(0.5));
    let secs = sized(20.0, 60.0);
    let (profile, t) = render(&format!("grid track-fx row ({secs}s)"), secs, || {
        render_row(secs)
    });
    println!("[perf] grid track-fx profile: {}", profile.summary());

    // The floor is a fraction of the measured figure
    // (reports/PERF_BASELINES.md): below realtime, putting a rack on a
    // Grid row would take longer than playing the row.
    expect_throughput(&t, 3.0);
    // The build does NOT grow with the clip — it is one engine and six
    // wasm instantiations — so it is the cost a fifty-row set pays fifty
    // times over for nothing. It is ~70 ms per module today; a tenfold
    // slip there would make opening a set with racks unbearable while
    // leaving the throughput above untouched.
    let per_module = profile.build_ms / RACK_MODULES as f64;
    assert!(
        per_module < 400.0,
        "PERF REGRESSION — building a row's rack is {per_module:.0}ms per module \
         ({:.0}ms for {RACK_MODULES}). See reports/PERF_BASELINES.md.",
        profile.build_ms,
    );
}

#[test]
fn a_whole_grid_of_rows_bounces_faster_than_realtime() {
    warmup(|| render_row(0.5));
    let rows = sized(8, 24);
    let secs = 4.0;
    let mut build_ms = 0.0;
    let (_, t) = render(
        &format!("grid bounce ({rows} rows x {secs}s)"),
        rows as f64 * secs,
        || {
            for _ in 0..rows {
                build_ms += render_row(secs).build_ms;
            }
        },
    );

    // Every row pays a fresh engine build, so this is the number that
    // says whether opening a set with racks on it is bearable. The build
    // share is reported because it is the half that a cache would remove.
    println!(
        "[perf] grid bounce build share: {:.0}ms of {:.0}ms ({:.0}%)",
        build_ms,
        t.elapsed_secs * 1e3,
        100.0 * build_ms / (t.elapsed_secs * 1e3),
    );
    expect_throughput(&t, 2.0);
}

#[test]
fn a_row_scales_with_its_length_not_its_square() {
    warmup(|| render_row(0.5));
    let secs = sized(10.0, 30.0);
    let (_, small) = render(&format!("grid track-fx row ({secs}s)"), secs, || {
        render_row(secs)
    });
    let (_, big) = render(
        &format!("grid track-fx row ({}s)", secs * 2.0),
        secs * 2.0,
        || render_row(secs * 2.0),
    );

    // The render walks the buffer block by block, so it is linear in the
    // clip's length and the build is a constant beside it. Anything that
    // re-walks the whole buffer per block shows up here.
    expect_scaling(&small, &big, 2.0, 1.5);
}
