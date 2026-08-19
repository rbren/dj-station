// Turing machine register display: one lamp per bit of the looping window
// (`length` bits), lit when the bit is set, with the head bit — bit 0, the
// one that drives the CV/gate outputs right now — highlighted hot like the
// sequencers' playing step. The register value comes from the module's
// `reg` output via the batched telemetry tap (out:reg).

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  signalTap?(jackId: string): { instantaneous: number };
}

const BITS = 16;

export default function TuringUI({ handle }: { handle: ModuleHandle }) {
  const length = Math.min(
    BITS,
    Math.max(1, Math.round(handle.paramValue("length"))),
  );
  // `instantaneous`, not `display`: the register is a discrete bit
  // pattern — the smoothed display shows garbage bits mid-transition.
  const reg =
    Math.max(0, Math.round(handle.signalTap?.("out:reg")?.instantaneous ?? 0)) &
    0xffff;

  return (
    <div className="turing-ui" data-testid="turing-ui">
      {Array.from({ length: BITS }, (_, b) => {
        const on = (reg & (1 << b)) !== 0;
        const beyond = b >= length;
        const head = b === 0;
        return (
          <span
            key={b}
            data-testid={`turing-bit-${b + 1}`}
            data-playing={head || undefined}
            className={`turing-bit${on ? " on" : ""}${beyond ? " beyond" : ""}${
              head ? " playing" : ""
            }`}
          />
        );
      })}
    </div>
  );
}
