/**
 * handleLocalRename — `fs.rename` on the local filesystem, bounded to
 * a single directory (new name may not contain path separators, so
 * users can't accidentally move a file with this op). After a
 * successful rename we re-list the parent so the pane reflects the
 * change without a manual refresh.
 */
import * as fs from "fs";
import * as path from "path";
import { formatError } from "../../../errorUtils";
import { handleLocalList } from "./localList";
import type { E2W } from "../types";

export async function handleLocalRename(
  oldPath: string,
  newName: string,
  post: (msg: E2W) => void,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
): Promise<void> {
  const trimmed = newName.trim();
  if (!trimmed) {
    postError(new Error("name is empty"), "rename failed: empty name");
    return;
  }
  // Block path separators — rename is within a directory, not a move.
  // Also rejects "." / ".." which would silently no-op or overwrite.
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    postError(
      new Error(`invalid name: "${newName}"`),
      "rename failed: name may not contain path separators",
    );
    return;
  }
  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, trimmed);
  if (newPath === oldPath) {
    // Same name — nothing to do, but don't surface as an error.
    return;
  }
  try {
    // Refuse to silently clobber an existing entry.
    try {
      await fs.promises.access(newPath, fs.constants.F_OK);
      postError(
        new Error(`"${trimmed}" already exists`),
        "rename failed: target exists",
      );
      return;
    } catch {
      // Good — target doesn't exist.
    }
    await fs.promises.rename(oldPath, newPath);
    postInfo(`Renamed → ${trimmed}`);
  } catch (err) {
    postError(err, `local rename failed: ${formatError(err)}`);
  }
  // Refresh regardless of success — if the op half-completed we want
  // the user to see the real state.
  await handleLocalList(dir, post);
}
