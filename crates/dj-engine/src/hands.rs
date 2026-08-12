//! Built-in Hands module (`builtin.hands`): CV outputs derived from the
//! camera panel's MediaPipe hand tracking.
//!
//! Architecturally the Gesture module's sibling with a FIXED jack set:
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
//! A hand that leaves the frame produces NO events for its value jacks —
//! the RT module holds the last value (same law as gesture frame drops).
//! The `seen` gates are the exception: they report visibility itself
//! (10 V tracked / 0 V not), so patches can distinguish "hand at center"
//! from "no hand".

use crate::manifest::{categories, Manifest, OutputDecl};
use crate::module_host::HostModule;
use serde::{Deserialize, Serialize};

pub const HANDS_ID: &str = "builtin.hands";

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
        inputs: vec![],
        outputs: JACKS
            .iter()
            .map(|(id, name)| OutputDecl {
                id: (*id).into(),
                name: (*name).into(),
                display: None,
            })
            .collect(),
        params: vec![],
        ui: None,
        latency_samples: 0,
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

/// A recorded landmark trace for offline renders / E2E goldens (the
/// hands analogue of `dj_gesture::PoseTrace`).
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

    // Positions: engine coords are [-1, 1] -> ±5 V.
    let l = det.left.as_ref().map(centroid);
    let r = det.right.as_ref().map(centroid);
    if let Some((x, y)) = l {
        out[jack::LX] = Some(x * 5.0);
        out[jack::LY] = Some(y * 5.0);
    }
    if let Some((x, y)) = r {
        out[jack::RX] = Some(x * 5.0);
        out[jack::RY] = Some(y * 5.0);
    }

    // Combined centroid: over all visible hands' landmarks.
    match (l, r) {
        (Some((lx, ly)), Some((rx, ry))) => {
            out[jack::CX] = Some((lx + rx) * 0.5 * 5.0);
            out[jack::CY] = Some((ly + ry) * 0.5 * 5.0);
        }
        (Some((x, y)), None) | (None, Some((x, y))) => {
            out[jack::CX] = Some(x * 5.0);
            out[jack::CY] = Some(y * 5.0);
        }
        (None, None) => {}
    }

    // Right-minus-left centroid delta; needs both hands.
    if let (Some((lx, ly)), Some((rx, ry))) = (l, r) {
        out[jack::DX] = Some(clamp((rx - lx) * 5.0, -10.0, 10.0));
        out[jack::DY] = Some(clamp((ry - ly) * 5.0, -10.0, 10.0));
    }

    if let Some(pts) = &det.left {
        if let Some(p) = pinch_ratio(pts) {
            out[jack::L_PINCH] = Some(clamp(p * 5.0, 0.0, 10.0));
        }
        if let Some(a) = thumb_rotation(pts, true) {
            out[jack::L_ROT] = Some(clamp(a * (10.0 / std::f32::consts::PI), -10.0, 10.0));
        }
    }
    if let Some(pts) = &det.right {
        if let Some(p) = pinch_ratio(pts) {
            out[jack::R_PINCH] = Some(clamp(p * 5.0, 0.0, 10.0));
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

/// Control-plane state per Hands node: dedups per-jack values so a
/// static hand doesn't flood the event ring at camera rate.
#[derive(Debug, Default)]
pub struct HandsControl {
    last: [Option<f32>; N_HANDS_JACKS],
}

impl HandsControl {
    /// Evaluate one tracked frame; `emit(jack, value)` is called for
    /// each jack whose value changed. `None` = dropped/failed frame:
    /// nothing updates (values AND gates hold — the tracker said
    /// nothing, which is different from "no hands seen").
    pub fn feed(&mut self, det: Option<&HandsDetection>, mut emit: impl FnMut(usize, f32)) {
        let Some(det) = det else { return };
        let values = derive_jacks(det);
        for (j, v) in values.iter().enumerate() {
            let Some(v) = *v else { continue };
            if self.last[j] != Some(v) {
                self.last[j] = Some(v);
                emit(j, v);
            }
        }
    }
}

/// A control-thread-produced value for one jack, applied on the RT
/// thread at (or after) `frame` on the engine sample clock.
#[derive(Debug, Clone, Copy)]
pub struct HandsEvent {
    pub frame: u64,
    pub jack: u16,
    pub value: f32,
}

/// RT-side module: pops jack-value events from the SPSC ring and renders
/// them as held output signals (last value persists until the next
/// event — a vanished hand upstream just means no events).
pub struct HandsRtModule {
    consumer: rtrb::Consumer<HandsEvent>,
    values: [f32; N_HANDS_JACKS],
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
            frame: start_frame,
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
            // immediately (same policy as MIDI/gesture).
            loop {
                match self.consumer.peek() {
                    Ok(ev) if ev.frame <= now => {
                        let ev = *ev;
                        let _ = self.consumer.pop();
                        if (ev.jack as usize) < N_HANDS_JACKS {
                            self.values[ev.jack as usize] = ev.value;
                        }
                    }
                    _ => break,
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
        for (i, chunk) in bytes.chunks_exact(4).enumerate().take(N_HANDS_JACKS) {
            self.values[i] = f32::from_le_bytes(chunk.try_into().unwrap());
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
        assert!((v[jack::LX].unwrap() - lc.0 * 5.0).abs() < 1e-6);
        assert!((v[jack::RY].unwrap() - rc.1 * 5.0).abs() < 1e-6);
        assert!((v[jack::CX].unwrap() - (lc.0 + rc.0) * 2.5).abs() < 1e-6);
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
    fn control_dedups_and_holds_on_dropout() {
        let mut ctl = HandsControl::default();
        let det = HandsDetection {
            left: None,
            right: Some(hand(0.4, 0.0, 0.3, 0.1, (0.1, 0.1))),
        };
        let mut events: Vec<(usize, f32)> = Vec::new();
        ctl.feed(Some(&det), |j, v| events.push((j, v)));
        let first = events.len();
        assert!(first > 0);
        // Same detection again: nothing changed, nothing emitted.
        events.clear();
        ctl.feed(Some(&det), |j, v| events.push((j, v)));
        assert!(
            events.is_empty(),
            "static hand must not re-emit: {events:?}"
        );
        // Dropped frame: nothing emitted (everything holds).
        ctl.feed(None, |j, v| events.push((j, v)));
        assert!(events.is_empty());
        // Hand vanishes: only the gate falls; value jacks hold.
        let gone = HandsDetection::default();
        ctl.feed(Some(&gone), |j, v| events.push((j, v)));
        assert_eq!(events, vec![(jack::R_SEEN, 0.0)]);
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
