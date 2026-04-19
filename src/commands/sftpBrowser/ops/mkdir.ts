/**
 * handleMkdir — create a directory inside `intoPath`. Validates name
 * shape (no slashes, not `.` / `..`) before issuing the mkdir.
 *
 * Posts a `busy` signal while the child is running so the user gets
 * spinner feedback even when the server takes a moment to respond.
 *
 * Auth-mode split: password-auto invocations go through `runSshRemote
 * mkdir -p` because `sftp -b -` hardcodes `BatchMode=yes` on its
 * internal ssh subprocess, starving sshpass of the password feed and
 * surfacing as "Permission denied (publickey,password)". Publickey /
 * agent auth keeps `sftp -b mkdir` — it doesn't rely on sshpass and
 * benefits from sftp's cleaner error reporting.
 */
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { log } from "../../../log";
import {
  runSftpBatch,
  runSshRemote,
  shellQuoteRemotePath,
} from "../../../remote";
import { posixJoin } from "../../sftpBrowserHelpers";
import type { LogOp, SshInvocation } from "../types";

async function mkdirRemote(
  inv: SshInvocation,
  fullPath: string,
): Promise<void> {
  if (inv.passwordArgs.length > 0) {
    await runSshRemote(inv, `mkdir -p ${shellQuoteRemotePath(fullPath)}`);
    return;
  }
  await runSftpBatch(inv, [`mkdir ${shellQuoteRemotePath(fullPath)}`]);
}

export async function handleMkdir(
  inv: SshInvocation,
  intoPath: string,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  postBusy: (busy: boolean) => void,
  runLs: (p: string) => Promise<void>,
  logOp: LogOp,
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "vsCRT: New Folder",
    prompt: `Create a new folder inside ${intoPath}`,
    placeHolder: "new-folder",
    ignoreFocusOut: true,
    validateInput: (v) =>
      !v.trim()
        ? "Name required."
        : v.includes("/")
          ? "No slashes."
          : v === "." || v === ".."
            ? "Reserved name."
            : null,
  });
  if (!name) {
    log.info("mkdir: user cancelled the New Folder prompt.");
    return;
  }
  const full = posixJoin(intoPath, name.trim());
  log.info(`mkdir: creating "${full}"`);
  postBusy(true);
  try {
    await mkdirRemote(inv, full);
    postInfo(`Created ${full}`);
    logOp("mkdir", true, full);
    await runLs(intoPath);
  } catch (err) {
    postError(err, `mkdir in ${intoPath} failed`);
    logOp("mkdir", false, full, formatError(err));
  } finally {
    postBusy(false);
  }
}
