// Custom panel body for the built-in Math module: the expression its
// eight outputs evaluate, typed as Rust-flavoured arithmetic over `x`
// (the input knob/CV) and `i` (the output index).
//
// The text is the module's state, so every edit goes to the engine —
// debounced, because one IPC round trip per keystroke would be an undo
// step per keystroke too (the backend coalesces them under one key, and
// blur ends the gesture). A text that does not compile still lands: the
// engine keeps it as state and answers with the message shown below the
// box, while the last expression that DID compile keeps playing.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MathStatus } from '../engine';

/** IPC surface the panel needs; RackModule adapts EngineClient onto this. */
export interface MathApi {
  status(instance: string): Promise<MathStatus | null>;
  setExpr(instance: string, expr: string): Promise<MathStatus | null>;
  endEdit(): Promise<unknown>;
}

export interface MathPanelProps {
  instance: string;
  api: MathApi;
  /** Keystroke-to-IPC delay in ms (tests dial it down). */
  debounceMs?: number;
}

export function MathPanel({ instance, api, debounceMs = 300 }: MathPanelProps) {
  const [expr, setExpr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards IPC that resolves after the panel unmounts (module removed).
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    void api.status(instance).then((s) => {
      // A null status is an expected race (the module was just removed);
      // keep showing what is on screen.
      if (!s || disposed.current) return;
      setExpr(s.expr);
      setError(s.error);
    });
  }, [api, instance]);

  const send = useCallback(
    (text: string) => {
      void api.setExpr(instance, text).then((s) => {
        if (s && !disposed.current) setError(s.error);
      });
    },
    [api, instance],
  );

  const onChange = (text: string) => {
    setExpr(text);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      send(text);
    }, debounceMs);
  };

  // Leaving the box commits immediately and closes the undo step, so the
  // whole burst of typing is one entry in the history.
  const onBlur = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
      send(expr);
    }
    void api.endEdit();
  };

  return (
    <div className="math-panel" data-testid={`math-panel-${instance}`}>
      <textarea
        className={`math-expr${error ? ' math-expr-bad' : ''}`}
        data-testid={`math-expr-${instance}`}
        spellCheck={false}
        rows={2}
        value={expr}
        aria-label="expression"
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {error ? (
        <p className="math-error" data-testid={`math-error-${instance}`} role="status">
          {error} — still running the last expression that compiled
        </p>
      ) : (
        <p className="math-hint" data-testid={`math-hint-${instance}`}>
          x = input (−10..10 V), i = output index 0–7
        </p>
      )}
    </div>
  );
}
