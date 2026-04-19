/**
 * NOTE: user-facing strings should be wrapped with `vscode.l10n.t(...)`
 * (see l10n/bundle.l10n.json). This logger ONLY writes to the Output
 * Channel — not a user-facing dialog — so its messages stay untranslated
 * to keep diagnostic grep-ability in bug reports.
 *
 * Dedicated logger for the vsCRT extension. Writes ISO-timestamped lines
 * with a level tag to a single sink — normally a VS Code OutputChannel
 * named "vsCRT", wired up in `activate()`.
 *
 * Pre-activation / test fallback routes to console.warn|error so anything
 * logged before `setLogSink` runs still ends up visible in the Extension
 * Host panel.
 *
 * Usage:
 *   import { log } from "./log";
 *   log.info("loaded config from %s", uri.fsPath);
 *   log.error("failed to reach sshpass:", err);
 */

/**
 * Minimal interface the logger needs. `vscode.OutputChannel` satisfies it
 * structurally, and tests can pass a hand-rolled `{appendLine, show?}`.
 */
export interface LogSink {
  appendLine(line: string): void;
  show?(preserveFocus?: boolean): void;
}

let sink: LogSink | undefined;

export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

export const log = {
  info(msg: string, ...args: unknown[]): void {
    emit("INFO", msg, args);
  },
  warn(msg: string, ...args: unknown[]): void {
    emit("WARN", msg, args);
  },
  error(msg: string, ...args: unknown[]): void {
    emit("ERROR", msg, args);
  },
  debug(msg: string, ...args: unknown[]): void {
    emit("DEBUG", msg, args);
  },
  show(preserveFocus?: boolean): void {
    if (sink?.show) {
      sink.show(preserveFocus);
    }
  },
  /**
   * Run `fn` and log its elapsed time. Emits INFO on fast paths and
   * WARN when the run exceeds `slowMs` (default 200 ms). Exceptions
   * propagate — we log them as ERROR with the elapsed time so
   * reviewers can spot "the crash took 5 seconds before throwing".
   *
   * Returns whatever `fn` returns so call sites read naturally:
   *
   *   const cfg = await log.timed("loadConfig", () => loader());
   */
  async timed<T>(
    label: string,
    fn: () => Promise<T> | T,
    options: { slowMs?: number } = {},
  ): Promise<T> {
    const slowMs = options.slowMs ?? 200;
    const start = Date.now();
    try {
      const result = await fn();
      const elapsed = Date.now() - start;
      if (elapsed > slowMs) {
        emit("WARN", `${label} took ${elapsed}ms (slow — threshold ${slowMs}ms)`, []);
      } else {
        emit("INFO", `${label} took ${elapsed}ms`, []);
      }
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      emit("ERROR", `${label} failed after ${elapsed}ms:`, [err]);
      throw err;
    }
  },
};

function emit(level: Level, msg: string, args: unknown[]): void {
  const line = formatLine(level, msg, args);
  if (sink) {
    sink.appendLine(line);
    return;
  }
  // No sink yet — fall through to console. Uses warn/error so it still
  // shows up in the Extension Host panel even before `setLogSink` runs.
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.warn(line);
  }
}

/** Format a single log line. Exported for direct unit testing. */
export function formatLine(
  level: Level,
  msg: string,
  args: unknown[],
): string {
  const ts = new Date().toISOString();
  const suffix = args.length > 0 ? " " + args.map(formatArg).join(" ") : "";
  return `${ts} [${level}] ${msg}${suffix}`;
}

function formatArg(a: unknown): string {
  if (a instanceof Error) {
    return a.stack ?? `${a.name}: ${a.message}`;
  }
  if (typeof a === "string") {
    return a;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}
