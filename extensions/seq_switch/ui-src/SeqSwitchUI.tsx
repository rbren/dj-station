// Sequential switch step lamps: one lamp per step with the currently
// routed step lit hot. The step is decoded from the module's existing
// `step_cv` output ((step + 0.5) / steps * 10 V) via the batched
// telemetry tap — no new engine outputs needed.

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  signalTap?(jackId: string): { instantaneous: number };
}

const MAX_STEPS = 8;

export default function SeqSwitchUI({ handle }: { handle: ModuleHandle }) {
  const steps = Math.min(
    MAX_STEPS,
    Math.max(2, Math.round(handle.paramValue("steps"))),
  );
  // `instantaneous`, not `display`: the smoothed display sweeps through
  // phantom steps on the wrap back to step 1.
  const cv = handle.signalTap?.("out:step_cv")?.instantaneous ?? 0;
  const current = Math.min(
    steps - 1,
    Math.max(0, Math.floor((cv / 10) * steps)),
  );

  return (
    <div className="stepseq-ui" data-testid="seqswitch-ui">
      {Array.from({ length: MAX_STEPS }, (_, s) => {
        const beyond = s >= steps;
        const playing = s === current && !beyond;
        return (
          <span
            key={s}
            data-testid={`seqswitch-lamp-${s + 1}`}
            data-playing={playing || undefined}
            className={`stepseq-lamp${beyond ? " beyond" : ""}${
              playing ? " playing" : ""
            }`}
          >
            {s + 1}
          </span>
        );
      })}
    </div>
  );
}
