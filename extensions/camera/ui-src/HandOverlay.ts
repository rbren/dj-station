// Canvas renderer for the hand-tracking overlay (PRD §4.3). Pure
// drawing — no React, no MediaPipe — so it is testable with a stubbed
// 2D context.
//
// The overlay canvas sits on top of the <video> and is never baked into
// the video texture (R-13): hiding the canvas returns the module to a
// plain camera display. Left and right hands get different colours with
// the physical-hand label drawn at the wrist (R-11) — a handedness bug
// is immediately visible instead of mysterious. Per-hand tracking
// confidence drives overlay opacity (R-12).

import {
  FINGERTIPS,
  HAND_CONNECTIONS,
  WRIST,
  projectToCanvas,
  type HandFrame,
  type TrackedHand,
} from "./handTracking";

export const HAND_COLORS: Record<TrackedHand["hand"], string> = {
  left: "#4fc3f7", // cyan
  right: "#ffb74d", // orange
};
export const HAND_LABELS: Record<TrackedHand["hand"], string> = {
  left: "L",
  right: "R",
};

const POINT_R = 2.5;
const TIP_R = 4.5; // fingertips visually distinct (R-10)
const MIN_ALPHA = 0.2; // a barely-tracked hand stays (faintly) visible

export function drawHandFrame(
  ctx: CanvasRenderingContext2D,
  frame: HandFrame,
  videoW: number,
  videoH: number,
  canvasW: number,
  canvasH: number,
): void {
  ctx.clearRect(0, 0, canvasW, canvasH);
  if (videoW <= 0 || videoH <= 0) return;

  for (const hand of frame.hands) {
    const color = HAND_COLORS[hand.hand];
    const pts = hand.points.map((p) =>
      projectToCanvas(p, videoW, videoH, canvasW, canvasH),
    );
    ctx.globalAlpha = Math.max(MIN_ALPHA, Math.min(1, hand.score));
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;

    // Skeleton connections first, points on top (R-9).
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
    }
    ctx.stroke();

    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(
        pts[i].x,
        pts[i].y,
        FINGERTIPS.includes(i) ? TIP_R : POINT_R,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }

    ctx.font = "bold 12px sans-serif";
    ctx.fillText(HAND_LABELS[hand.hand], pts[WRIST].x + 8, pts[WRIST].y + 4);
  }
  ctx.globalAlpha = 1;
}

export function clearOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h);
}
