/**
 * handleDelete — remove one remote entry via `ssh rm` (`rm -rf` for
 * dirs). Always confirms modally.
 *
 * Both kinds go through `ssh` rather than `sftp -b rm` so password-
 * auth profiles work under sshpass (see `bulkDelete.ts` for the
 * full reasoning).
 */
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import {
  type FileEntry,
  runSshRemote,
  shellQuoteRemotePath,
} from "../../../remote";
import { parentDir } from "../../sftpBrowserHelpers";
import type { LogOp, SshInvocation } from "../types";

export async function handleDelete(
  inv: SshInvocation,
  remotePath: string,
  kind: FileEntry["kind"],
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  runLs: (p: string) => Promise<void>,
  logOp: LogOp,
): Promise<void> {
  const detail =
    kind === "dir"
      ? `"${remotePath}" and its contents will be removed recursively (rm -rf).`
      : `"${remotePath}" will be removed.`;
  const pick = await vscode.window.showWarningMessage(
    "vsCRT: delete this entry?",
    { modal: true, detail },
    "Delete",
  );
  if (pick !== "Delete") {
    return;
  }
  try {
    const flag = kind === "dir" ? "-rf" : "";
    await runSshRemote(
      inv,
      `rm ${flag} -- ${shellQuoteRemotePath(remotePath)}`.replace(/\s+/g, " "),
    );
    postInfo(`Deleted ${remotePath}`);
    logOp("delete", true, remotePath);
    await runLs(parentDir(remotePath));
  } catch (err) {
    postError(err, `delete of ${remotePath} failed`);
    logOp("delete", false, remotePath, formatError(err));
  }
}
