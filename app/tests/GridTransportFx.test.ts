// The Wetness crossfade, heard. With a fake Web Audio context the
// transport lays real voices, so these tests can pin WHICH buffers a row
// plays (the dry clip, and the rack's wet render fetched with the row's
// fx spec) and at WHAT gains (the row's level split by the Wetness knob).
// The clock tests stay in GridTransport.test.ts, contextless on purpose.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeatClipEntry } from '../src/beatClip';
import { closeAudio } from '../src/clipAudio';
import { emptyGrid, placeClip, type GridState } from '../src/grid';
import { defaultTrackFx, fxRenderSpec, setFxValue, type TrackFx } from '../src/gridFx';
import { GridTransport } from '../src/gridTransport';

const CLIP: BeatClipEntry = {
  clipId: 'c1',
  name: 'main drums',
  bpm: 120,
  beats: 4,
  stems: ['drums'],
  editable: true,
  ones: [0],
  sources: [{ trackHash: 'h1', title: 'Basement Loop', artist: 'Nadia' }],
};
const CLIPS = new Map([[CLIP.clipId, CLIP]]);

/** A rack whose graph differs from the default (one EQ band cut). */
function cutRack(wet = 1): TrackFx {
  return { ...setFxValue(defaultTrackFx(), 'eq1', 'gain1', -15, 0), wet };
}

function gridWith(fx?: TrackFx): GridState {
  return {
    ...emptyGrid(120),
    rows: [placeClip({ id: 'row1', clipId: 'c1', placements: [], levels: [], fx }, CLIP, 0)],
  };
}

/** Dry fetches answer with 8 bytes, wet ones with 16, so a voice's buffer
 *  says which side of the crossfade it carries. */
const DRY_BYTES = 8;
const WET_BYTES = 16;
const source = {
  audio: vi.fn(async (_clipId: string, _bpm?: number, fx?: string) => {
    return new ArrayBuffer(fx ? WET_BYTES : DRY_BYTES);
  }),
};

interface FakeVoice {
  buffer: { bytes: number } | null;
  started: boolean;
  gain: { value: number };
}

let voices: FakeVoice[];

function installAudio(): void {
  voices = [];
  const laid = voices;
  class FakeParam {
    value = 0;
    setValueAtTime(v: number) {
      this.value = v;
      return this;
    }
    linearRampToValueAtTime(v: number) {
      this.value = v;
      return this;
    }
    cancelScheduledValues() {
      return this;
    }
  }
  class FakeContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    async decodeAudioData(bytes: ArrayBuffer) {
      // Two seconds — the four-beat clip at 120 bpm — plus the tag.
      return { duration: 2, bytes: bytes.byteLength } as unknown as AudioBuffer;
    }
    createGain() {
      return { gain: new FakeParam(), connect() {}, disconnect() {} };
    }
    createBufferSource() {
      const src = {
        buffer: null as { bytes: number } | null,
        onended: null,
        started: false,
        gain: { value: 0 },
        connect(node: { gain: FakeParam }) {
          src.gain = node.gain;
        },
        disconnect() {},
        start() {
          src.started = true;
          laid.push(src);
        },
        stop() {},
      };
      return src as unknown as AudioBufferSourceNode & FakeVoice;
    }
    async resume() {}
    async close() {}
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
}

let transport: GridTransport;

beforeEach(() => {
  vi.useFakeTimers();
  source.audio.mockClear();
  installAudio();
  transport = new GridTransport(source);
});

afterEach(() => {
  transport.dispose();
  closeAudio();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  vi.useRealTimers();
});

const dryVoices = () => voices.filter((v) => v.buffer?.bytes === DRY_BYTES);
const wetVoices = () => voices.filter((v) => v.buffer?.bytes === WET_BYTES);

describe('the Wetness crossfade', () => {
  it('plays a default-rack row as ONE dry voice at full level', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    expect(voices).toHaveLength(1);
    expect(voices[0].buffer?.bytes).toBe(DRY_BYTES);
    expect(voices[0].gain.value).toBe(1);
    // And never asked for a render: the default rack is neutral.
    for (const call of source.audio.mock.calls) expect(call[2]).toBeUndefined();
  });

  it('lays an effected row as a dry/wet PAIR split by the knob', async () => {
    const fx = cutRack(0.75);
    await transport.play(gridWith(fx), CLIPS, 32);
    expect(source.audio).toHaveBeenCalledWith('c1', 120, fxRenderSpec(fx)!);
    expect(dryVoices().map((v) => v.gain.value)).toEqual([0.25]);
    expect(wetVoices().map((v) => v.gain.value)).toEqual([0.75]);
  });

  it('is the rack ALONE at full wet — the default position', async () => {
    await transport.play(gridWith(cutRack()), CLIPS, 32);
    expect(dryVoices().map((v) => v.gain.value)).toEqual([0]);
    expect(wetVoices().map((v) => v.gain.value)).toEqual([1]);
  });

  it('follows the knob during playback', async () => {
    await transport.play(gridWith(cutRack(1)), CLIPS, 32);
    transport.update(gridWith(cutRack(0.25)), CLIPS, 32);
    await vi.advanceTimersByTimeAsync(200);
    // The unheard voices are re-laid from the grid as it now stands.
    expect(dryVoices().at(-1)?.gain.value).toBe(0.75);
    expect(wetVoices().at(-1)?.gain.value).toBe(0.25);
  });
});

// A clip EDITED on the Clip page is filed under the id it already had,
// so the transport's decodes — keyed by that id and a tempo — would go
// on playing the take before the edit for as long as the app is open.
describe('a clip saved over', () => {
  it('is fetched again once the page says its audio has moved', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    expect(source.audio).toHaveBeenCalledTimes(1);

    // Played again, the decode already in hand is what sounds: nothing
    // has changed, and re-fetching every pass is what the cache is for.
    transport.stop();
    await transport.play(gridWith(), CLIPS, 32);
    expect(source.audio).toHaveBeenCalledTimes(1);

    // Told the clip has been re-saved, it drops what it holds and the
    // next pass plays the new take.
    transport.stop();
    transport.forget(['c1']);
    await transport.play(gridWith(), CLIPS, 32);
    expect(source.audio).toHaveBeenCalledTimes(2);
  });

  it('leaves the clips that did not move alone', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    transport.stop();
    transport.forget(['c9']);
    await transport.play(gridWith(), CLIPS, 32);
    expect(source.audio).toHaveBeenCalledTimes(1);
  });
});
