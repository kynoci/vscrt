/**
 * Small pure string helpers. Centralized so both the CLI-side table
 * rendering and the extension-side tooltip/labels share semantics.
 *
 * Keep this file dependency-free so the CLI (which ships a ~60 KB
 * binary) can import it without any incidental blast-radius.
 */

/**
 * Returns `true` when `s` is a non-empty string after trimming whitespace.
 * Convenient in QuickPick filters and form-validation guards.
 */
export function isNonEmpty(s: string | undefined | null): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Truncate `s` to at most `max` characters, appending `ellipsis` when
 * truncation occurred. The returned string is guaranteed to be ≤ `max`
 * in length (inclusive of the ellipsis).
 *
 * Returns `s` unchanged when already within bounds; returns `""` when
 * `max` is zero or negative.
 */
export function truncate(
  s: string,
  max: number,
  ellipsis: string = "…",
): string {
  if (max <= 0) {
    return "";
  }
  if (s.length <= max) {
    return s;
  }
  if (ellipsis.length >= max) {
    return s.slice(0, max);
  }
  return s.slice(0, max - ellipsis.length) + ellipsis;
}

/**
 * Pluralize an English noun with a simple +s rule. Returns `"1 server"`
 * for n=1, `"N servers"` otherwise. Accepts an optional explicit plural
 * for irregulars (e.g. `"directory"/"directories"`).
 *
 * NB: English-only. For localized UIs, reach for `vscode.l10n.t(...)`
 * with ICU `{count, plural, …}` syntax instead — VS Code's l10n bundle
 * handles CLDR rules across locales where `pluralize` would produce
 * grammatically wrong output in Polish/Russian/Arabic/etc.
 */
export function pluralize(
  n: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
