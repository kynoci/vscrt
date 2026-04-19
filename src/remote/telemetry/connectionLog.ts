/**
 * Lightweight audit trail. Every connect attempt writes one JSONL entry
 * to `~/.vscrt/connections.log`. A rolling rotation keeps the file
 * bounded, and a settings-driven verbosity switch ensures users who
 * don't want any disk-resident history can turn the whole feature off.
 *
 * Deliberately NOT a session-output recorder — that's a bigger feature
 * with privacy implications (see README "Known limitations"). This
 * module only logs the existence of a connect attempt, the target, and
 * the outcome.
 *
 * Exports are FS-pure (no VS Code imports) so mocha can drive them
 * against a tmp HOME directly.
 */

import * as fs from "fs";
import * as path from "path";
import { CONNECTION_LOG_FILENAME, VSCRT_HOME_NAME } from "../../fsPaths";

export { CONNECTION_LOG_FILENAME };
export const CONNECTION_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB before rotation
export const CONNECTION_LOG_ROTATED_SUFFIX = ".1";

export type ConnectionLogMode = "off" | "minimal" | "verbose";

export function parseConnectionLogMode(raw: unknown): ConnectionLogMode {
  if (raw === "off" || raw === "minimal" || raw === "verbose") {
    return raw;
  }
  return "off";
}

export type ConnectionOutcome =
  | "started"
  | "connected"
  | "failed"
  | "cancelled";

/**
 * Which kind of session produced this log entry. `"ssh"` covers a
 * standard interactive shell; `"sftp"` covers a file-transfer session
 * opened via `vsCRT.openSftp`. Absent field = `"ssh"` (older entries
 * written before the kind was tracked).
 */
export type SessionKind = "ssh" | "sftp";

/**
 * For `sessionKind === "sftp"` entries produced by the browser panel,
 * the specific file operation that was performed. Absent field on an
 * sftp row means "the session itself was opened" (the terminal /
 * browser panel entry point, same as existing `sessionKind: "sftp"`
 * rows before the `action` field was introduced).
 */
export type SftpAction =
  | "upload"
  | "download"
  | "delete"
  | "mkdir"
  | "rename"
  | "chmod"
  | "preview"
  | "list";

export interface ConnectionLogEntry {
  timestamp: string;          // ISO 8601
  serverName: string;
  endpoint?: string;          // present in verbose mode
  authMode: string;           // e.g. "publickey" | "agent" | "password-auto"
  outcome: ConnectionOutcome;
  elapsedMs?: number;
  errorMessage?: string;      // present in verbose mode
  /** Session kind; omitted when equal to the default `"ssh"`. */
  sessionKind?: SessionKind;
  /** For sftp rows produced by the browser panel, the specific op. */
  action?: SftpAction;
  /** Remote path acted on — present for sftp file-op rows in verbose mode. */
  remotePath?: string;
}

/**
 * Build the on-disk shape for an entry honouring the user's verbosity
 * setting. Pure — no I/O — so tests can assert on the redaction.
 */
export function shapeEntryForDisk(
  entry: ConnectionLogEntry,
  mode: ConnectionLogMode,
): ConnectionLogEntry | null {
  if (mode === "off") {
    return null;
  }
  if (mode === "minimal") {
    const out: ConnectionLogEntry = {
      timestamp: entry.timestamp,
      serverName: entry.serverName,
      authMode: entry.authMode,
      outcome: entry.outcome,
    };
    if (entry.elapsedMs !== undefined) {
      out.elapsedMs = entry.elapsedMs;
    }
    // `sessionKind` is a 3-5 char enum — not PII or endpoint detail —
    // so it flows through even in `minimal`. It's the cheap way to
    // tell ssh-vs-sftp traffic apart when scanning the log.
    if (entry.sessionKind !== undefined && entry.sessionKind !== "ssh") {
      out.sessionKind = entry.sessionKind;
    }
    // `action` tells ssh-vs-sftp traffic apart inside the minimal-mode
    // log — cheap to include (5-8 chars) and strictly enum.
    if (entry.action !== undefined) {
      out.action = entry.action;
    }
    // NB: `remotePath` is intentionally dropped in minimal mode — it's
    // a user-controlled value and may contain sensitive paths.
    return out;
  }
  // verbose
  return { ...entry };
}

function logPath(home: string): string {
  return path.join(home, VSCRT_HOME_NAME, CONNECTION_LOG_FILENAME);
}

/**
 * Append a single entry. Rotates the file if it's over the byte
 * threshold first. Resilient to a missing `~/.vscrt/` — creates it
 * with 0700 perms.
 */
export async function appendEntry(
  home: string,
  entry: ConnectionLogEntry,
  mode: ConnectionLogMode,
): Promise<void> {
  const shaped = shapeEntryForDisk(entry, mode);
  if (!shaped) {
    return;
  }
  const filePath = logPath(home);
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await maybeRotate(filePath);
  await fs.promises.appendFile(filePath, JSON.stringify(shaped) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Read up to `limit` most-recent entries. Ignores lines that don't
 * parse as JSON so a hand-edited or partially-written log doesn't
 * crash the reader.
 */
export async function readLastN(
  home: string,
  limit = 200,
): Promise<ConnectionLogEntry[]> {
  const filePath = logPath(home);
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-limit);
  const out: ConnectionLogEntry[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as ConnectionLogEntry);
    } catch {
      // Skip unparseable lines.
    }
  }
  return out;
}

/** Rotate `<file>` to `<file>.1` when it grows past the cap. */
export async function maybeRotate(filePath: string): Promise<void> {
  let size = 0;
  try {
    const stat = await fs.promises.stat(filePath);
    size = stat.size;
  } catch {
    return; // file doesn't exist yet — nothing to rotate
  }
  if (size < CONNECTION_LOG_MAX_BYTES) {
    return;
  }
  const rotated = filePath + CONNECTION_LOG_ROTATED_SUFFIX;
  try {
    await fs.promises.rename(filePath, rotated);
  } catch {
    // best-effort — if we can't rotate, next append still goes to the
    // uncapped file and we'll try again next time.
  }
}

/** Small helper so call sites read like `entry(now(), node, "started")`. */
export function makeEntry(
  now: Date,
  serverName: string,
  authMode: string,
  outcome: ConnectionOutcome,
  extras: {
    endpoint?: string;
    elapsedMs?: number;
    errorMessage?: string;
    sessionKind?: SessionKind;
    action?: SftpAction;
    remotePath?: string;
  } = {},
): ConnectionLogEntry {
  return {
    timestamp: now.toISOString(),
    serverName,
    authMode,
    outcome,
    ...extras,
  };
}
