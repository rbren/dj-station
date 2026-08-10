// Central place the UI collects failures it should show instead of dying:
// rejected IPC calls, render crashes caught by an ErrorBoundary, and stray
// window errors / unhandled rejections.

export interface AppError {
  id: number;
  /** Where it came from — an IPC command name, a component, 'window'. */
  context: string;
  message: string;
  /** Machine-readable kind for backend (IPC) errors; see `CmdError` in
   *  the Tauri shell. Non-IPC errors have no kind. */
  kind?: ErrorKind;
}

/** Mirrors `ErrorKind` in app/src-tauri/src/main.rs. */
export type ErrorKind = 'not_found' | 'invalid_input' | 'internal';

/** Structured error payload rejected by Tauri commands. */
export interface CmdError {
  kind: ErrorKind;
  message: string;
}

export function isCmdError(err: unknown): err is CmdError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as CmdError).message === 'string' &&
    typeof (err as CmdError).kind === 'string'
  );
}

type Listener = (errors: AppError[]) => void;

const MAX_ERRORS = 20;

let errors: AppError[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

export function errorMessage(err: unknown): string {
  if (isCmdError(err)) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function reportError(context: string, err: unknown): void {
  const message = errorMessage(err);
  const kind = isCmdError(err) ? err.kind : undefined;
  const last = errors[errors.length - 1];
  // Polling loops fail every tick; collapse repeats instead of flooding.
  if (last && last.context === context && last.message === message) return;
  errors = [...errors, { id: nextId++, context, message, kind }].slice(-MAX_ERRORS);
  for (const l of listeners) l(errors);
}

export function dismissError(id: number): void {
  errors = errors.filter((e) => e.id !== id);
  for (const l of listeners) l(errors);
}

export function clearErrors(): void {
  errors = [];
  for (const l of listeners) l(errors);
}

export function subscribeErrors(cb: Listener): () => void {
  listeners.add(cb);
  cb(errors);
  return () => listeners.delete(cb);
}

/** Route errors that escape React (async callbacks, event handlers) into the
 *  same banner. Returns an unsubscribe function. */
export function installGlobalErrorHandlers(): () => void {
  const onError = (e: ErrorEvent) => reportError('window', e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => reportError('promise', e.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
