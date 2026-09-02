// Beat Clip module custom panel: which clip the module is playing, and
// what the clock is doing with it. It is a READOUT, not a control — the
// clip is chosen when the module is imported (the picker's Clips tab) and
// everything else is an ordinary knob-backed input on the panel below.
//
// The beat lamp reads the engine's own beat index (published once per
// block by the RT module), so it says what is being played rather than
// what the frontend guesses; a module still waiting for its first clock
// edge says so, because silence with no explanation reads as broken.

import { useCallback, useState } from 'react';
import { beatClip as defaultApi, type BeatClipApi, type BeatClipStatus } from '../beatClip';
import { fixed } from '../format';
import { usePoll } from '../usePoll';
import { StemTags } from './StemTags';

const POLL_MS = 100;

export interface BeatClipPanelProps {
  instanceId: string;
  api?: BeatClipApi;
  pollMs?: number;
}

export function BeatClipPanel(props: BeatClipPanelProps) {
  const api = props.api ?? defaultApi;
  const { instanceId } = props;
  const [status, setStatus] = useState<BeatClipStatus | null>(null);

  const poll = useCallback(async () => {
    const st = await api.status(instanceId);
    if (st) setStatus(st);
  }, [api, instanceId]);

  usePoll(poll, props.pollMs ?? POLL_MS);

  const beats = status?.beats ?? 0;
  const beat = status?.beat ?? -1;
  const clockBpm = status?.clock_bpm ?? 0;
  return (
    <div className="beat-clip-panel" data-testid={`beat-clip-${instanceId}`}>
      <div className="beat-clip-name" data-testid="beat-clip-name">
        {status?.clip?.name || 'no clip'}
      </div>
      <StemTags stems={status?.clip?.stems} testId="beat-clip-stems" />
      <div className="beat-clip-row">
        <span data-testid="beat-clip-length">
          {beats} beats · {fixed(status?.bpm, 1)} BPM
        </span>
        <span data-testid="beat-clip-clock">
          {clockBpm > 0 ? `clock ${fixed(clockBpm, 1)} BPM` : 'waiting for clock'}
        </span>
      </div>
      <div className="beat-clip-beats" data-testid="beat-clip-beat">
        {Array.from({ length: Math.min(beats, 32) }, (_, i) => (
          <span key={i} className={`beat-clip-dot${i === beat ? ' on' : ''}`} />
        ))}
      </div>
    </div>
  );
}

export function BeatClipCustomUI(props: { instanceId?: string }) {
  return <BeatClipPanel instanceId={props.instanceId ?? ''} />;
}
