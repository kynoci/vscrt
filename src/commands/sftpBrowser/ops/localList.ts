/**
 * handleLocalList — list a local directory for the E1 two-pane view.
 *
 * Expands `~` to the user's home dir; errors surface via a
 * `localListing` message with an `error` string so the pane can
 * render "Error: <msg>" rather than crashing.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { formatError } from "../../../errorUtils";
import type { E2W, LocalFileEntry } from "../types";

const PERMS_SUPPORTED = process.platform !== "win32";

/**
 * Format a Node `stat.mode` as a POSIX-style 10-character string
 * (`drwxr-xr-x`). Only meaningful on POSIX hosts — Windows's fs
 * layer synthesises read/write bits from the DOS attribute byte,
 * which doesn't map cleanly onto user/group/other rwx.
 */
function formatPosixMode(
  mode: number,
  kind: LocalFileEntry["kind"],
): string {
  const typeChar = kind === "dir" ? "d" : kind === "file" ? "-" : "?";
  const triplet = (n: number): string =>
    ((n & 4) ? "r" : "-") + ((n & 2) ? "w" : "-") + ((n & 1) ? "x" : "-");
  return (
    typeChar +
    triplet((mode >> 6) & 7) +
    triplet((mode >> 3) & 7) +
    triplet(mode & 7)
  );
}

export async function handleLocalList(
  rawPath: string,
  post: (msg: E2W) => void,
): Promise<void> {
  const resolved =
    rawPath === "~" || rawPath.startsWith("~/")
      ? path.join(os.homedir(), rawPath.slice(1))
      : rawPath;
  try {
    const names = await fs.promises.readdir(resolved);
    const entries: LocalFileEntry[] = [];
    for (const name of names) {
      try {
        const stat = await fs.promises.stat(path.join(resolved, name));
        let kind: LocalFileEntry["kind"] = "other";
        if (stat.isDirectory()) {
          kind = "dir";
        } else if (stat.isFile()) {
          kind = "file";
        }
        entries.push({
          name,
          kind,
          size: stat.size,
          mtime: stat.mtime.toISOString().slice(0, 19).replace("T", " "),
          perms: PERMS_SUPPORTED ? formatPosixMode(stat.mode, kind) : undefined,
        });
      } catch {
        // Unreadable entry — skip, don't fail the whole listing.
      }
    }
    post({ type: "localListing", path: resolved, entries });
  } catch (err) {
    post({
      type: "localListing",
      path: resolved,
      entries: [],
      error: formatError(err),
    });
  }
}
