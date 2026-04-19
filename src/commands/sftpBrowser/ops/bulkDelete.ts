/**
 * handleBulkDelete — batched deletion for multi-select. Files + dirs
 * each share one `ssh rm` (`rm -rf` for dirs) invocation so the whole
 * selection lands in two round-trips total instead of N.
 *
 * Using `ssh rm` instead of `sftp -b rm` keeps password-auth working
 * under sshpass: sftp's batch mode hardcodes `BatchMode=yes` on its
 * internal ssh, starving sshpass of the password feed and surfacing
 * as "Permission denied (publickey,password)". `ssh <cmd>` inherits
 * the parent's PTY so sshpass can answer normally.
 */
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import {
  type FileEntry,
  runSshRemote,
  shellQuoteRemotePath,
} from "../../../remote";
import { parentDir, summarizeBulkResult } from "../../sftpBrowserHelpers";
import type { LogOp, SshInvocation } from "../types";

export async function handleBulkDelete(
  inv: SshInvocation,
  items: { path: string; kind: FileEntry["kind"] }[],
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  runLs: (p: string) => Promise<void>,
  logOp: LogOp,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const fileCount = items.filter((i) => i.kind !== "dir").length;
  const dirCount = items.length - fileCount;
  const detail = [
    `${items.length} items selected.`,
    fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"}.` : null,
    dirCount > 0
      ? `${dirCount} director${dirCount === 1 ? "y" : "ies"} (rm -rf, recursive).`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  const pick = await vscode.window.showWarningMessage(
    `vsCRT: delete ${items.length} selected ${items.length === 1 ? "entry" : "entries"}?`,
    { modal: true, detail },
    "Delete all",
  );
  if (pick !== "Delete all") {
    return;
  }
  const fileItems = items.filter((i) => i.kind !== "dir");
  const dirItems = items.filter((i) => i.kind === "dir");
  let successes = 0;
  let failures = 0;

  if (fileItems.length > 0) {
    try {
      const pathsArgv = fileItems
        .map((i) => shellQuoteRemotePath(i.path))
        .join(" ");
      // `rm --` disables option parsing so any leading `-` in a
      // filename doesn't get mistaken for a flag.
      await runSshRemote(inv, `rm -- ${pathsArgv}`);
      for (const i of fileItems) {
        logOp("delete", true, i.path);
      }
      successes += fileItems.length;
    } catch (err) {
      for (const i of fileItems) {
        logOp("delete", false, i.path, formatError(err));
      }
      failures += fileItems.length;
    }
  }
  if (dirItems.length > 0) {
    try {
      const pathsArgv = dirItems
        .map((i) => shellQuoteRemotePath(i.path))
        .join(" ");
      await runSshRemote(inv, `rm -rf -- ${pathsArgv}`);
      for (const i of dirItems) {
        logOp("delete", true, i.path);
      }
      successes += dirItems.length;
    } catch (err) {
      for (const i of dirItems) {
        logOp("delete", false, i.path, formatError(err));
      }
      failures += dirItems.length;
    }
  }

  const summary = summarizeBulkResult(successes, failures, "entry");
  if (summary.kind === "ok") {
    postInfo(`Deleted: ${summary.message}`);
  } else if (summary.kind !== "none") {
    postError(new Error(summary.message), "bulk delete");
  }
  await runLs(parentDir(items[0].path));
}
