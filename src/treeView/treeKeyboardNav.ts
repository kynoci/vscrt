/**
 * Pure, testable sibling of the keyboard-navigation helper embedded in
 * media/connectionView.js. Kept in TypeScript so the mocha suite can
 * exercise every arrow/home/end branch without a browser.
 *
 * ⚠ When the rules change here, mirror them in
 * `media/connectionView.js :: computeNextFocusedPath`. The function is
 * deliberately tiny so keeping two copies in sync is a judgment call
 * cheaper than building a browser test harness.
 */

export interface FlatRow {
  path: string;
  hasChildren: boolean;
}

export type NavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * Return the new focused path for a key press. `currentPath` may be `null`
 * when nothing is focused yet — ArrowDown lands on the first row, ArrowUp
 * on the last (so the user can navigate from either end).
 */
export function computeNextFocusedPath(
  flat: readonly FlatRow[],
  currentPath: string | null,
  key: NavKey,
): string | null {
  if (flat.length === 0) {
    return null;
  }
  const idx = currentPath === null
    ? -1
    : flat.findIndex((f) => f.path === currentPath);
  if (key === "ArrowDown") {
    const next = idx < 0 ? 0 : Math.min(flat.length - 1, idx + 1);
    return flat[next].path;
  }
  if (key === "ArrowUp") {
    const prev = idx < 0 ? flat.length - 1 : Math.max(0, idx - 1);
    return flat[prev].path;
  }
  if (key === "Home") {
    return flat[0].path;
  }
  return flat[flat.length - 1].path;
}

/**
 * ArrowLeft on a leaf or a collapsed folder moves to the parent (when
 * visible). Returns the parent path when it's in `flat`, otherwise null so
 * the caller leaves focus in place.
 */
export function parentPathIfVisible(
  flat: readonly FlatRow[],
  currentPath: string,
): string | null {
  const sep = currentPath.lastIndexOf("/");
  if (sep < 0) {
    return null;
  }
  const parent = currentPath.substring(0, sep);
  return flat.some((f) => f.path === parent) ? parent : null;
}

/**
 * ArrowRight on an expanded folder moves to its first child row. Returns
 * `null` if the current row isn't in `flat` or is collapsed / has no kids.
 */
export function firstChildPath(
  flat: readonly FlatRow[],
  currentPath: string,
): string | null {
  const idx = flat.findIndex((f) => f.path === currentPath);
  if (idx < 0 || idx + 1 >= flat.length) {
    return null;
  }
  const candidate = flat[idx + 1];
  // Child row => path must start with current path + "/".
  return candidate.path.startsWith(currentPath + "/") ? candidate.path : null;
}
