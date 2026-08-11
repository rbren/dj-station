// Minimal typing for the one node builtin tests use — the app has no
// @types/node (it targets the browser); vitest provides the real module
// at runtime.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
}
