// Hand-tracking conventions for the camera module. Pure functions, no
// MediaPipe dependency — everything here is unit-testable in jsdom.
//
// THE CONVENTIONS BELOW ARE LOAD-BEARING (PRD hand-tracking §4.2): the
// later CV-output phases inherit them, so they are fixed here, once, at
// the tracker boundary — not re-derived per consumer.
//
// ## Mirroring (R-7)
//
// The camera panel displays a MIRROR: the <video> is CSS-flipped
// (scaleX(-1)) so moving your hand to your right moves it right on
// screen. The tracker, however, is fed the RAW (unmirrored) camera
// frames — we never repaint the video just to flip it.
//
// MediaPipe's handedness classifier assumes its input is already
// mirrored (selfie-style). Ours is not, so the label it emits names the
// WRONG physical hand and must be swapped exactly once, here, in
// `physicalHand`. Verification: raise your RIGHT hand — the wrist label
// drawn in the overlay must read "R". A fixture test with a known
// physical-right-hand frame pins this mapping.
//
// ## Coordinates (R-8)
//
// Engine-space landmark coordinates are: X right, Y UP, origin at the
// FRAME CENTER, normalized to [-1, +1] over the camera frame. "Right"
// means the user's right in the mirror view (physical right hand moving
// rightward is +X). MediaPipe image coordinates (x right, y DOWN, origin
// top-left, [0, 1], unmirrored) are converted in `toEngineCoords` — the
// only place image coordinates exist. Z keeps MediaPipe's scale
// (roughly comparable to X), sign flipped so +Z is toward the viewer.
//
// Every landmark set carries the `mediaTime` timestamp of the video
// frame it was measured on (R-6); nothing in this phase consumes it,
// everything after this phase does.

/** A landmark in engine space: X right, Y up, origin center, [-1, 1]. */
export interface EnginePoint {
  x: number;
  y: number;
  z: number;
}

export type PhysicalHand = "left" | "right";

export interface TrackedHand {
  /** Physical hand, after the mirroring swap (see module docs). */
  hand: PhysicalHand;
  /** Tracking confidence 0..1 (MediaPipe handedness score). */
  score: number;
  /** The 21 hand landmarks in engine coordinates. */
  points: EnginePoint[];
}

export interface HandFrame {
  /** Video-frame timestamp (seconds) from requestVideoFrameCallback. */
  mediaTime: number;
  hands: TrackedHand[];
}

/** Structural subset of MediaPipe's HandLandmarkerResult. */
export interface RawHandResult {
  landmarks: { x: number; y: number; z: number }[][];
  handedness: { categoryName: string; score: number }[][];
}

export const WRIST = 0;
/** Fingertip landmark indices: thumb, index, middle, ring, pinky (R-10). */
export const FINGERTIPS: readonly number[] = [4, 8, 12, 16, 20];

/** The 21-landmark hand skeleton (MediaPipe connection topology, R-9). */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

/**
 * Image coords (x right, y down, [0,1], unmirrored) -> engine coords
 * (X right in the mirror view, Y up, origin center, [-1,1]).
 */
export function toEngineCoords(lm: {
  x: number;
  y: number;
  z: number;
}): EnginePoint {
  return {
    x: 1 - 2 * lm.x, // mirror + center: image-left is the user's right
    y: 1 - 2 * lm.y, // flip + center: Y up
    z: -2 * lm.z, // +Z toward the viewer, MediaPipe scale
  };
}

/**
 * MediaPipe label -> physical hand. MediaPipe assumes mirrored input;
 * we feed unmirrored frames, so its label is swapped (module docs).
 */
export function physicalHand(mediapipeLabel: string): PhysicalHand {
  return mediapipeLabel === "Left" ? "right" : "left";
}

/** Boundary conversion: one raw MediaPipe result -> one HandFrame. */
export function resolveHands(
  result: RawHandResult,
  mediaTime: number,
): HandFrame {
  const hands: TrackedHand[] = [];
  for (let i = 0; i < result.landmarks.length; i++) {
    const cat = result.handedness[i]?.[0];
    if (!cat) continue;
    hands.push({
      hand: physicalHand(cat.categoryName),
      score: cat.score,
      points: result.landmarks[i].map(toEngineCoords),
    });
  }
  return { mediaTime, hands };
}

/**
 * Project an engine-space point onto the overlay canvas.
 *
 * The video fills the frame with object-fit: cover, so a camera whose
 * aspect differs from the monitor's is scaled and center-cropped; the
 * overlay must apply the same mapping or landmarks drift off the hand
 * (the "no visible offset" acceptance line). The canvas is NOT
 * CSS-mirrored (mirrored canvases render text backwards) — engine X is
 * already mirror-view, so the projection is direct.
 */
export function projectToCanvas(
  pt: EnginePoint,
  videoW: number,
  videoH: number,
  canvasW: number,
  canvasH: number,
): { x: number; y: number } {
  const scale = Math.max(canvasW / videoW, canvasH / videoH);
  const drawnW = videoW * scale;
  const drawnH = videoH * scale;
  const offX = (canvasW - drawnW) / 2;
  const offY = (canvasH - drawnH) / 2;
  return {
    x: offX + ((1 + pt.x) / 2) * drawnW,
    y: offY + ((1 - pt.y) / 2) * drawnH,
  };
}
