/**
 * handleDownload — one-shot download with a Save-dialog destination
 * and live byte-progress via local `fs.stat` polling.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { runSftpBatch, shellQuoteRemotePath } from "../../../remote";
import { withLiveTransferProgress } from "../progress/withLiveTransferProgress";
import type { LogOp, SshInvocation } from "../types";

export async function handleDownload(
  inv: SshInvocation,
  remotePath: string,
  suggestedName: string,
  sizeBytes: number,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  logOp: LogOp,
): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    saveLabel: "Download",
    defaultUri: vscode.Uri.file(
      path.join(os.homedir(), suggestedName || "download"),
    ),
  });
  if (!uri) {
    return;
  }
  try {
    // Live progress: poll the local destination size every 500 ms.
    // Cheap (single `fs.stat` call) and gives accurate bytes-transferred
    // without parsing sftp's batch output (which doesn't emit progress).
    const probeLocal = async (): Promise<number> => {
      try {
        const stat = await fs.promises.stat(uri.fsPath);
        return stat.size;
      } catch {
        return 0;
      }
    };
    await withLiveTransferProgress(
      {
        title: `Downloading ${suggestedName}…`,
        totalBytes: sizeBytes,
        getBytes: probeLocal,
      },
      () =>
        runSftpBatch(inv, [
          `get ${shellQuoteRemotePath(remotePath)} ${shellQuoteRemotePath(uri.fsPath)}`,
        ]),
    );
    postInfo(`Downloaded ${suggestedName} → ${uri.fsPath}`);
    logOp("download", true, remotePath);
  } catch (err) {
    postError(err, `download of ${remotePath} failed`);
    logOp("download", false, remotePath, formatError(err));
  }
}
