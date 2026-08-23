//! 6-channel stereo mixer.
//!
//! Each channel is a stereo pair (`in{n}_l` / `in{n}_r`) with a level
//! fader, a pan/balance control and mute/solo switches. An unwired right
//! input is normalled to the left one, so a mono source patched into L
//! alone pans across the stereo field. `lvl` is unipolar (0..10, 10 =
//! unity); `pan` is ±10 V full scale (negative = left) with the classic
//! balance law: the favoured side stays at unity, the other fades
//! linearly.
//!
//! Mute/solo are gate inputs (>= 1 V engages, PRD §4), so they take a
//! knob toggle or a wire. Standard console semantics: a channel is heard
//! when it is un-muted AND (nothing is soloed OR it is soloed itself) —
//! mute and solo are independent, and muting a soloed channel still
//! silences it. Gate changes ride a short fade so a toggle never clicks.
//!
//! The stereo sum is scaled by the master level and clamped to the
//! ±10 V rails. DC-coupled: mixes CV and offsets as faithfully as audio.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo, GATE_HIGH};

const CHANNELS: usize = 6;
/// Per-channel input stride: in_l, in_r, lvl, pan, mute, solo.
const STRIDE: usize = 6;
const IN_MASTER: usize = CHANNELS * STRIDE;
const RAIL: f32 = 10.0;
/// Mute/solo fade, in seconds: long enough to swallow the click of a hard
/// cut, short enough that the switch still feels instant.
const FADE_SECONDS: f32 = 0.005;

pub struct Mixer {
    /// Per-channel mute/solo gain, ramped toward its 0/1 target.
    gate: [f32; CHANNELS],
    /// Gain change per sample over the fade.
    step: f32,
    /// False until the first processed sample, which snaps the gates to
    /// their targets instead of fading in from silence.
    primed: bool,
}

impl Module for Mixer {
    const N_INPUTS: usize = CHANNELS * STRIDE + 1;
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
            let any_solo = (0..CHANNELS).any(|ch| io.inputs[ch * STRIDE + 5][s] >= GATE_HIGH);
            let mut sum_l = 0.0f32;
            let mut sum_r = 0.0f32;
            for ch in 0..CHANNELS {
                let base = ch * STRIDE;
                let in_l = io.inputs[base][s];
                // R normalled to L when unwired (mono source pans).
                let in_r = if io.connected_inputs.is_connected(base + 1) {
                    io.inputs[base + 1][s]
                } else {
                    in_l
                };
                let lvl = (io.inputs[base + 2][s] * 0.1).clamp(0.0, 1.0);
                let pan = (io.inputs[base + 3][s] * 0.1).clamp(-1.0, 1.0);
                let muted = io.inputs[base + 4][s] >= GATE_HIGH;
                let soloed = io.inputs[base + 5][s] >= GATE_HIGH;
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
            let master = (io.inputs[IN_MASTER][s] * 0.1).clamp(0.0, 1.0);
            io.outputs[0][s] = (sum_l * master).clamp(-RAIL, RAIL);
            io.outputs[1][s] = (sum_r * master).clamp(-RAIL, RAIL);
        }
    }
}

export_module!(Mixer);
