// Diagnostics accumulator for the hand-tracking loop (PRD §4.4). Pure
// state machine, fed once per requestVideoFrameCallback tick; the panel
// polls `snapshot()` for the dev readout.
//
// It answers one question before the CV-output phase starts: is there
// enough temporal resolution for onset detection? So it reports
//  - delivered camera fps (measured from mediaTime deltas — what the
//    webcam actually supplies, not what getUserMedia was asked for, R-5),
//  - inference time per frame,
//  - end-to-end latency (frame capture -> overlay drawn),
//  - dropped/invalid frame count (rVFC ticks whose mediaTime did not
//    advance, or where inference threw),
//  - the active delegate (set by the caller, R-4).

import type { Delegate } from "./handLandmarker";

export interface TrackingStats {
  /** Delivered camera fps, measured over the sliding window. */
  cameraFps: number;
  /** Mean inference time per frame, ms. */
  inferenceMs: number;
  /** Mean end-to-end latency (capture -> overlay), ms. */
  latencyMs: number;
  /** Frames skipped or failed since tracking started. */
  droppedFrames: number;
  delegate: Delegate | null;
}

const WINDOW = 60; // frames; ~1-2 s of history

export class StatsAccumulator {
  private mediaTimes: number[] = [];
  private inferTimes: number[] = [];
  private latencies: number[] = [];
  private dropped = 0;
  private lastMediaTime = -1;
  delegate: Delegate | null = null;

  /**
   * One rVFC tick. `mediaTime` is the frame's timestamp (seconds);
   * `inferMs` inference cost; `latencyMs` capture->drawn. Returns false
   * (and counts a drop) when the frame did not advance — the caller
   * should skip inference for it.
   */
  frameArrived(mediaTime: number): boolean {
    if (mediaTime <= this.lastMediaTime) {
      this.dropped++;
      return false;
    }
    this.lastMediaTime = mediaTime;
    this.mediaTimes.push(mediaTime);
    if (this.mediaTimes.length > WINDOW) this.mediaTimes.shift();
    return true;
  }

  frameProcessed(inferMs: number, latencyMs: number): void {
    this.inferTimes.push(inferMs);
    this.latencies.push(latencyMs);
    if (this.inferTimes.length > WINDOW) this.inferTimes.shift();
    if (this.latencies.length > WINDOW) this.latencies.shift();
  }

  frameFailed(): void {
    this.dropped++;
  }

  snapshot(): TrackingStats {
    const mt = this.mediaTimes;
    const span = mt.length >= 2 ? mt[mt.length - 1] - mt[0] : 0;
    const mean = (xs: number[]) =>
      xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    return {
      cameraFps: span > 0 ? (mt.length - 1) / span : 0,
      inferenceMs: mean(this.inferTimes),
      latencyMs: mean(this.latencies),
      droppedFrames: this.dropped,
      delegate: this.delegate,
    };
  }

  reset(): void {
    this.mediaTimes = [];
    this.inferTimes = [];
    this.latencies = [];
    this.dropped = 0;
    this.lastMediaTime = -1;
    this.delegate = null;
  }
}
