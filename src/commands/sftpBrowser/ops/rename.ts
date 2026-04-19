/**
 * handleRename — rename an entry via `ssh mv`, with a collision
 * pre-check and explicit overwrite confirmation.
 *
 * Uses `ssh mv` rather than `sftp -b rename` so password-auth
 * profiles work under sshpass (see `bulkDelete.ts` for the reasoning
 * behind routing mutation ops away from sftp batch mode).
 */
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { runSshRemote, shellQuoteRemotePath } from "../../../remote";
import { parentDir, posixJoin } from "../../sftpBrowserHelpers";
import type { LogOp, SshInvocation } from "../types";

export async function handleRename(
  inv: SshInvocation,
  oldPath: string,
  newName: string,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  runLs: (p: string) => Promise<void>,
  logOp: LogOp,
): Promise<void> {
  const trimmed = newName.trim();
  if (!trimmed || trimmed.includes("/") || trimmed === "." || trimmed === "..") {
    postError(
      new Error(`Invalid name: "${newName}"`),
      "rename validation failed",
    );
    return;
  }
  const oldBasename = oldPath.slice(oldPath.lastIndexOf("/") + 1);
  if (trimmed === oldBasename) {
    postInfo(`Rename skipped — already named "${trimmed}".`);
    return;
  }
  const newPath = posixJoin(parentDir(oldPath), trimmed);

  try {
    await runSshRemote(inv, `test ! -e ${shellQuoteRemotePath(newPath)}`);
  } catch {
    const choice = await vscode.window.showWarningMessage(
      `vsCRT: ${newPath} already exists on the remote.`,
      { modal: true, detail: "Overwrite the existing entry?" },
      "Overwrite",
    );
    if (choice !== "Overwrite") {
      return;
    }
    try {
      await runSshRemote(inv, `rm -rf ${shellQuoteRemotePath(newPath)}`);
    } catch (err) {
      postError(err, `could not remove existing ${newPath}`);
      return;
    }
  }

  try {
    await runSshRemote(
      inv,
      `mv -- ${shellQuoteRemotePath(oldPath)} ${shellQuoteRemotePath(newPath)}`,
    );
    postInfo(`Renamed → ${trimmed}`);
    logOp("rename", true, newPath);
    await runLs(parentDir(oldPath));
  } catch (err) {
    postError(err, `rename of ${oldPath} failed`);
    logOp("rename", false, oldPath, formatError(err));
  }
}
