// The wire shape of a clip's CAPTURE: `beat_clip_audio` asked with the
// bleed answers with sixteen bytes of frame — the lead-in and tail-out
// seconds as little-endian f64 — and then the WAV of the whole captured
// area. The Grid takes its bookends out of that one buffer by offset,
// so this framing is the contract between the two.

import { afterEach, describe, expect, it } from 'vitest';
import { BeatClipClient } from '../src/beatClip';

function framed(leadSecs: number, tailSecs: number, wav: number[]): ArrayBuffer {
  const out = new ArrayBuffer(16 + wav.length);
  const header = new DataView(out);
  header.setFloat64(0, leadSecs, true);
  header.setFloat64(8, tailSecs, true);
  new Uint8Array(out).set(wav, 16);
  return out;
}

describe('BeatClipClient capture', () => {
  afterEach(() => delete window.__DJ_STRESS_INVOKE__);

  it('asks for the clip with its bleed and reads the bookends off the frame', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    window.__DJ_STRESS_INVOKE__ = (cmd, args) => {
      calls.push([cmd, args]);
      return Promise.resolve(framed(0.25, 0.1, [1, 2, 3, 4]));
    };

    const capture = await new BeatClipClient().capture('b1', 128);

    expect(calls).toEqual([['beat_clip_audio', { clipId: 'b1', bpm: 128, withBleed: true }]]);
    expect(capture?.leadSecs).toBeCloseTo(0.25, 12);
    expect(capture?.tailSecs).toBeCloseTo(0.1, 12);
    // The bytes handed on to `decodeAudioData` are the WAV alone.
    expect([...new Uint8Array(capture!.bytes)]).toEqual([1, 2, 3, 4]);
  });

  it('is nothing to play where the clip answers with no audio', async () => {
    window.__DJ_STRESS_INVOKE__ = () => Promise.resolve(new ArrayBuffer(0));
    expect(await new BeatClipClient().capture('b1')).toBeNull();
  });
});
