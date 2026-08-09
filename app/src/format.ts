// Numeric formatting that tolerates bad data from the engine.
//
// Engine payloads are JSON, and `serde_json` renders a non-finite f32 as
// `null` — so any number field can arrive null/undefined/NaN however tight
// the TypeScript types look. Calling `.toFixed` on that is a TypeError, and
// during render a TypeError blanks the whole app.

/** Finite number or `fallback` for null/undefined/NaN/Inf/non-numbers. */
export function safeNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** `toFixed` that never throws; unusable input renders as `placeholder`. */
export function fixed(v: unknown, digits = 2, placeholder = '—'): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : placeholder;
}
