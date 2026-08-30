//! The mixer family's DSP, once: a stereo desk of `CHANNELS` strips.
//!
//! Each channel is a stereo pair (`in{n}_l` / `in{n}_r`) with a level
//! fader; a FULL strip adds a pan/balance control and mute/solo switches.
//! An unwired right input is normalled to the left one, so a mono source
//! patched into L alone pans across the stereo field. `lvl` is unipolar
//! (0..10, 10 = unity); `pan` is ±10 V full scale (negative = left) with
//! the classic balance law: the favoured side stays at unity, the other
//! fades linearly.
//!
//! Mute/solo are gate inputs (>= 1 V engages, PRD §4), so they take a
//! knob toggle or a wire. Standard console semantics: a channel is heard
//! when it is un-muted AND (nothing is soloed OR it is soloed itself) —
//! mute and solo are independent, and muting a soloed channel still
//! silences it. Gate changes ride a short fade so a toggle never clicks.
//!
//! The stereo sum is scaled by the master level and clamped to the
//! ±10 V rails. DC-coupled: mixes CV and offsets as faithfully as audio.
//!
//! WIDTH vs. STRIP: a module may declare at most 64 input jacks (the
//! wasm-1 ABI's `connected_mask` is a u64, and the host enforces the same
//! bound when it loads a manifest), so the widest desk trades controls
//! for channels — 16 stereo strips only fit as level-only ones. That
//! ceiling is checked at compile time in [`Module::N_INPUTS`] below.

use dj_module_sdk::{InitCtx, Module, ProcessIo, GATE_HIGH};

/// Input jacks of a full channel strip: in_l, in_r, lvl, pan, mute, solo.
pub const FULL_STRIDE: usize = 6;
/// Input jacks of a level-only strip: in_l, in_r, lvl.
pub const LEVEL_STRIDE: usize = 3;

const IN_L: usize = 0;
const IN_R: usize = 1;
const LVL: usize = 2;
const PAN: usize = 3;
const MUTE: usize = 4;
const SOLO: usize = 5;

/// Most input jacks a module can have: the ABI's connected-input bitmask
/// is a `u64` (`dj_module_sdk::InputMask`).
const MAX_JACKS: usize = 64;

const RAIL: f32 = 10.0;
/// Mute/solo fade, in seconds: long enough to swallow the click of a hard
/// cut, short enough that the switch still feels instant.
const FADE_SECONDS: f32 = 0.005;

/// A `CHANNELS`-strip stereo mixer. `FULL` strips carry pan and
/// mute/solo; the rest are level-only.
pub struct Mixer<const CHANNELS: usize, const FULL: bool> {
    /// Per-channel mute/solo gain, ramped toward its 0/1 target.
    gate: [f32; CHANNELS],
    /// Gain change per sample over the fade.
    step: f32,
    /// False until the first processed sample, which snaps the gates to
    /// their targets instead of fading in from silence.
    primed: bool,
}

impl<const CHANNELS: usize, const FULL: bool> Mixer<CHANNELS, FULL> {
    /// Input jacks per channel strip.
    pub const STRIDE: usize = if FULL { FULL_STRIDE } else { LEVEL_STRIDE };
    /// The master fader, the one jack after the strips.
    const MASTER: usize = CHANNELS * Self::STRIDE;
}

impl<const CHANNELS: usize, const FULL: bool> Module for Mixer<CHANNELS, FULL> {
    const N_INPUTS: usize = {
        let n = CHANNELS * Self::STRIDE + 1;
        assert!(
            n <= MAX_JACKS,
            "mixer too wide for the ABI: drop to a level-only strip"
        );
        n
    };
    const N_OUTPUTS: usize = 2;

    fn new(ctx: &InitCtx) -> Self {
        Mixer {
            gate: [1.0; CHANNELS],
            step: 1.0 / (FADE_SECONDS * ctx.sample_rate).max(1.0),
            primed: false,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let any_solo =
                FULL && (0..CHANNELS).any(|ch| io.inputs[ch * Self::STRIDE + SOLO][s] >= GATE_HIGH);
            let mut sum_l = 0.0f32;
            let mut sum_r = 0.0f32;
            for ch in 0..CHANNELS {
                let base = ch * Self::STRIDE;
                let in_l = io.inputs[base + IN_L][s];
                // R normalled to L when unwired (mono source pans).
                let in_r = if io.connected_inputs.is_connected(base + IN_R) {
                    io.inputs[base + IN_R][s]
                } else {
                    in_l
                };
                let lvl = (io.inputs[base + LVL][s] * 0.1).clamp(0.0, 1.0);
                // A level-only strip is a centred, un-muted full one: pan
                // 0 and both gates open are exact unity gains, so the two
                // widths share this arithmetic to the sample.
                let (pan, muted, soloed) = if FULL {
                    (
                        (io.inputs[base + PAN][s] * 0.1).clamp(-1.0, 1.0),
                        io.inputs[base + MUTE][s] >= GATE_HIGH,
                        io.inputs[base + SOLO][s] >= GATE_HIGH,
                    )
                } else {
                    (0.0, false, false)
                };
                let target = if !muted && (!any_solo || soloed) {
                    1.0
                } else {
                    0.0
                };
                let held = self.gate[ch];
                let gate = if self.primed {
                    held + (target - held).clamp(-self.step, self.step)
                } else {
                    target
                };
                self.gate[ch] = gate;
                // Balance law: centre = unity both sides, panning fades
                // the opposite side only.
                let gain_l = (1.0 - pan).min(1.0);
                let gain_r = (1.0 + pan).min(1.0);
                sum_l += in_l * lvl * gain_l * gate;
                sum_r += in_r * lvl * gain_r * gate;
            }
            self.primed = true;
            let master = (io.inputs[Self::MASTER][s] * 0.1).clamp(0.0, 1.0);
            io.outputs[0][s] = (sum_l * master).clamp(-RAIL, RAIL);
            io.outputs[1][s] = (sum_r * master).clamp(-RAIL, RAIL);
        }
    }
}
