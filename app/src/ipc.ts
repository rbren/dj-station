// Shared Tauri IPC plumbing for the engine / deck / library clients.
//
// Outside Tauri (vite dev server, vitest) there is no `invoke`, so every
// command resolves to `null` and the UI stays testable headless.

import { reportError } from './errors';

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    /** Dev-only rendering stress harness (src/stress/): when set, every
     *  IPC command routes to the mock engine instead of Tauri. Checked at
     *  call time (not construction) because the harness installs after the
     *  module-level client singletons are created. */
    __DJ_STRESS_INVOKE__?: Invoke;
  }
}

async function tauriInvoke(): Promise<Invoke | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as Invoke;
}

export class IpcClient {
  protected invoke: Invoke | null = null;
  protected ready: Promise<void>;

  constructor() {
    this.ready = tauriInvoke().then((inv) => {
      this.invoke = inv;
    });
  }

  /** Invoke a command, reporting failures instead of rejecting. A backend
   *  error (bad jack id, poisoned mutex, …) surfaces in the error banner and
   *  yields `null`, which callers already handle as "no data". Pass
   *  `quiet: true` for polling commands whose failures are expected races
   *  (e.g. tapping a node the user just undid away) and must not flood the
   *  banner. */
  protected async call<T>(
    cmd: string,
    args?: Record<string, unknown>,
    opts?: { quiet?: boolean },
  ): Promise<T | null> {
    try {
      const stress = window.__DJ_STRESS_INVOKE__;
      if (stress) return (await stress(cmd, args)) as T;
      await this.ready;
      if (!this.invoke) return null;
      return (await this.invoke(cmd, args)) as T;
    } catch (err) {
      // Quiet commands stay out of the banner, never out of the console: a
      // "race" that keeps repeating is a real bug and needs a trail.
      if (opts?.quiet) console.debug(`[${cmd}] (quiet)`, err);
      else reportError(cmd, err);
      return null;
    }
  }
}
