/**
 * handleUpload — toolbar-dialog upload entry point. Delegates to
 * `uploadUris` which is shared with the drag-drop path.
 *
 * `uploadUris` performs the existence + overwrite pre-checks, chooses
 * single-shot vs queue based on count, and runs transfers under a
 * live-progress notification.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { log } from "../../../log";
import {
  runSftpBatch,
  runSshRemote,
  runSshUploadFromFile,
  shellQuoteRemotePath,
} from "../../../remote";
import { posixJoin } from "../../sftpBrowserHelpers";
import { TransferQueue, summarizeTransferResults } from "../../transferQueue";
import { formatBytes } from "../progress/formatters";
import { withLiveTransferProgress } from "../progress/withLiveTransferProgress";
import type { LogOp, SshInvocation } from "../types";

/**
 * Upload a single file via the most-compatible runner for this
 * invocation. `sftp put` via `runSftpBatch` is preferred for
 * publickey/agent auth (preserves file attrs), but `sftp -b -`
 * breaks password-auto + sshpass (the internal ssh subprocess has
 * `BatchMode=yes` hardcoded, starving sshpass of the password feed).
 * Fall back to `ssh 'cat > remote' < local` for sshpass invocations
 * so password auth works.
 */
function putOne(
  inv: SshInvocation,
  localPath: string,
  remotePath: string,
): Promise<void> {
  if (inv.passwordArgs.length > 0) {
    return runSshUploadFromFile(inv, localPath, remotePath);
  }
  return runSftpBatch(inv, [
    `put ${shellQuoteRemotePath(localPath)} ${shellQuoteRemotePath(remotePath)}`,
  ]);
}

export async function handleUpload(
  inv: SshInvocation,
  intoPath: string,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  runLs: (p: string) => Promise<void>,
  logOp: LogOp,
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: "Upload to remote",
  });
  if (!uris || uris.length === 0) {
    return;
  }
  await uploadUris(inv, intoPath, uris, postInfo, postError, runLs, logOp);
}

/**
 * Upload a caller-provided list of URIs. Shared by the toolbar
 * dialog-driven `handleUpload` and the drag-drop `handleDropUpload`.
 * Enforces the same existence + overwrite pre-checks so both entry
 * points behave identically.
 */
export async function uploadUris(
  inv: SshInvocation,
  intoPath: string,
  uris: vscode.Uri[],
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  runLs: (p: string) => Promise<void>,
  logOp: LogOp,
): Promise<void> {
  // H2: pre-check that `intoPath` exists as a directory. If not, offer
  // to mkdir it and then proceed.
  try {
    await runSshRemote(
      inv,
      `test -d ${shellQuoteRemotePath(intoPath)} || exit 17`,
    );
  } catch {
    const choice = await vscode.window.showWarningMessage(
      `vsCRT: ${intoPath} doesn't exist on the remote.`,
      { modal: true, detail: "Create the directory and continue?" },
      "Create & Upload",
    );
    if (choice !== "Create & Upload") {
      return;
    }
    try {
      await runSshRemote(inv, `mkdir -p ${shellQuoteRemotePath(intoPath)}`);
      logOp("mkdir", true, intoPath);
    } catch (err) {
      postError(err, `mkdir ${intoPath} failed`);
      logOp("mkdir", false, intoPath, formatError(err));
      return;
    }
  }

  // Q3: warn before overwriting existing remote files.
  const remoteTargets = uris.map((u) =>
    posixJoin(intoPath, path.basename(u.fsPath)),
  );
  try {
    const checkCmd = `ls -d ${remoteTargets.map(shellQuoteRemotePath).join(" ")} 2>/dev/null`;
    const stdout = await runSshRemote(inv, checkCmd);
    const existing = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (existing.length > 0) {
      const detail =
        existing.length <= 6
          ? `The following will be overwritten:\n\n${existing.join("\n")}`
          : `${existing.length} files will be overwritten, including:\n\n${existing.slice(0, 5).join("\n")}\n…`;
      const choice = await vscode.window.showWarningMessage(
        `vsCRT: upload will overwrite ${existing.length} existing ${existing.length === 1 ? "file" : "files"} in ${intoPath}.`,
        { modal: true, detail },
        "Overwrite",
      );
      if (choice !== "Overwrite") {
        return;
      }
    }
  } catch (err) {
    // `ls -d` with no existing entries exits non-zero.
    log.debug(
      "upload overwrite pre-check non-zero exit (likely no overwrites):",
      err,
    );
  }

  let totalBytes = 0;
  for (const uri of uris) {
    try {
      const st = await fs.promises.stat(uri.fsPath);
      totalBytes += st.size;
    } catch {
      // Size is best-effort for the header.
    }
  }

  // Single-file upload keeps the legacy one-shot path — spawning a
  // queue for one file adds ceremony with no win.
  if (uris.length === 1) {
    const uri = uris[0];
    const remote = posixJoin(intoPath, path.basename(uri.fsPath));
    try {
      await withLiveTransferProgress(
        {
          title: `Uploading ${path.basename(uri.fsPath)} (${formatBytes(totalBytes)})…`,
          totalBytes: 0,
          getBytes: () => 0,
        },
        () => putOne(inv, uri.fsPath, remote),
      );
      postInfo(`Uploaded ${path.basename(uri.fsPath)} → ${intoPath}`);
      logOp("upload", true, remote);
      await runLs(intoPath);
    } catch (err) {
      postError(err, "upload failed");
      logOp("upload", false, remote, formatError(err));
    }
    return;
  }

  // Bulk: split into per-file tasks and drain via the concurrency queue.
  const queue = new TransferQueue<void>({ concurrency: 3 });
  for (let i = 0; i < uris.length; i += 1) {
    const uri = uris[i];
    const name = path.basename(uri.fsPath);
    const remote = posixJoin(intoPath, name);
    queue.add({
      id: `up-${i}`,
      label: name,
      run: async () => putOne(inv, uri.fsPath, remote),
    });
  }

  const results = await withLiveTransferProgress(
    {
      title: `Uploading ${uris.length} files (${formatBytes(totalBytes)})…`,
      totalBytes: 0,
      getBytes: () => 0,
    },
    () => queue.drain(),
  );

  for (const r of results) {
    const uri = uris[parseInt(r.id.replace("up-", ""), 10)];
    const remote = uri
      ? posixJoin(intoPath, path.basename(uri.fsPath))
      : r.label;
    if (r.outcome === "success") {
      logOp("upload", true, remote);
    } else {
      logOp("upload", false, remote, r.error ? formatError(r.error) : r.outcome);
    }
  }

  const summary = summarizeTransferResults(results);
  if (summary.kind === "success") {
    postInfo(`Uploaded ${results.length} files → ${intoPath}`);
    await runLs(intoPath);
  } else if (summary.kind === "partial") {
    postError(new Error(summary.message), `bulk upload: ${summary.message}`);
    await runLs(intoPath);
  } else if (summary.kind === "failed") {
    postError(new Error(summary.message), `bulk upload failed`);
  } else {
    postInfo(summary.message);
  }
}
