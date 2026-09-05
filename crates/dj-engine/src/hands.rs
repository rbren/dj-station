//! Built-in Hands module (`builtin.hands`): CV outputs derived from the
//! camera panel's MediaPipe hand tracking.
//!
//! Architecturally the MIDI module's sibling with a FIXED jack set:
//! detection happens in the webview (MediaPipe WASM needs it), landmark
//! frames cross into Rust over one Tauri IPC command, the derivations
//! below run on the control thread, and changed values ship to the RT
//! graph as timestamped events over a lock-free SPSC ring
//! ([`HandsRtModule`] — zero allocations or locks on the RT side).
//!
//! ## Coordinates
//!
//! Landmarks arrive in the camera panel's ENGINE space (canonical
//! write-up in `extensions/camera/ui-src/handTracking.ts`): X right in
//! the mirror view, Y up, origin frame-center, [-1, 1]. Only x/y are
//! measurements; MediaPipe z is model-estimated wrist-relative depth, so
//! every derivation here is 2D.
//!
//! ## Dropout policy
//!
//! Hand visibility is DEBOUNCED: a hand must appear or disappear for
//! [`DEBOUNCE_FRAMES`] consecutive camera frames before the module
//! believes it, so a single misdetected frame (e.g. the right hand
//! momentarily labelled left) causes no thrash — glitch frames hold.
//! When a hand's disappearance is confirmed, its value jacks (and the
//! two-hand deltas) DECAY to 0 V over [`DECAY_SECONDS`] on the RT
//! thread instead of holding, so patches don't freeze on a stale
//! reading. The `seen` gates report the debounced visibility itself
//! (10 V tracked / 0 V not). A dropped/failed frame (`None`) updates
//! nothing at all — the tracker said nothing, which is different from
//! "no hands seen".

use crate::manifest::{categories, Manifest, OutputDecl};
use crate::module_host::HostModule;
use serde::{Deserialize, Serialize};

pub const HANDS_ID: &str = "builtin.hands";

/// Consecutive camera frames a visibility change must persist before it
/// is applied (see the dropout policy above). 2 = a single bad frame is
/// ignored entirely, at the cost of one camera frame (~33 ms at 30 fps)
/// of appearance/disappearance latency.
pub const DEBOUNCE_FRAMES: u8 = 2;

/// Decay-to-zero time for a confirmed-vanished hand's value jacks.
pub const DECAY_SECONDS: f32 = 0.010;

/// Output jack indices (manifest order).
pub mod jack {
    pub const CX: usize = 0;
    pub const CY: usize = 1;
    pub const LX: usize = 2;
    pub const LY: usize = 3;
    pub const RX: usize = 4;
    pub const RY: usize = 5;
    pub const DX: usize = 6;
    pub const DY: usize = 7;
    pub const L_PINCH: usize = 8;
    pub const R_PINCH: usize = 9;
    pub const L_ROT: usize = 10;
    pub const R_ROT: usize = 11;
    pub const L_SEEN: usize = 12;
    pub const R_SEEN: usize = 13;
}

pub const N_HANDS_JACKS: usize = 14;

const JACKS: [(&str, &str); N_HANDS_JACKS] = [
    ("cx", "Cent X"),
    ("cy", "Cent Y"),
    ("lx", "L X"),
    ("ly", "L Y"),
    ("rx", "R X"),
    ("ry", "R Y"),
    ("dx", "ΔX"),
    ("dy", "ΔY"),
    ("l_pinch", "L Pinch"),
    ("r_pinch", "R Pinch"),
    ("l_rot", "L Rot"),
    ("r_rot", "R Rot"),
    ("l_seen", "L Seen"),
    ("r_seen", "R Seen"),
];

pub fn hands_manifest() -> Manifest {
    Manifest {
        id: HANDS_ID.into(),
        name: "Hands".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::ANALYSIS.into(),
        deprecated: false,
        inputs: vec![],
        outputs: JACKS
            .iter()
            .map(|(id, name)| OutputDecl {
                id: (*id).into(),
                name: (*name).into(),
                alias: None,
                display: None,
            })
            .collect(),
        params: vec![],
        ui: None,
        latency_samples: 0,
        bypass: Default::default(),
        presets: Default::default(),
    }
}

/// MediaPipe hand-landmark indices used by the derivations.
const WRIST: usize = 0;
const THUMB_MCP: usize = 2;
const THUMB_TIP: usize = 4;
const INDEX_TIP: usize = 8;
const MIDDLE_MCP: usize = 9;
pub const N_LANDMARKS: usize = 21;

/// One tracked frame from the camera panel: per-hand landmark sets in
/// engine coordinates ([x, y, z] each; only x/y are used). `None` = that
/// hand is not tracked this frame.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HandsDetection {
    pub left: Option<[[f32; 3]; N_LANDMARKS]>,
    pub right: Option<[[f32; 3]; N_LANDMARKS]>,
}

/// A recorded landmark trace for offline renders / E2E goldens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandsTrace {
    pub fps: f32,
    pub frames: Vec<HandsDetection>,
}

impl HandsTrace {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }

    pub fn save(&self, path: &std::path::Path) -> anyhow::Result<()> {
        let mut s = serde_json::to_string_pretty(self)?;
        s.push('\n');
        Ok(std::fs::write(path, s)?)
    }
}

fn centroid(pts: &[[f32; 3]; N_LANDMARKS]) -> (f32, f32) {
    let (mut x, mut y) = (0.0, 0.0);
    for p in pts {
        x += p[0];
        y += p[1];
    }
    let n = N_LANDMARKS as f32;
    (x / n, y / n)
}

/// Thumb-tip to index-tip distance, normalized by the wrist -> middle-MCP
/// span so the value is invariant to hand distance from the camera.
/// Touching ~0.1-0.2, spread ~1.2-1.5. None if the ruler is degenerate.
fn pinch_ratio(pts: &[[f32; 3]; N_LANDMARKS]) -> Option<f32> {
    let d = |a: usize, b: usize| {
        let dx = pts[a][0] - pts[b][0];
        let dy = pts[a][1] - pts[b][1];
        (dx * dx + dy * dy).sqrt()
    };
    let ruler = d(WRIST, MIDDLE_MCP);
    if ruler < 1e-6 {
        return None;
    }
    Some(d(THUMB_TIP, INDEX_TIP) / ruler)
}

/// Signed angle (radians) of the thumb direction (thumb MCP -> tip)
/// relative to the palm axis (wrist -> middle MCP), 2D. The sign is
/// mirrored for the left hand so "thumb out" (abducted away from the
/// palm) is POSITIVE for both hands; tucked across the palm goes
/// negative. None if either vector is degenerate.
fn thumb_rotation(pts: &[[f32; 3]; N_LANDMARKS], is_left: bool) -> Option<f32> {
    let palm = (
        pts[MIDDLE_MCP][0] - pts[WRIST][0],
        pts[MIDDLE_MCP][1] - pts[WRIST][1],
    );
    let thumb = (
        pts[THUMB_TIP][0] - pts[THUMB_MCP][0],
        pts[THUMB_TIP][1] - pts[THUMB_MCP][1],
    );
    if (palm.0 * palm.0 + palm.1 * palm.1) < 1e-12
        || (thumb.0 * thumb.0 + thumb.1 * thumb.1) < 1e-12
    {
        return None;
    }
    let cross = palm.0 * thumb.1 - palm.1 * thumb.0;
    let dot = palm.0 * thumb.0 + palm.1 * thumb.1;
    let angle = cross.atan2(dot);
    Some(if is_left { -angle } else { angle })
}

fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    v.max(lo).min(hi)
}

/// Derive all jack values from one detection. `None` = no update for
/// that jack this frame (the RT side holds the last value).
pub fn derive_jacks(det: &HandsDetection) -> [Option<f32>; N_HANDS_JACKS] {
    let mut out = [None; N_HANDS_JACKS];

    // Positions: engine coords are [-1, 1] -> 0..10 V (unipolar;
    // frame-center reads 5 V).
    let volts = |c: f32| c * 5.0 + 5.0;
    let l = det.left.as_ref().map(centroid);
    let r = det.right.as_ref().map(centroid);
    if let Some((x, y)) = l {
        out[jack::LX] = Some(volts(x));
        out[jack::LY] = Some(volts(y));
    }
    if let Some((x, y)) = r {
        out[jack::RX] = Some(volts(x));
        out[jack::RY] = Some(volts(y));
    }

    // Combined centroid: over all visible hands' landmarks.
    match (l, r) {
        (Some((lx, ly)), Some((rx, ry))) => {
            out[jack::CX] = Some(volts((lx + rx) * 0.5));
            out[jack::CY] = Some(volts((ly + ry) * 0.5));
        }
        (Some((x, y)), None) | (None, Some((x, y))) => {
            out[jack::CX] = Some(volts(x));
            out[jack::CY] = Some(volts(y));
        }
        (None, None) => {}
    }

    // Right-minus-left centroid delta; needs both hands.
    if let (Some((lx, ly)), Some((rx, ry))) = (l, r) {
        out[jack::DX] = Some(clamp((rx - lx) * 5.0, -10.0, 10.0));
        out[jack::DY] = Some(clamp((ry - ly) * 5.0, -10.0, 10.0));
    }

    // Pinch: ratio -> volts, minus 1 V so a full physical pinch (whose
    // ratio bottoms out around 0.2 — thumb and index TIP centers can't
    // coincide) reads 0 V instead of idling at ~1 V.
    if let Some(pts) = &det.left {
        if let Some(p) = pinch_ratio(pts) {
            out[jack::L_PINCH] = Some(clamp(p * 5.0 - 1.0, 0.0, 10.0));
        }
        if let Some(a) = thumb_rotation(pts, true) {
            out[jack::L_ROT] = Some(clamp(a * (10.0 / std::f32::consts::PI), -10.0, 10.0));
        }
    }
    if let Some(pts) = &det.right {
        if let Some(p) = pinch_ratio(pts) {
            out[jack::R_PINCH] = Some(clamp(p * 5.0 - 1.0, 0.0, 10.0));
        }
        if let Some(a) = thumb_rotation(pts, false) {
            out[jack::R_ROT] = Some(clamp(a * (10.0 / std::f32::consts::PI), -10.0, 10.0));
        }
    }

    // Visibility gates always update — they are the dropout signal.
    out[jack::L_SEEN] = Some(if det.left.is_some() { 10.0 } else { 0.0 });
    out[jack::R_SEEN] = Some(if det.right.is_some() { 10.0 } else { 0.0 });

    out
}

/// Per-hand debounced visibility (see the module docs' dropout policy).
#[derive(Debug, Default)]
struct DebouncedVis {
    committed: bool,
    /// Consecutive frames the raw visibility has disagreed with
    /// `committed`.
    streak: u8,
}

/// Value jacks owned by each hand (decayed when that hand is lost).
const LEFT_VALUE_JACKS: [usize; 4] = [jack::LX, jack::LY, jack::L_PINCH, jack::L_ROT];
const RIGHT_VALUE_JACKS: [usize; 4] = [jack::RX, jack::RY, jack::R_PINCH, jack::R_ROT];

/// Control-plane state per Hands node: debounces hand visibility so a
/// single misdetected frame causes no thrash, dedups per-jack values so
/// a static hand doesn't flood the event ring at camera rate, and turns
/// confirmed hand loss into decay-to-zero emissions.
#[derive(Debug, Default)]
pub struct HandsControl {
    last: [Option<f32>; N_HANDS_JACKS],
    vis: [DebouncedVis; 2], // [left, right]
}

impl HandsControl {
    /// Evaluate one tracked frame; `emit(jack, value, decay)` is called
    /// for each jack that changes — `decay = true` means "ramp to
    /// `value` over [`DECAY_SECONDS`]" (hand loss), `false` means apply
    /// at the event's frame as usual. `None` = dropped/failed frame:
    /// nothing updates (values AND gates hold — the tracker said
    /// nothing, which is different from "no hands seen").
    pub fn feed(&mut self, det: Option<&HandsDetection>, mut emit: impl FnMut(usize, f32, bool)) {
        let Some(det) = det else { return };

        // Debounce raw visibility into committed visibility.
        let raw = [det.left.is_some(), det.right.is_some()];
        let mut newly_lost = [false; 2];
        for (h, vis) in self.vis.iter_mut().enumerate() {
            if raw[h] == vis.committed {
                vis.streak = 0;
                continue;
            }
            vis.streak += 1;
            if vis.streak >= DEBOUNCE_FRAMES {
                vis.committed = raw[h];
                vis.streak = 0;
                newly_lost[h] = !raw[h];
            }
        }

        // Derive from the DEBOUNCED detection: an unconfirmed change
        // contributes nothing this frame (glitch frames hold).
        let eff = HandsDetection {
            left: if self.vis[0].committed {
                det.left
            } else {
                None
            },
            right: if self.vis[1].committed {
                det.right
            } else {
                None
            },
        };
        let mut values = derive_jacks(&eff);
        // The gates report COMMITTED visibility, not this frame's raw
        // one — a committed hand whose data glitched out for a frame
        // keeps its gate high while its values hold.
        values[jack::L_SEEN] = Some(if self.vis[0].committed { 10.0 } else { 0.0 });
        values[jack::R_SEEN] = Some(if self.vis[1].committed { 10.0 } else { 0.0 });
        for (j, v) in values.iter().enumerate() {
            let Some(v) = *v else { continue };
            if self.last[j] != Some(v) {
                self.last[j] = Some(v);
                emit(j, v, false);
            }
        }

        // Confirmed hand loss: decay its value jacks (and the two-hand
        // deltas; the combined centroid too once no hand remains) to
        // 0 V. `last` is cleared so a reappearing hand always re-emits.
        let both_gone = !self.vis[0].committed && !self.vis[1].committed;
        for (h, hand_jacks) in [LEFT_VALUE_JACKS, RIGHT_VALUE_JACKS].iter().enumerate() {
            if !newly_lost[h] {
                continue;
            }
            let mut decayed: Vec<usize> = hand_jacks.to_vec();
            decayed.extend([jack::DX, jack::DY]);
            if both_gone {
                decayed.extend([jack::CX, jack::CY]);
            }
            for j in decayed {
                self.last[j] = None;
                emit(j, 0.0, true);
            }
        }
    }
}

/// A control-thread-produced value for one jack, applied on the RT
/// thread at (or after) `frame` on the engine sample clock.
/// `ramp_frames` > 0 means "reach `value` linearly over that many
/// samples" (hand-loss decay); 0 means apply immediately.
#[derive(Debug, Clone, Copy)]
pub struct HandsEvent {
    pub frame: u64,
    pub jack: u16,
    pub ramp_frames: u32,
    pub value: f32,
}

/// RT-side module: pops jack-value events from the SPSC ring and renders
/// them as held output signals (last value persists until the next
/// event) with per-jack linear ramps for the hand-loss decay.
pub struct HandsRtModule {
    consumer: rtrb::Consumer<HandsEvent>,
    values: [f32; N_HANDS_JACKS],
    ramp_target: [f32; N_HANDS_JACKS],
    ramp_remaining: [u32; N_HANDS_JACKS],
    frame: u64,
}

impl HandsRtModule {
    /// `start_frame` seeds the module's local sample clock from the
    /// ENGINE clock — feeds are stamped `Engine::current_frame()`, so a
    /// module added mid-session that started local at 0 would see every
    /// event as far-future and freeze (regression-tested in
    /// tests/integration/hands.rs).
    pub fn new(consumer: rtrb::Consumer<HandsEvent>, start_frame: u64) -> Self {
        HandsRtModule {
            consumer,
            values: [0.0; N_HANDS_JACKS],
            ramp_target: [0.0; N_HANDS_JACKS],
            ramp_remaining: [0; N_HANDS_JACKS],
            frame: start_frame,
        }
    }

    fn apply(&mut self, ev: &HandsEvent) {
        let j = ev.jack as usize;
        if j >= N_HANDS_JACKS {
            return;
        }
        if ev.ramp_frames > 0 {
            self.ramp_target[j] = ev.value;
            self.ramp_remaining[j] = ev.ramp_frames;
        } else {
            // A fresh measurement supersedes any in-flight decay.
            self.values[j] = ev.value;
            self.ramp_remaining[j] = 0;
        }
    }
}

impl HostModule for HandsRtModule {
    fn process(
        &mut self,
        _inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        let block_start = self.frame;
        for s in 0..frames {
            let now = block_start + s as u64;
            // Sample-accurate within the block; late/past events apply
            // immediately (same policy as MIDI).
            loop {
                match self.consumer.peek() {
                    Ok(ev) if ev.frame <= now => {
                        let ev = *ev;
                        let _ = self.consumer.pop();
                        self.apply(&ev);
                    }
                    _ => break,
                }
            }
            for j in 0..N_HANDS_JACKS {
                let rem = self.ramp_remaining[j];
                if rem > 0 {
                    self.values[j] += (self.ramp_target[j] - self.values[j]) / rem as f32;
                    self.ramp_remaining[j] = rem - 1;
                }
            }
            for (o, out) in outputs.iter_mut().enumerate().take(N_HANDS_JACKS) {
                out[s] = self.values[o];
            }
        }
        self.frame = block_start + frames as u64;
    }

    fn save_state(&mut self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(N_HANDS_JACKS * 4);
        for v in &self.values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes
    }

    fn load_state(&mut self, bytes: &[u8]) {
        for (i, chunk) in bytes
            .as_chunks::<4>()
            .0
            .iter()
            .enumerate()
            .take(N_HANDS_JACKS)
        {
            self.values[i] = f32::from_le_bytes(*chunk);
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic upright hand: wrist at (x, y), palm axis straight up
    /// (middle MCP `span` above the wrist), thumb tip `pinch` away from
    /// the index tip. `thumb_dir` is the thumb direction as (dx, dy).
    fn hand(
        x: f32,
        y: f32,
        span: f32,
        pinch: f32,
        thumb_dir: (f32, f32),
    ) -> [[f32; 3]; N_LANDMARKS] {
        let mut pts = [[0.0f32; 3]; N_LANDMARKS];
        for (i, p) in pts.iter_mut().enumerate() {
            // Spread the remaining landmarks deterministically so the
            // centroid is well-defined but unremarkable.
            *p = [x + 0.01 * i as f32, y + 0.01 * i as f32, 0.0];
        }
        pts[WRIST] = [x, y, 0.0];
        pts[MIDDLE_MCP] = [x, y + span, 0.0];
        pts[INDEX_TIP] = [x, y + span * 1.6, 0.0];
        pts[THUMB_MCP] = [x, y + span * 0.3, 0.0];
        pts[THUMB_TIP] = [
            pts[THUMB_MCP][0] + thumb_dir.0,
            pts[THUMB_MCP][1] + thumb_dir.1,
            0.0,
        ];
        // Keep the pinch distance as requested: place index tip pinch
        // away from thumb tip along x.
        pts[INDEX_TIP] = [pts[THUMB_TIP][0] + pinch, pts[THUMB_TIP][1], 0.0];
        pts
    }

    #[test]
    fn centroid_jacks_scale_engine_coords_to_volts() {
        let det = HandsDetection {
            left: Some(hand(-0.4, 0.2, 0.3, 0.1, (-0.1, 0.1))),
            right: Some(hand(0.4, 0.2, 0.3, 0.1, (0.1, 0.1))),
        };
        let v = derive_jacks(&det);
        let (lc, rc) = (
            centroid(det.left.as_ref().unwrap()),
            centroid(det.right.as_ref().unwrap()),
        );
        assert!((v[jack::LX].unwrap() - (lc.0 * 5.0 + 5.0)).abs() < 1e-6);
        assert!((v[jack::RY].unwrap() - (rc.1 * 5.0 + 5.0)).abs() < 1e-6);
        assert!((v[jack::CX].unwrap() - ((lc.0 + rc.0) * 2.5 + 5.0)).abs() < 1e-6);
        // dx is right minus left, in volts.
        assert!((v[jack::DX].unwrap() - (rc.0 - lc.0) * 5.0).abs() < 1e-5);
        assert_eq!(v[jack::L_SEEN], Some(10.0));
        assert_eq!(v[jack::R_SEEN], Some(10.0));
    }

    #[test]
    fn single_hand_centroid_and_held_jacks() {
        let det = HandsDetection {
            left: None,
            right: Some(hand(0.4, 0.0, 0.3, 0.1, (0.1, 0.1))),
        };
        let v = derive_jacks(&det);
        // Combined centroid follows the only visible hand.
        assert_eq!(v[jack::CX], v[jack::RX]);
        // Left-hand jacks and the deltas produce NO update (hold).
        assert_eq!(v[jack::LX], None);
        assert_eq!(v[jack::DX], None);
        assert_eq!(v[jack::L_PINCH], None);
        // Gates always update.
        assert_eq!(v[jack::L_SEEN], Some(0.0));
        assert_eq!(v[jack::R_SEEN], Some(10.0));
    }

    #[test]
    fn pinch_is_scale_invariant() {
        // Same pose, 2x the apparent size (hand closer to the camera).
        let near = hand(0.0, 0.0, 0.6, 0.2, (0.2, 0.2));
        let far = hand(0.0, 0.0, 0.3, 0.1, (0.1, 0.1));
        let p_near = pinch_ratio(&near).unwrap();
        let p_far = pinch_ratio(&far).unwrap();
        assert!(
            (p_near - p_far).abs() < 1e-6,
            "pinch must not depend on hand scale: {p_near} vs {p_far}"
        );
        // And touching reads smaller than spread.
        let spread = hand(0.0, 0.0, 0.3, 0.35, (0.1, 0.1));
        assert!(pinch_ratio(&spread).unwrap() > p_far);
    }

    #[test]
    fn thumb_out_is_positive_for_both_hands() {
        // Palm axis up. Right hand in mirror view: thumb out points
        // toward -x; left hand: toward +x.
        let right_out = hand(0.3, 0.0, 0.3, 0.1, (-0.15, 0.05));
        let left_out = hand(-0.3, 0.0, 0.3, 0.1, (0.15, 0.05));
        assert!(thumb_rotation(&right_out, false).unwrap() > 0.2);
        assert!(thumb_rotation(&left_out, true).unwrap() > 0.2);
        // Tucked across the palm goes negative.
        let right_tucked = hand(0.3, 0.0, 0.3, 0.1, (0.12, 0.02));
        assert!(thumb_rotation(&right_tucked, false).unwrap() < 0.0);
    }

    #[test]
    fn pinch_volts_floor_at_zero_when_fully_pinched() {
        // Thumb tip touching the index tip: the ratio bottoms out near
        // 0.2, which the -1 V offset must map to 0 V, not ~1 V.
        let touching = HandsDetection {
            left: None,
            right: Some(hand(0.0, 0.0, 0.3, 0.0, (0.1, 0.1))),
        };
        let v = derive_jacks(&touching);
        assert_eq!(v[jack::R_PINCH], Some(0.0));
        // A mid pinch still reads meaningfully above zero.
        let mid = HandsDetection {
            left: None,
            right: Some(hand(0.0, 0.0, 0.3, 0.15, (0.1, 0.1))),
        };
        assert!(derive_jacks(&mid)[jack::R_PINCH].unwrap() > 0.5);
    }

    #[test]
    fn control_dedups_and_holds_on_dropout() {
        let mut ctl = HandsControl::default();
        let det = HandsDetection {
            left: None,
            right: Some(hand(0.4, 0.0, 0.3, 0.1, (0.1, 0.1))),
        };
        let mut events: Vec<(usize, f32, bool)> = Vec::new();
        let feed = |ctl: &mut HandsControl,
                    det: Option<&HandsDetection>,
                    events: &mut Vec<(usize, f32, bool)>| {
            ctl.feed(det, |j, v, d| events.push((j, v, d)));
        };
        // Appearance debounce: the first frame with the hand commits
        // nothing but the (not yet raised) gate state.
        feed(&mut ctl, Some(&det), &mut events);
        assert!(events
            .iter()
            .all(|&(j, ..)| j == jack::R_SEEN || j == jack::L_SEEN));
        events.clear();
        // Second consecutive frame confirms the hand: values emit.
        feed(&mut ctl, Some(&det), &mut events);
        assert!(events.iter().any(|&(j, ..)| j == jack::RX));
        assert!(events.contains(&(jack::R_SEEN, 10.0, false)));
        // Same detection again: nothing changed, nothing emitted.
        events.clear();
        feed(&mut ctl, Some(&det), &mut events);
        assert!(
            events.is_empty(),
            "static hand must not re-emit: {events:?}"
        );
        // Dropped frame: nothing emitted (everything holds).
        feed(&mut ctl, None, &mut events);
        assert!(events.is_empty());
        // ONE frame without the hand: debounce absorbs it (no thrash).
        let gone = HandsDetection::default();
        feed(&mut ctl, Some(&gone), &mut events);
        assert!(events.is_empty(), "single bad frame must hold: {events:?}");
        // And a recovery frame resets the streak without emitting.
        feed(&mut ctl, Some(&det), &mut events);
        assert!(events.is_empty());
        // Two consecutive gone frames confirm the loss: the gate falls
        // and the hand's value jacks (+deltas/centroid — no other hand)
        // decay to zero.
        feed(&mut ctl, Some(&gone), &mut events);
        assert!(events.is_empty());
        feed(&mut ctl, Some(&gone), &mut events);
        assert!(events.contains(&(jack::R_SEEN, 0.0, false)));
        for j in [
            jack::RX,
            jack::RY,
            jack::R_PINCH,
            jack::R_ROT,
            jack::DX,
            jack::CX,
        ] {
            assert!(
                events.contains(&(j, 0.0, true)),
                "jack {j} must decay to 0: {events:?}"
            );
        }
        // Reappearing for two frames re-emits values (last was cleared).
        events.clear();
        feed(&mut ctl, Some(&det), &mut events);
        feed(&mut ctl, Some(&det), &mut events);
        assert!(events.iter().any(|&(j, _, d)| j == jack::RX && !d));
    }

    #[test]
    fn manifest_matches_jack_table() {
        let m = hands_manifest();
        assert_eq!(m.outputs.len(), N_HANDS_JACKS);
        assert_eq!(m.outputs[jack::CX].id, "cx");
        assert_eq!(m.outputs[jack::R_ROT].id, "r_rot");
        assert_eq!(m.outputs[jack::R_SEEN].id, "r_seen");
        assert!(m.inputs.is_empty());
    }
}
