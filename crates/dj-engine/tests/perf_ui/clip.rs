//! CLIP: the Clip page's edit turned into audio
//! (`dj_analysis::clip::render_clip`).
//!
//! The fixture is what a long edit actually looks like: a ten-minute
//! source cut into dozens of regions with crossfades between them, a
//! four-band EQ over the lot, level automation, and a tapped warp — every
//! stage of the renderer switched on at once. `ClipRenderProfile` says
//! which of those stages the time went into; the WARP is a WSOLA stretch
//! and is expected to dominate, so a change in that shape is visible here
//! rather than only in a total.

use dj_analysis::clip::{
    render_clip_profiled, ClipEq, ClipEqBand, ClipProgram, ClipRegion, LevelPoint,
};
use dj_analysis::AudioData;

use super::bench::{expect_scaling, expect_throughput, render, sized, warmup};

const SR: u32 = 48_000;

/// A stereo source of `secs` seconds with a beat in it, so the warp's
/// correlation search has real material to work on.
fn source(secs: f64) -> AudioData {
    let n = (secs * SR as f64) as usize;
    let channel: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f32 / SR as f32;
            let beat = if (t * 2.0).fract() < 0.05 { 1.0 } else { 0.3 };
            (2.0 * std::f32::consts::PI * 180.0 * t).sin() * 0.4 * beat
        })
        .collect();
    AudioData {
        channels: vec![channel.clone(), channel],
        sample_rate: SR,
    }
}

/// An edit over `secs` of source: `regions` slices spliced together with
/// crossfades, EQ, level automation and a warp.
fn program(secs: f64, regions: usize) -> ClipProgram {
    let span = secs / regions as f64;
    ClipProgram {
        regions: (0..regions)
            .map(|i| ClipRegion {
                source: 0,
                start_secs: i as f64 * span,
                end_secs: (i + 1) as f64 * span,
                // Every fourth slice played backwards: the reverse path
                // copies rather than borrows, and a real edit has some.
                reverse: i % 4 == 3,
                gain_db: if i % 3 == 0 { -2.0 } else { 0.0 },
            })
            .collect(),
        eq: ClipEq {
            bands: vec![
                ClipEqBand {
                    freq_hz: 80.0,
                    gain_db: 3.0,
                    q: 0.8,
                },
                ClipEqBand {
                    freq_hz: 400.0,
                    gain_db: -2.0,
                    q: 1.0,
                },
                ClipEqBand {
                    freq_hz: 2_500.0,
                    gain_db: 2.0,
                    q: 1.2,
                },
                ClipEqBand {
                    freq_hz: 9_000.0,
                    gain_db: -1.5,
                    q: 0.9,
                },
            ],
        },
        level: (0..=20)
            .map(|i| LevelPoint {
                time_secs: secs * i as f64 / 20.0,
                gain_db: if i % 2 == 0 { 0.0 } else { -6.0 },
            })
            .collect(),
        crossfade_ms: 8.0,
        // A stretch of a couple of percent across the whole edit: the
        // shape a tapped-out grid produces.
        warp: vec![[0.0, 0.0], [secs * 0.5, secs * 0.51], [secs, secs * 1.02]],
        warp_smoothing: 0.5,
        beat_grid: None,
    }
}

fn render_edit(secs: f64, regions: usize) -> dj_analysis::clip::ClipRenderProfile {
    let src = source(secs);
    let (audio, profile) = render_clip_profiled(&[&src], &program(secs, regions)).unwrap();
    let peak = audio.channels[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(peak > 0.0, "the clip render is silent");
    profile
}

#[test]
fn a_long_edit_renders_far_faster_than_realtime() {
    warmup(|| render_edit(1.0, 2));
    let secs = sized(60.0, 300.0);
    let regions = sized(24, 96);
    let (profile, t) = render(
        &format!("clip render ({secs}s, {regions} regions)"),
        secs,
        || render_edit(secs, regions),
    );
    println!("[perf] clip render profile: {}", profile.summary());

    // The Clip page renders on every edit (debounced), so anything near
    // realtime here is a page that lags a beat behind the user. The
    // floor is a fraction of the measured figure — see
    // reports/PERF_BASELINES.md.
    expect_throughput(&t, 3.0);
    // The stages are supposed to add up to the total: a stage that has
    // slipped out of the profile makes the breakdown a lie.
    let stages = profile.material_ms
        + profile.splice_ms
        + profile.eq_ms
        + profile.level_ms
        + profile.warp_ms;
    assert!(
        stages >= profile.total_ms * 0.8,
        "clip render profile accounts for only {stages:.0}ms of {:.0}ms — a stage is missing \
         from the instrumentation",
        profile.total_ms
    );
}

#[test]
fn an_edit_scales_with_its_length_not_its_square() {
    warmup(|| render_edit(1.0, 2));
    let secs = sized(30.0, 120.0);
    let regions = sized(24, 96);
    let (_, small) = render(&format!("clip render ({secs}s)"), secs, || {
        render_edit(secs, regions)
    });
    let (_, big) = render(&format!("clip render ({}s)", secs * 2.0), secs * 2.0, || {
        render_edit(secs * 2.0, regions)
    });

    // Every stage is a pass (or a fixed number of passes) over the
    // material: twice the audio is twice the work. A splice that copied
    // the whole clip per region, or a level lookup that scanned every
    // breakpoint per sample, would show here first.
    expect_scaling(&small, &big, 2.0, 1.5);
}

#[test]
fn more_regions_do_not_cost_more_than_the_audio_they_hold() {
    warmup(|| render_edit(1.0, 2));
    let secs = sized(60.0, 180.0);
    let few = sized(8, 24);
    let (_, small) = render(&format!("clip render ({few} regions)"), secs, || {
        render_edit(secs, few)
    });
    let (_, big) = render(&format!("clip render ({} regions)", few * 8), secs, || {
        render_edit(secs, few * 8)
    });

    // The SAME audio, cut into eight times as many pieces. Splicing is
    // per sample, not per region-pair, so this is nearly free; a
    // quadratic splice (each region re-copying the assembled buffer) is
    // exactly what a hundred-cut edit would die of.
    expect_scaling(&small, &big, 1.0, 2.0);
}
