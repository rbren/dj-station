// Thin wrapper around MediaPipe's HandLandmarker (@mediapipe/tasks-vision,
// Apache 2.0, WASM build running in the webview — R-1).
//
// The runtime and model are vendored under /mediapipe/ in the app bundle
// (app/scripts/fetch-mediapipe-assets.mjs) so opening a patch never
// touches the network (R-2). Configured for two hands in VIDEO mode —
// image mode would discard the tracker's inter-frame state and is both
// slower and jumpier (R-3). GPU delegate is attempted first with a CPU
// fallback, and the active delegate is surfaced + logged so performance
// numbers can be interpreted (R-4).
//
// This module is the only importer of @mediapipe/tasks-vision; the
// dynamic import keeps the ~150 KB vision bundle out of the app's
// startup path (the ~12 MB WASM is fetched lazily by MediaPipe itself).

import type { HandLandmarker as MpHandLandmarker } from "@mediapipe/tasks-vision";
import type { RawHandResult } from "./handTracking";

export type Delegate = "GPU" | "CPU";

export interface LandmarkerHandle {
  delegate: Delegate;
  /** Synchronous per-frame inference; timestamp in ms, monotonic. */
  detect(video: HTMLVideoElement, timestampMs: number): RawHandResult;
  close(): void;
}

const WASM_BASE = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/hand_landmarker.task";

export async function createHandLandmarker(): Promise<LandmarkerHandle> {
  const { FilesetResolver, HandLandmarker } =
    await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const options = (delegate: Delegate) => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: "VIDEO" as const,
    numHands: 2,
  });

  let delegate: Delegate = "GPU";
  let landmarker: MpHandLandmarker;
  try {
    landmarker = await HandLandmarker.createFromOptions(
      fileset,
      options("GPU"),
    );
  } catch (err) {
    console.warn(
      "[camera] GPU delegate unavailable, falling back to CPU:",
      err,
    );
    delegate = "CPU";
    landmarker = await HandLandmarker.createFromOptions(
      fileset,
      options("CPU"),
    );
  }
  console.info(`[camera] hand tracking active delegate: ${delegate}`);

  const lm = landmarker;
  return {
    delegate,
    detect: (video, timestampMs) => lm.detectForVideo(video, timestampMs),
    close: () => lm.close(),
  };
}
