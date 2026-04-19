/**
 * Small shared helpers for turning thrown values into human-readable
 * strings. Lives at the top level (not under `commands/`) because both
 * the command layer and the ssh layer need it — avoids sideways imports.
 */

/**
 * Convert an unknown thrown value into a one-line human-readable string
 * suitable for user-facing toasts. Prefers `Error.message` when available,
 * otherwise coerces via `String()`.
 *
 * Returns `"(unknown error)"` when the input is `undefined` or `null`
 * (both coerce to literal "undefined" / "null" via String which is worse
 * than a neutral fallback).
 */
export function formatError(err: unknown): string {
  if (err === undefined || err === null) {
    return "(unknown error)";
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  const s = String(err);
  return s.length > 0 ? s : "(unknown error)";
}
