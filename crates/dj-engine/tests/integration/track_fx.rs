//! The Grid track effects rack, rendered offline (`dj_engine::track_fx`).
//!
//! The specs fed in here are the grid document's own `fx` JSON — the shape
//! `app/src/gridFx.ts` writes, extra fields (positions, level/pan/wet) and
//! all — so these tests break if either side drifts. The last test is the
//! whole-file regression: a small grid FILE turned into sound, once with
//! the default rack and once with an EQ cut, and the two must differ.

use dj_analysis::clip::{save_beat_clip, BleedAudio};
use dj_analysis::AudioData;
use dj_engine::track_fx::{render_track_fx_clip, TrackFxSpec};

use crate::common::registry;

const SR: u32 = 48_000;

/// A one-second 330 Hz tone: two beats at 120 BPM.
fn tone() -> Vec<f32> {
    (0..SR)
        .map(|i| (2.0 * std::f32::consts::PI * 330.0 * i as f32 / SR as f32).sin() * 0.5)
        .collect()
}

/// The frontend's `defaultTrackFx()`, serialized the way a grid document
/// carries it, with `eq_values` spliced into the EQ node.
fn fx_json(eq_values: &str) -> String {
    format!(
        r#"{{
          "level": 1, "pan": 0, "wet": 1,
          "modules": [
            {{ "id": "eq1", "type": "com.dj.eq", "x": 0, "y": 0, "values": {{{eq_values}}} }},
            {{ "id": "scope1", "type": "com.dj.scope", "x": 384, "y": 0, "values": {{}} }},
            {{ "id": "clockmult1", "type": "com.dj.clock_mult", "x": 0, "y": 288, "values": {{ "mult": 2 }} }},
            {{ "id": "lfo1", "type": "com.dj.lfo", "x": 384, "y": 288, "values": {{}} }}
          ],
          "wires": [
            {{ "from_instance": "chrome", "from_jack": "outL", "to_instance": "eq1", "to_jack": "in" }},
            {{ "from_instance": "eq1", "from_jack": "out", "to_instance": "scope1", "to_jack": "in" }},
            {{ "from_instance": "scope1", "from_jack": "thru", "to_instance": "chrome", "to_jack": "inL" }},
            {{ "from_instance": "chrome", "from_jack": "clock", "to_instance": "clockmult1", "to_jack": "clock" }},
            {{ "from_instance": "clockmult1", "from_jack": "out", "to_instance": "lfo1", "to_jack": "clock" }}
          ]
        }}"#
    )
}

/// Every band of the EQ pulled to its floor: a cut no tone escapes.
const EQ_CUT: &str = r#""gain1": -15, "gain2": -15, "gain3": -15, "gain4": -15"#;

fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

fn render(fx: &str, input: &[Vec<f32>]) -> Vec<Vec<f32>> {
    let spec = TrackFxSpec::from_json(fx).unwrap();
    render_track_fx_clip(registry(), &spec, input, SR as f32, 120.0).unwrap()
}

#[test]
fn the_default_rack_returns_the_track() {
    let input = tone();
    let out = render(&fx_json(""), &[input.clone()]);
    // Default rack = flat EQ + scope thru on the L path: mono out, and
    // close enough to the input that full-wet playback of an untouched
    // rack is not a sound change.
    assert_eq!(out.len(), 1, "L-only rack renders mono");
    assert_eq!(
        out[0].len(),
        input.len(),
        "sample-aligned with the dry buffer"
    );
    let (r_in, r_out) = (rms(&input), rms(&out[0]));
    assert!(
        (r_out - r_in).abs() < r_in * 0.1,
        "flat rack should be ~unity: in {r_in}, out {r_out}"
    );
}

#[test]
fn an_eq_cut_changes_the_sound() {
    let input = vec![tone()];
    let flat = render(&fx_json(""), &input);
    let cut = render(&fx_json(EQ_CUT), &input);
    assert!(
        rms(&cut[0]) < rms(&flat[0]) * 0.5,
        "a -15 dB cut on every band must take real level away: flat {}, cut {}",
        rms(&flat[0]),
        rms(&cut[0])
    );
}

#[test]
fn a_rack_returning_nothing_renders_silence() {
    let spec = TrackFxSpec::from_json(
        r#"{ "modules": [ { "id": "eq1", "type": "com.dj.eq", "values": {} } ],
             "wires": [ { "from_instance": "chrome", "from_jack": "outL",
                          "to_instance": "eq1", "to_jack": "in" } ] }"#,
    )
    .unwrap();
    assert!(!spec.returns_audio());
    let out = render_track_fx_clip(registry(), &spec, &[tone()], SR as f32, 120.0).unwrap();
    assert!(
        rms(&out[0]) < 1e-6,
        "nothing wired back to the chrome is silence"
    );
}

#[test]
fn a_stereo_clip_through_the_default_rack_keeps_both_sides() {
    // The chrome's mono convention: a rack that never taps outR gets the
    // WHOLE track on L (a mono sum), not just the left half of it.
    let l = tone();
    let r: Vec<f32> = tone().iter().map(|s| -s).collect(); // cancels in a sum
    let out = render(&fx_json(""), &[l.clone(), l.clone()]);
    assert!(
        (rms(&out[0]) - rms(&l)).abs() < rms(&l) * 0.1,
        "L==R sums to itself"
    );
    let cancelled = render(&fx_json(""), &[l, r]);
    assert!(
        rms(&cancelled[0]) < 1e-3,
        "out-of-phase sides sum to silence"
    );
}

/// The whole path a saved arrangement takes to be heard: a small grid FILE
/// (the exact `GridDocument` shape `app/src/grid.ts` saves) pointing at a
/// clip in a real beat-clip store, played through each row's rack. The
/// mixdown here is deliberately minimal — place each copy at its beat and
/// sum — but the audio under it is the app's own: the clip store, the fx
/// spec out of the file, and the offline rack render.
#[test]
fn a_small_grid_file_renders_to_sound_and_fx_change_it() {
    let dir = tempfile::tempdir().unwrap();
    let audio = AudioData {
        channels: vec![tone()],
        sample_rate: SR,
    };
    // Two beats at the grid's own 120 BPM, so the dry buffer needs no
    // re-timing (the app WSOLA-stretches first when tempi differ).
    let meta = save_beat_clip(
        dir.path(),
        "loop",
        &audio,
        120.0,
        2,
        vec![],
        None,
        &BleedAudio::default(),
    )
    .unwrap();

    let grid_file = |fx: Option<&str>| {
        let fx = fx.map(|f| format!(r#", "fx": {f}"#)).unwrap_or_default();
        format!(
            r#"{{ "version": 1, "state": {{
                  "rows": [ {{ "id": "row1", "clipId": "{id}", "placements": [0, 4],
                               "levels": [] {fx} }} ],
                  "tempo": {{ "bpm": 120, "points": [] }},
                  "beats": 8, "barBeats": 4, "loop": null }} }}"#,
            id = meta.id
        )
    };

    let play = |file: &str| -> Vec<f32> {
        let doc: serde_json::Value = serde_json::from_str(file).unwrap();
        let state = &doc["state"];
        let bpm = state["tempo"]["bpm"].as_f64().unwrap();
        let spb = 60.0 / bpm;
        let beats = state["beats"].as_u64().unwrap() as f64;
        let mut mix = vec![0.0f32; (beats * spb * SR as f64) as usize];
        for row in state["rows"].as_array().unwrap() {
            let clip_id = row["clipId"].as_str().unwrap();
            let (_, audio, _) = dj_analysis::clip::load_beat_clip(dir.path(), clip_id).unwrap();
            // A row without a rack of its own plays through the default.
            let fx = match &row["fx"] {
                serde_json::Value::Null => fx_json(""),
                v => v.to_string(),
            };
            let spec = TrackFxSpec::from_json(&fx).unwrap();
            let wet = render_track_fx_clip(
                registry(),
                &spec,
                &audio.channels,
                audio.sample_rate as f32,
                bpm,
            )
            .unwrap();
            for p in row["placements"].as_array().unwrap() {
                let at = (p.as_f64().unwrap() * spb * SR as f64) as usize;
                for (i, s) in wet[0].iter().enumerate() {
                    if let Some(slot) = mix.get_mut(at + i) {
                        *slot += s;
                    }
                }
            }
        }
        mix
    };

    let plain = play(&grid_file(None));
    assert!(
        rms(&plain) > 0.05,
        "a grid file with a placed clip makes sound"
    );

    let cut = play(&grid_file(Some(&fx_json(EQ_CUT))));
    assert!(rms(&cut) > 0.0, "an effected row still sounds");
    assert!(
        rms(&cut) < rms(&plain) * 0.5,
        "the row's rack must be heard: plain {}, cut {}",
        rms(&plain),
        rms(&cut)
    );
}
