/**
 * handleBulkLocalDelete — batched local-pane deletion for multi-select.
 *
 * Mirrors `bulkDelete.ts` but for local files. Uses
 * `vscode.workspace.fs.delete` with `useTrash: true` so users can
 * recover via their OS trash / recycle bin; recursive for
 * directories, same as the single-delete handler.
 */
import * as path from "path";
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { summarizeBulkResult } from "../../sftpBrowserHelpers";
import { handleLocalList } from "./localList";
import type { E2W, LocalFileEntry } from "../types";

export async function handleBulkLocalDelete(
  items: { path: string; kind: LocalFileEntry["kind"] }[],
  post: (msg: E2W) => void,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const fileCount = items.filter((i) => i.kind !== "dir").length;
  const dirCount = items.length - fileCount;
  const detail = [
    `${items.length} items selected. They will be moved to the trash.`,
    fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"}.` : null,
    dirCount > 0
      ? `${dirCount} director${dirCount === 1 ? "y" : "ies"} (recursive).`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  const pick = await vscode.window.showWarningMessage(
    `vsCRT: delete ${items.length} selected ${items.length === 1 ? "entry" : "entries"} locally?`,
    { modal: true, detail },
    "Delete all",
  );
  if (pick !== "Delete all") {
    return;
  }

  let successes = 0;
  let failures = 0;
  for (const item of items) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(item.path), {
        recursive: item.kind === "dir",
        useTrash: true,
      });
      successes += 1;
    } catch (err) {
      failures += 1;
      postError(err, `local delete "${item.path}" failed: ${formatError(err)}`);
    }
  }

  const summary = summarizeBulkResult(successes, failures, "entry");
  if (summary.kind === "ok") {
    postInfo(`Deleted locally: ${summary.message}`);
  } else if (summary.kind !== "none") {
    postError(new Error(summary.message), "bulk local delete");
  }
  // Re-list the parent directory of the first item. All selected rows
  // share one local-pane path, so one re-list covers the whole set.
  await handleLocalList(path.dirname(items[0].path), post);
}
