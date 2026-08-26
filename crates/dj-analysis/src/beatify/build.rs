//! Assembling a clip out of beats (PRD "Beatify" — the clip builder).
//!
//! A clip is a grid of beats: columns are beats of the beatified grid,
//! rows are material that sounds together. Because every source on the
//! page has been warped onto ONE constant-tempo grid, laying beats down is
//! arithmetic — beat `n` of the clip starts at `n × period`, whatever it
//! was cut from — and mixing rows is addition. That is the whole payoff of
//! beatifying, and it is why this module needs no time-stretching of its
//! own.
//!
//! Everything here works in seconds against a sample rate, so the caller
//! decides what a beat is; [`Lay`] does not know about grids.

use crate::beatify::grid::Grid;
use crate::decode::AudioData;

/// Guard against a click at a cut. Beats are cut wherever the grid says,
/// which is rarely a zero crossing, so each run is faded in and out over
/// a couple of milliseconds. Short enough to be inaudible on a transient,
/// long enough to kill the step.
const DECLICK_SECS: f64 = 0.003;

/// One run of material: `secs` seconds taken from `from_secs` of `audio`,
/// laid down at `at_secs` of the output.
#[derive(Debug, Clone, Copy)]
pub struct Lay<'a> {
    pub audio: &'a AudioData,
    pub from_secs: f64,
    pub at_secs: f64,
    pub secs: f64,
}

/// Mix runs of material into one buffer of `out_secs`.
///
/// Rows are not a concept here: two lays that overlap in time simply sum,
/// which is what stacking tracks in the editor means. Anything that falls
/// outside the output is clipped away rather than shifting what fits.
pub fn assemble(lays: &[Lay], out_secs: f64, sample_rate: u32, channels: usize) -> AudioData {
    let channels = channels.max(1);
    let frames = (out_secs.max(0.0) * sample_rate as f64).round() as usize;
    let mut out = AudioData {
        channels: vec![vec![0.0; frames]; channels],
        sample_rate,
    };
    for lay in lays {
        mix_lay(&mut out, lay, sample_rate);
    }
    out
}

fn mix_lay(out: &mut AudioData, lay: &Lay, sample_rate: u32) {
    let sr = sample_rate as f64;
    let src_frames = lay.audio.frames();
    if src_frames == 0 || lay.secs <= 0.0 {
        return;
    }
    let take = (lay.secs * sr).round() as usize;
    let from = (lay.from_secs.max(0.0) * sr).round() as usize;
    let at = (lay.at_secs.max(0.0) * sr).round() as usize;
    let fade = ((DECLICK_SECS * sr).round() as usize).min(take / 2).max(1);
    let out_frames = out.frames();

    for ch in 0..out.channels.len() {
        // A mono source feeds every output channel; a stereo one feeding a
        // mono output folds down to its first channel. Neither is a
        // resample, so neither needs to be clever.
        let src = &lay.audio.channels[ch.min(lay.audio.channels.len() - 1)];
        for i in 0..take {
            let (Some(s), Some(d)) = (from.checked_add(i), at.checked_add(i)) else {
                break;
            };
            if s >= src_frames || d >= out_frames {
                break;
            }
            let gain = declick(i, take, fade);
            out.channels[ch][d] += src[s] * gain;
        }
    }
}

/// Sum whole buffers on top of each other: a submix of the stems that
/// are switched on.
///
/// No fades and no placement, because these are the SAME audio split
/// apart — drums + bass + other + vocals is the mix it came from, sample
/// for sample. The output is as long as the longest part, so a stem that
/// was rendered a frame short does not truncate the rest.
pub fn mix(parts: &[&AudioData]) -> AudioData {
    let frames = parts.iter().map(|p| p.frames()).max().unwrap_or(0);
    let channels = parts.iter().map(|p| p.channels.len()).max().unwrap_or(1);
    let sample_rate = parts.first().map(|p| p.sample_rate).unwrap_or(44_100);
    let mut out = AudioData {
        channels: vec![vec![0.0; frames]; channels.max(1)],
        sample_rate,
    };
    for part in parts {
        if part.channels.is_empty() {
            continue;
        }
        for ch in 0..out.channels.len() {
            let src = &part.channels[ch.min(part.channels.len() - 1)];
            for (i, s) in src.iter().enumerate() {
                out.channels[ch][i] += *s;
            }
        }
    }
    out
}

/// Where a run of beats reads from, where it lands and how long it is —
/// the arithmetic that makes a clip possible.
///
/// Both ends use the SAME grid: beat `n` of any source on the page is
/// `phase + n × period`, and column `c` of the clip is `c × period` (a
/// clip starts at its first beat, with no head padding of its own).
///
/// `source_beat` is FRACTIONAL: a selection whose ends were freed from
/// the grid (⌘ in the source pane) reads from part-way into a beat. The
/// clip end of it stays whole — a run lands on a column and covers
/// columns — so a fraction only ever shifts what is read, never where it
/// is heard.
pub fn span(grid: &Grid, source_beat: f64, col: usize, take_beats: f64) -> (f64, f64, f64) {
    (
        grid.beat_time(source_beat),
        col as f64 * grid.period,
        take_beats.max(0.0) * grid.period,
    )
}

/// How long a clip of `columns` beats lasts.
pub fn clip_secs(grid: &Grid, columns: usize) -> f64 {
    columns as f64 * grid.period
}

/// Ramp in over the first `fade` samples and out over the last.
fn declick(i: usize, take: usize, fade: usize) -> f32 {
    if i < fade {
        (i as f32 + 0.5) / fade as f32
    } else if i + fade >= take {
        ((take - i) as f32 - 0.5) / fade as f32
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(secs: f64, value: f32) -> AudioData {
        AudioData {
            channels: vec![vec![value; (secs * 1000.0) as usize]],
            sample_rate: 1000,
        }
    }

    /// The middle of a run, past any declick ramp.
    fn mid(audio: &AudioData, at_secs: f64) -> f32 {
        audio.channels[0][(at_secs * 1000.0) as usize]
    }

    #[test]
    fn every_source_reads_beat_n_at_the_same_instant() {
        // A grid with head padding: beat 0 is one period in (MOD-A14).
        let grid = Grid {
            bpm: 120.0,
            period: 0.5,
            phase: 0.5,
            beats: 64,
        };
        // Beats 8..12 of a source, dropped at column 4 of the clip.
        let (from, at, secs) = span(&grid, 8.0, 4, 4.0);
        assert!((from - 4.5).abs() < 1e-12, "phase + 8 periods");
        assert!((at - 2.0).abs() < 1e-12, "a clip has no padding of its own");
        assert!((secs - 2.0).abs() < 1e-12);
        assert!((clip_secs(&grid, 16) - 8.0).abs() < 1e-12);
    }

    #[test]
    fn a_freed_cut_reads_from_part_way_into_a_beat() {
        let grid = Grid {
            bpm: 120.0,
            period: 0.5,
            phase: 0.5,
            beats: 64,
        };
        // Three quarters of a beat into beat 7 — a cut dragged off the
        // grid to catch a pickup. Only the READ moves: the run still
        // lands on column 4 and still covers four whole columns.
        let (from, at, secs) = span(&grid, 7.75, 4, 4.0);
        assert!((from - 4.375).abs() < 1e-12, "phase + 7.75 periods");
        assert!((at - 2.0).abs() < 1e-12);
        assert!((secs - 2.0).abs() < 1e-12);
    }

    #[test]
    fn a_freed_cut_takes_the_audio_it_selected_and_no_more() {
        let grid = Grid {
            bpm: 120.0,
            period: 0.5,
            phase: 0.5,
            beats: 64,
        };
        // 6.25 beats selected with ⌘ occupy seven columns of the clip,
        // and the take is 6.25 beats long — the three quarters of a beat
        // left over at the end are silence, not a rounded-off take.
        let (from, at, secs) = span(&grid, 3.75, 0, 6.25);
        assert!((from - 2.375).abs() < 1e-12);
        assert!((at - 0.0).abs() < 1e-12);
        assert!((secs - 3.125).abs() < 1e-12, "6.25 × the period");
    }

    #[test]
    fn silence_fills_what_a_short_take_leaves() {
        // A run of one second laid into a two-second clip: the second
        // half is untouched, which is what the silent tail of a
        // fractional run is made of.
        let src = tone(2.0, 0.5);
        let out = assemble(
            &[Lay {
                audio: &src,
                from_secs: 0.0,
                at_secs: 0.0,
                secs: 1.0,
            }],
            2.0,
            1000,
            1,
        );
        assert_eq!(out.frames(), 2000);
        assert!(out.channels[0][500] > 0.4, "the take sounds");
        assert!(
            out.channels[0][1200..].iter().all(|s| *s == 0.0),
            "and stops dead where it ends"
        );
    }

    #[test]
    fn lays_material_where_it_was_put() {
        let src = tone(1.0, 0.5);
        let out = assemble(
            &[Lay {
                audio: &src,
                from_secs: 0.0,
                at_secs: 0.5,
                secs: 0.25,
            }],
            1.0,
            1000,
            1,
        );
        assert_eq!(out.frames(), 1000);
        assert_eq!(mid(&out, 0.25), 0.0, "nothing before it");
        assert!((mid(&out, 0.6) - 0.5).abs() < 1e-6, "the run itself");
        assert_eq!(mid(&out, 0.9), 0.0, "nothing after it");
    }

    #[test]
    fn takes_the_part_of_the_source_it_was_asked_for() {
        // A source that counts up in steps, so where a cut came from is
        // readable in the value.
        let mut src = tone(1.0, 0.0);
        for (i, s) in src.channels[0].iter_mut().enumerate() {
            *s = i as f32 / 1000.0;
        }
        let out = assemble(
            &[Lay {
                audio: &src,
                from_secs: 0.6,
                at_secs: 0.0,
                secs: 0.2,
            }],
            0.2,
            1000,
            1,
        );
        assert!((mid(&out, 0.1) - 0.7).abs() < 1e-3);
    }

    #[test]
    fn rows_sum() {
        let a = tone(1.0, 0.25);
        let b = tone(1.0, 0.5);
        let lay = |audio, at_secs| Lay {
            audio,
            from_secs: 0.0,
            at_secs,
            secs: 0.5,
        };
        let out = assemble(&[lay(&a, 0.0), lay(&b, 0.0)], 0.5, 1000, 1);
        assert!((mid(&out, 0.25) - 0.75).abs() < 1e-6);
    }

    #[test]
    fn fades_the_edges_of_every_run() {
        let src = tone(1.0, 1.0);
        let out = assemble(
            &[Lay {
                audio: &src,
                from_secs: 0.0,
                at_secs: 0.0,
                secs: 0.5,
            }],
            0.5,
            1000,
            1,
        );
        // The very first and last samples are on the ramp, not at full
        // level: a cut on a loud sample must not step.
        assert!(out.channels[0][0] < 0.5);
        assert!(out.channels[0][499] < 0.5);
        assert!((mid(&out, 0.25) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn clips_what_hangs_off_the_end_instead_of_growing() {
        let src = tone(1.0, 0.5);
        let out = assemble(
            &[Lay {
                audio: &src,
                from_secs: 0.0,
                at_secs: 0.4,
                secs: 1.0,
            }],
            0.5,
            1000,
            1,
        );
        assert_eq!(out.frames(), 500);
    }

    #[test]
    fn a_mono_source_feeds_every_channel() {
        let src = tone(0.5, 0.5);
        let out = assemble(
            &[Lay {
                audio: &src,
                from_secs: 0.0,
                at_secs: 0.0,
                secs: 0.5,
            }],
            0.5,
            1000,
            2,
        );
        assert_eq!(out.channels.len(), 2);
        assert!((out.channels[1][250] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn silence_is_a_valid_clip() {
        let out = assemble(&[], 0.25, 1000, 2);
        assert_eq!(out.frames(), 250);
        assert!(out.channels.iter().all(|c| c.iter().all(|s| *s == 0.0)));
    }
}
