/**
 * Live transfer-progress formatters.
 *
 * Pure — zero vscode-api imports — so these live anywhere and test
 * without a webview host.
 */

/**
 * Human-readable byte count. Shape mirrors the webview's `humanSize`
 * but formats with one decimal where sensible.
 *
 *   0         → "0 B"
 *   512       → "512 B"
 *   1024      → "1.0 KB"
 *   10485760  → "10 MB"     (no decimal past 10 in a unit)
 *   NaN / -1  → ""
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return "";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/**
 * "MM:SS" (or "H:MM:SS" past the hour mark) from a duration in
 * seconds. Used for ETA and elapsed-time displays.
 *
 *   0       → "00:00"
 *   65      → "01:05"
 *   3661    → "1:01:01"
 *   NaN / -1 → "—"
 */
export function formatDurationClock(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) {
    return "—";
  }
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

/**
 * Build the progress-line string. Exported + pure so it's directly
 * unit-testable.
 *   - `bytes` / `total` can be NaN or 0 for "unknown size"; the
 *     function degrades gracefully (elapsed-only display).
 *   - `elapsedSeconds` is wall-clock since transfer start.
 */
export function formatTransferProgress(
  bytes: number,
  total: number,
  elapsedSeconds: number,
): string {
  const elapsed = `${formatDurationClock(elapsedSeconds)} elapsed`;
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return elapsed;
  }
  const rate = elapsedSeconds > 0 ? bytes / elapsedSeconds : 0;
  const rateStr = rate > 0 ? `${formatBytes(Math.round(rate))}/s` : "—";
  if (!Number.isFinite(total) || total <= 0) {
    return `${formatBytes(bytes)} · ${rateStr} · ${elapsed}`;
  }
  const pct = Math.min(100, Math.floor((bytes / total) * 100));
  const eta =
    rate > 0 ? formatDurationClock((total - bytes) / rate) : "—";
  return `${formatBytes(bytes)} / ${formatBytes(total)} (${pct}%) · ${rateStr} · ETA ${eta}`;
}
