// Shared Tauri IPC plumbing for the engine / deck / library clients.
//
// Outside Tauri (vite dev server, vitest) there is no `invoke`, so every
// command resolves to `null` and the UI stays testable headless.

import { reportError } from './errors';

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

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
      await this.ready;
      if (!this.invoke) return null;
      return (await this.invoke(cmd, args)) as T;
    } catch (err) {
      if (!opts?.quiet) reportError(cmd, err);
      return null;
    }
  }
}
