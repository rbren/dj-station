// Gapless looping for the Clip page's audition.
//
// `<audio loop>` is NOT a true loop: the media element tears the pipeline
// down and re-seeks at the wrap, which the webview renders as ~100 ms of
// silence at the end of every pass. Web Audio loops inside the graph
// instead — `AudioBufferSourceNode.loop` wraps at a sample boundary with
// no gap at all — so the loop transport runs through here.
//
// Linear playback stays on the <audio> element: it streams 60 s windows
// and never wraps, so it has nothing to gain from holding whole buffers
// in memory. This module is also the fallback boundary: where there is no
// AudioContext (jsdom, an ancient webview) `startGaplessLoop` returns null
// and the caller falls back to the element.

/** A running gapless loop. */
export interface LoopHandle {
  /** Seconds into the loop right now, wrapped into its length. */
  position(): number;
  /** Length of one pass, in seconds. */
  readonly duration: number;
  stop(): void;
}

type AudioContextCtor = typeof AudioContext;

function contextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

let shared: AudioContext | null = null;

/** One context for the page: browsers cap how many can exist, and each
 *  costs a hardware stream. */
function sharedContext(): AudioContext | null {
  if (shared) return shared;
  const Ctor = contextCtor();
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    return null;
  }
  return shared;
}

/** Release the shared context (page teardown; tests). */
export function closeAudio(): void {
  const ctx = shared;
  shared = null;
  void ctx?.close?.();
}

/**
 * Decode `wavBytes` and start looping it immediately, gaplessly.
 *
 * `offsetSecs` starts the first pass that far in, which lets a caller
 * re-render the loop (an EQ tweak while auditioning) and pick the phase
 * back up where it left off instead of jumping to the top.
 *
 * Returns null when Web Audio is unavailable or the bytes will not decode,
 * so the caller can fall back to the media element rather than going
 * silent.
 */
export async function startGaplessLoop(
  wavBytes: ArrayBuffer,
  offsetSecs = 0,
): Promise<LoopHandle | null> {
  const ctx = sharedContext();
  if (!ctx) return null;
  let buffer: AudioBuffer;
  try {
    // decodeAudioData detaches its input, so hand it a copy: the caller's
    // bytes stay usable (e.g. for the fallback path).
    buffer = await ctx.decodeAudioData(wavBytes.slice(0));
  } catch {
    return null;
  }
  // Autoplay policies suspend fresh contexts until a gesture; play() is
  // always reached from a click or key press, so resuming here is safe.
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      // Keep going: the node still starts, it just stays silent until the
      // context resumes on its own.
    }
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = buffer.duration;
  source.connect(ctx.destination);
  const offset = buffer.duration > 0 ? Math.max(0, offsetSecs) % buffer.duration : 0;
  const startedAt = ctx.currentTime;
  source.start(0, offset);

  let stopped = false;
  return {
    duration: buffer.duration,
    position() {
      if (stopped || buffer.duration <= 0) return 0;
      const elapsed = Math.max(0, ctx.currentTime - startedAt);
      return (offset + elapsed) % buffer.duration;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        source.stop();
      } catch {
        // Already finished.
      }
      source.disconnect();
    },
  };
}
