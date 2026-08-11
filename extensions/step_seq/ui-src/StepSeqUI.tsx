// Step sequencer playhead strip: one lamp per step above the 16-column
// knob grid, with the currently-playing step lit hot (bright fill + glow)
// so it reads at a glance from across the room. The step index comes from
// the module's `step` output via the batched telemetry tap (out:step);
// -1 (armed, no clock yet) shows no playhead.

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  signalTap?(jackId: string): { display: number };
}

const STEPS = 16;

export default function StepSeqUI({ handle }: { handle: ModuleHandle }) {
  const length = Math.min(
    STEPS,
    Math.max(1, Math.round(handle.paramValue("length"))),
  );
  const raw = handle.signalTap?.("out:step")?.display ?? -1;
  const current = raw >= 0 ? Math.round(raw) % STEPS : null;

  return (
    <div className="stepseq-ui" data-testid="stepseq-ui">
      {Array.from({ length: STEPS }, (_, s) => {
        const beyond = s >= length;
        const playing = current === s;
        return (
          <span
            key={s}
            data-testid={`stepseq-lamp-${s + 1}`}
            data-playing={playing || undefined}
            className={`stepseq-lamp${s % 4 === 0 ? " beat" : ""}${
              beyond ? " beyond" : ""
            }${playing ? " playing" : ""}`}
          >
            {s + 1}
          </span>
        );
      })}
    </div>
  );
}
