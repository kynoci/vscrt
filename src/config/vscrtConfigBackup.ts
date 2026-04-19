/**
 * Rolling backup of ~/.vscrt/vscrtConfig.json. Every successful write first
 * snapshots the prior on-disk copy to `~/.vscrt/backups/<ISO>.json`, then lets
 * the main write proceed. The oldest backups beyond BACKUP_CAP are deleted
 * after each write so the backup folder stays bounded.
 *
 * These helpers are FS-pure (no VS Code dependency) so they can be unit-tested
 * against a tmpdir. The service wraps them via the `writeFile` path.
 */

import * as fs from "fs";
import * as path from "path";
import { BACKUPS_SUBFOLDER } from "../fsPaths";

export const BACKUP_CAP = 10;
/** @deprecated use `BACKUPS_SUBFOLDER` from `../fsPaths` instead. */
export const BACKUP_SUBFOLDER = BACKUPS_SUBFOLDER;

/** One entry in the rolling backup list, newest-first. */
export interface BackupEntry {
  filename: string;
  fullPath: string;
  /** Parsed from the ISO-like filename. NaN on malformed names (still listed). */
  timestamp: number;
}

/** `2026-04-16T21-07-42-123Z` — colons become `-` so the name is path-safe. */
export function formatBackupTimestamp(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\.(\d+)Z$/, "-$1Z");
}

/** Reverse of `formatBackupTimestamp`. Returns NaN for unparseable names. */
export function parseBackupTimestamp(filename: string): number {
  // vscrtConfig.2026-04-16T21-07-42-123Z.json
  const m = filename.match(
    /^vscrtConfig\.(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d+)Z\.json$/,
  );
  if (!m) {
    return NaN;
  }
  const iso = `${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Copy the current config file to a timestamped backup. Idempotent on a
 * missing source (first-ever save hits this path — no prior file to back up).
 * Returns the path written, or null when the source didn't exist.
 */
export async function createBackup(
  sourcePath: string,
  backupsDir: string,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    await fs.promises.stat(sourcePath);
  } catch {
    return null;
  }
  await fs.promises.mkdir(backupsDir, { recursive: true, mode: 0o700 });
  const filename = `vscrtConfig.${formatBackupTimestamp(now)}.json`;
  const dest = path.join(backupsDir, filename);
  await fs.promises.copyFile(sourcePath, dest);
  return dest;
}

/**
 * Return backup entries newest-first. Tolerant of unexpected filenames — they
 * still appear in the list but sort last (NaN > everything pushes them down).
 */
export async function listBackups(
  backupsDir: string,
): Promise<BackupEntry[]> {
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(backupsDir);
  } catch {
    return [];
  }
  const entries: BackupEntry[] = names
    .filter((n) => n.startsWith("vscrtConfig.") && n.endsWith(".json"))
    .map((filename) => ({
      filename,
      fullPath: path.join(backupsDir, filename),
      timestamp: parseBackupTimestamp(filename),
    }));
  entries.sort((a, b) => {
    // Newest-first; NaN sorts to the end so corrupt names don't shadow good ones.
    const aBad = !Number.isFinite(a.timestamp);
    const bBad = !Number.isFinite(b.timestamp);
    if (aBad && !bBad) {
      return 1;
    }
    if (!aBad && bBad) {
      return -1;
    }
    if (aBad && bBad) {
      return a.filename.localeCompare(b.filename);
    }
    return b.timestamp - a.timestamp;
  });
  return entries;
}

/**
 * Delete backups beyond `cap`, oldest first. Returns the list of paths
 * deleted so tests can assert the rotation is correct.
 */
export async function rotateBackups(
  backupsDir: string,
  cap: number = BACKUP_CAP,
): Promise<string[]> {
  const entries = await listBackups(backupsDir);
  const excess = entries.slice(cap);
  const deleted: string[] = [];
  for (const e of excess) {
    try {
      await fs.promises.unlink(e.fullPath);
      deleted.push(e.fullPath);
    } catch {
      // A file disappearing out from under us is fine — just move on.
    }
  }
  return deleted;
}

/** Convenience: create + rotate in one call. Used by the save path. */
export async function createAndRotateBackup(
  sourcePath: string,
  backupsDir: string,
  cap: number = BACKUP_CAP,
): Promise<string | null> {
  const created = await createBackup(sourcePath, backupsDir);
  if (created !== null) {
    await rotateBackups(backupsDir, cap);
  }
  return created;
}
