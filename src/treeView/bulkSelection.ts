/**
 * Pure helpers for the multi-select state machine that drives bulk
 * tree operations. The webview-side JS mirrors this logic; keeping a
 * testable TypeScript port means we can assert range/toggle/contiguity
 * without a headless browser.
 *
 * State model:
 *   - `selected`: set of node paths (order-independent; membership only).
 *   - `anchor`: the path the last non-shift click landed on. Shift+click
 *     selects [anchor..click] inclusive over an ordered `flat` list.
 */

export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export function emptySelection(): SelectionState {
  return { selected: new Set(), anchor: null };
}

export function single(path: string): SelectionState {
  return { selected: new Set([path]), anchor: path };
}

/** Ctrl/Cmd-click: toggle this path in/out without disturbing the rest. */
export function toggle(
  state: SelectionState,
  path: string,
): SelectionState {
  const next = new Set(state.selected);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return { selected: next, anchor: path };
}

/** Shift-click: select the inclusive range from `anchor` to `path`. */
export function range(
  state: SelectionState,
  flat: readonly string[],
  path: string,
): SelectionState {
  const anchor = state.anchor ?? path;
  const a = flat.indexOf(anchor);
  const b = flat.indexOf(path);
  if (a < 0 || b < 0) {
    // Anchor or target isn't in the current list (e.g. collapsed out).
    // Fall back to single-select on the clicked path.
    return single(path);
  }
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out = new Set<string>();
  for (let i = lo; i <= hi; i += 1) {
    out.add(flat[i]);
  }
  return { selected: out, anchor };
}

/**
 * Ctrl+A analog: replace the selection with every visible row. The anchor
 * snaps to the first row so a following Shift+click has somewhere to
 * start from.
 */
export function selectAll(flat: readonly string[]): SelectionState {
  return {
    selected: new Set(flat),
    anchor: flat.length > 0 ? flat[0] : null,
  };
}

/**
 * Drop paths that aren't in `flat` anymore (tree reloaded, nodes
 * renamed/deleted). Pure: produces a new state even when nothing
 * changes, so the caller can compare references to decide whether to
 * repaint.
 */
export function prune(
  state: SelectionState,
  flat: readonly string[],
): SelectionState {
  const alive = new Set(flat);
  const next = new Set<string>();
  for (const p of state.selected) {
    if (alive.has(p)) {
      next.add(p);
    }
  }
  const anchor =
    state.anchor && alive.has(state.anchor) ? state.anchor : null;
  return { selected: next, anchor };
}

/**
 * Validate a bulk move: reject if any selected path is an ancestor of
 * another selected path (or the destination). Prevents cycles and the
 * "move this folder into itself" footgun. Returns a list of violating
 * source paths; empty means the move is safe.
 */
export function validateBulkMove(
  selected: readonly string[],
  destPath: string | null,
): string[] {
  const violations: string[] = [];
  const destLooksLikeChildOfSelected = (src: string): boolean =>
    destPath !== null &&
    (destPath === src || destPath.startsWith(src + "/"));
  for (const src of selected) {
    if (destLooksLikeChildOfSelected(src)) {
      violations.push(src);
      continue;
    }
    // Any other selected source being a descendant of `src` means a
    // nested move which we disallow for simplicity.
    for (const other of selected) {
      if (other === src) {
        continue;
      }
      if (other.startsWith(src + "/")) {
        violations.push(src);
        break;
      }
    }
  }
  return violations;
}
