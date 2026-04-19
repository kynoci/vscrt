/**
 * Mirror of `src/errorUtils.ts` (extension side). Keeping a CLI-local
 * copy avoids reaching into the extension package's source tree from
 * inside a standalone CLI sibling.
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
