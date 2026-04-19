/**
 * Opt-in session transcript recorder. When enabled, a session's stdout
 * (and optionally stdin) is mirrored to a timestamped gzip file under
 * `~/.vscrt/sessions/`. Defaults to off; the setting + per-node flag
 * are visible in the Help panel so users know what's being written.
 *
 * Design notes:
 *   - We don't implement VS Code's `Pseudoterminal` interface here (that
 *     would require re-hosting the ssh child process). Instead we hook
 *     the existing `runInTerminal` path and write a marker file + a
 *     "recording started/finished" metadata stub. The full pty-tee is a
 *     follow-up; this MVP gets the directory structure, the filename
 *     scheme, the rotation logic, and the setting surface in place.
 *   - Filename: `<ISO>-<sanitised-node-name>-<pid>.meta.json`. The
 *     matching `.log.gz` transcript is written by a future version.
 *   - The metadata-only form is still useful: it records "session
 *     X opened on this host at T for duration D" in a structured form
 *     that `vsCRT.showSessionRecordings` can list.
 *
 * Why ship the skeleton now? Because the setting, the directory, the
 * QuickPick command, and the privacy prose are the expensive parts to
 * design — the actual pty-tee implementation is relatively mechanical
 * once the surface is locked in.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SESSIONS_SUBFOLDER, VSCRT_HOME_NAME } from "../../fsPaths";
import { log } from "../../log";

export type SessionRecordingMode = "off" | "minimal" | "full";

export function parseSessionRecordingMode(
  raw: unknown,
): SessionRecordingMode {
  if (raw === "off" || raw === "minimal" || raw === "full") {
    return raw;
  }
  return "off";
}

export interface SessionMetadata {
  timestamp: string;          // ISO 8601
  serverName: string;
  endpoint?: string;
  authMode: string;
  mode: SessionRecordingMode;
  pid: number;
  /**
   * Session kind: `"ssh"` (default) or `"sftp"`. Missing for older
   * recordings written before the field existed.
   */
  sessionKind?: "ssh" | "sftp";
}

export function sessionsDir(home: string = os.homedir()): string {
  return path.join(home, VSCRT_HOME_NAME, SESSIONS_SUBFOLDER);
}

/** Slug-safe filename fragment for the server name. */
export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function filenameFor(meta: SessionMetadata): string {
  const stamp = meta.timestamp.replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${slugifyName(meta.serverName)}-${meta.pid}.meta.json`;
}

/**
 * Write a metadata stub for a session. The matching transcript (`.log.gz`)
 * is emitted in a future version when the pty-tee lands.
 */
export async function writeSessionMetadata(
  meta: SessionMetadata,
  home: string = os.homedir(),
): Promise<string | null> {
  if (meta.mode === "off") {
    return null;
  }
  const dir = sessionsDir(home);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, filenameFor(meta));
  await fs.promises.writeFile(
    filePath,
    JSON.stringify(meta, null, 2) + "\n",
    { encoding: "utf-8", mode: 0o600 },
  );
  log.info(`session recording metadata → ${filePath}`);
  return filePath;
}

export interface SessionFile {
  filename: string;
  fullPath: string;
  /** Parsed from the leading ISO in the filename. NaN on malformed names. */
  timestamp: number;
}

export async function listSessionRecordings(
  home: string = os.homedir(),
): Promise<SessionFile[]> {
  const dir = sessionsDir(home);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: SessionFile[] = names
    .filter((n) => n.endsWith(".meta.json"))
    .map((filename) => {
      const m = filename.match(
        /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)/,
      );
      const iso = m ? `${m[1].slice(0, 13)}:${m[1].slice(14, 16)}:${m[1].slice(17, 19)}Z` : "";
      const ts = iso ? Date.parse(iso) : NaN;
      return { filename, fullPath: path.join(dir, filename), timestamp: ts };
    });
  out.sort((a, b) => {
    const aBad = !Number.isFinite(a.timestamp);
    const bBad = !Number.isFinite(b.timestamp);
    if (aBad && !bBad) {return 1;}
    if (!aBad && bBad) {return -1;}
    if (aBad && bBad) {return a.filename.localeCompare(b.filename);}
    return b.timestamp - a.timestamp;
  });
  return out;
}
