/**
 * handleLocalDelete — remove a local file or directory, with a modal
 * confirmation prompt (same guardrail the remote delete op uses).
 *
 * Uses `vscode.workspace.fs.delete` with `useTrash: true` so users
 * can recover from mis-clicks via their OS trash / recycle bin.
 * Recursive for directories — matches the remote `rm -rf` semantics.
 */
import * as path from "path";
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { handleLocalList } from "./localList";
import type { E2W, LocalFileEntry } from "../types";

export async function handleLocalDelete(
  targetPath: string,
  kind: LocalFileEntry["kind"],
  post: (msg: E2W) => void,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
): Promise<void> {
  const basename = path.basename(targetPath);
  const label = kind === "dir" ? "folder" : "file";
  const choice = await vscode.window.showWarningMessage(
    `Delete ${label} "${basename}"? It will be moved to the trash.`,
    { modal: true },
    "Delete",
  );
  if (choice !== "Delete") {
    return;
  }
  const dir = path.dirname(targetPath);
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(targetPath), {
      recursive: kind === "dir",
      useTrash: true,
    });
    postInfo(`Deleted ${basename} (moved to trash)`);
  } catch (err) {
    postError(err, `local delete failed: ${formatError(err)}`);
  }
  await handleLocalList(dir, post);
}
