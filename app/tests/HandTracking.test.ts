// Pins the hand-tracking conventions locked in by the camera module
// (extensions/camera/ui-src/handTracking.ts — the canonical write-up):
//
//  - Mirroring (R-7): the tracker sees RAW camera frames while the
//    display is CSS-mirrored; MediaPipe assumes mirrored input, so its
//    handedness label names the wrong physical hand and is swapped
//    exactly once, at the boundary.
//  - Coordinates (R-8): engine space is X right (mirror view), Y UP,
//    origin at frame center, normalized [-1, 1]; image space (y down,
//    origin top-left) is converted once, in toEngineCoords.
//
// The known-handedness fixture (tests/fixtures/right-hand-raised.json)
// is a deterministic synthetic frame: a physical RIGHT hand raised in
// an unmirrored frame lands on the image-LEFT half and MediaPipe labels
// it 'Left'. The geometry is hand-authored (described in the fixture's
// description field), never a video binary.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FINGERTIPS,
  HAND_CONNECTIONS,
  WRIST,
  physicalHand,
  projectToCanvas,
  resolveHands,
  toEngineCoords,
  type RawHandResult,
} from '../../extensions/camera/ui-src/handTracking';

const fixture = JSON.parse(readFileSync('tests/fixtures/right-hand-raised.json', 'utf-8')) as {
  physicalHand: 'left' | 'right';
  mediaTime: number;
  result: RawHandResult;
};

describe('coordinate convention (R-8)', () => {
  it('maps image top-left to engine (+1, +1): mirror + Y up', () => {
    expect(toEngineCoords({ x: 0, y: 0, z: 0 })).toEqual({ x: 1, y: 1, z: -0 });
  });

  it('maps image bottom-right to engine (-1, -1)', () => {
    expect(toEngineCoords({ x: 1, y: 1, z: 0 })).toEqual({ x: -1, y: -1, z: -0 });
  });

  it('maps the image center to the origin', () => {
    expect(toEngineCoords({ x: 0.5, y: 0.5, z: 0 })).toEqual({ x: 0, y: 0, z: -0 });
  });

  it('flips Z so positive is toward the viewer', () => {
    // MediaPipe z is negative toward the camera.
    expect(toEngineCoords({ x: 0.5, y: 0.5, z: -0.1 }).z).toBeCloseTo(0.2);
  });
});

describe('mirroring / handedness convention (R-7)', () => {
  it("swaps MediaPipe's label to the physical hand", () => {
    // MediaPipe assumes an already-mirrored input; ours is raw.
    expect(physicalHand('Left')).toBe('right');
    expect(physicalHand('Right')).toBe('left');
  });

  it('resolves the known-handedness fixture to the physical right hand', () => {
    const frame = resolveHands(fixture.result, fixture.mediaTime);
    expect(frame.hands).toHaveLength(1);
    expect(frame.hands[0].hand).toBe(fixture.physicalHand);
    expect(frame.hands[0].score).toBeCloseTo(0.97);
  });

  it('places the raised right hand at engine x > 0 (mirror view) and fingers above the wrist', () => {
    const frame = resolveHands(fixture.result, fixture.mediaTime);
    const pts = frame.hands[0].points;
    // A right hand moving to the user's right must read as +X on screen.
    expect(pts[WRIST].x).toBeGreaterThan(0);
    // Fingers raised: every fingertip is above the wrist in engine Y.
    for (const tip of FINGERTIPS) {
      expect(pts[tip].y).toBeGreaterThan(pts[WRIST].y);
    }
  });

  it('carries the frame mediaTime on the landmark set (R-6)', () => {
    const frame = resolveHands(fixture.result, fixture.mediaTime);
    expect(frame.mediaTime).toBe(fixture.mediaTime);
  });

  it('skips landmark sets with no handedness classification', () => {
    const raw: RawHandResult = {
      landmarks: [fixture.result.landmarks[0], fixture.result.landmarks[0]],
      handedness: [[{ categoryName: 'Left', score: 0.9 }], []],
    };
    expect(resolveHands(raw, 0).hands).toHaveLength(1);
  });
});

describe('hand topology constants', () => {
  it('declares the five fingertips (R-10)', () => {
    expect([...FINGERTIPS]).toEqual([4, 8, 12, 16, 20]);
  });

  it('declares a 21-point skeleton with in-range connections (R-9)', () => {
    expect(HAND_CONNECTIONS).toHaveLength(21);
    for (const [a, b] of HAND_CONNECTIONS) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(21);
    }
    // Every landmark participates in the skeleton.
    const seen = new Set(HAND_CONNECTIONS.flat());
    expect(seen.size).toBe(21);
  });
});

describe('projectToCanvas (object-fit: cover mapping)', () => {
  it('is identity-like when video and canvas aspects match', () => {
    // Engine origin -> canvas center.
    expect(projectToCanvas({ x: 0, y: 0, z: 0 }, 1280, 720, 320, 180)).toEqual({ x: 160, y: 90 });
    // Engine (+1, +1) = mirror-view top-right -> canvas top-right corner.
    expect(projectToCanvas({ x: 1, y: 1, z: 0 }, 1280, 720, 320, 180)).toEqual({ x: 320, y: 0 });
  });

  it('center-crops a 4:3 video on the 16:9 monitor exactly like object-fit: cover', () => {
    // 640x480 covering 320x180 scales by 0.5 (drawn 320x240) and crops
    // 30 px top and bottom.
    expect(projectToCanvas({ x: 0, y: 0, z: 0 }, 640, 480, 320, 180)).toEqual({ x: 160, y: 90 });
    const top = projectToCanvas({ x: 0, y: 1, z: 0 }, 640, 480, 320, 180);
    expect(top.y).toBe(-30);
  });
});
