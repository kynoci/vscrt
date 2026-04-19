/**
 * handleChmod — change remote-file permissions via `ssh chmod`.
 * Validates octal mode before sending.
 *
 * Uses `ssh chmod` rather than `sftp -b chmod` so password-auth
 * profiles work under sshpass (see `bulkDelete.ts`).
 */
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { runSshRemote, shellQuoteRemotePath } from "../../../remote";
import { parentDir } from "../../sftpBrowserHelpers";
import type { LogOp, SshInvocation } from "../types";

export async function handleChmod(
  inv: SshInvocation,
  remotePath: string,
  currentPerms: string,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  runLs: (p: string) => Promise<void>,
  logOp: LogOp,
): Promise<void> {
  const mode = await vscode.window.showInputBox({
    title: "vsCRT: Change Permissions",
    prompt: `Octal mode for ${remotePath} (current: ${currentPerms})`,
    placeHolder: "755",
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^[0-7]{3,4}$/.test(v.trim())
        ? null
        : "Expected 3 or 4 octal digits (e.g. 644, 0755).",
  });
  if (!mode) {
    return;
  }
  try {
    await runSshRemote(
      inv,
      `chmod ${mode.trim()} -- ${shellQuoteRemotePath(remotePath)}`,
    );
    postInfo(`chmod ${mode.trim()} ${remotePath}`);
    logOp("chmod", true, remotePath);
    await runLs(parentDir(remotePath));
  } catch (err) {
    postError(err, `chmod on ${remotePath} failed`);
    logOp("chmod", false, remotePath, formatError(err));
  }
}
