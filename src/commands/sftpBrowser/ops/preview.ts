/**
 * handlePreview — read a remote file via `ssh cat`, detect binary
 * content, and either open it as a read-only text editor or offer to
 * download it instead.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { shellQuoteRemotePath } from "../../../remote";
import { guessLanguageId, looksBinary } from "../../sftpBrowserHelpers";
import { handleDownload } from "./download";
import type { LogOp, SshInvocation } from "../types";

const execFileAsync = promisify(execFile);
const MAX_PREVIEW_BYTES = 1024 * 1024; // 1 MB — anything bigger opens in SFTP terminal

export async function handlePreview(
  inv: SshInvocation,
  remotePath: string,
  size: number,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  logOp: LogOp,
): Promise<void> {
  if (size > MAX_PREVIEW_BYTES) {
    postError(
      new Error(
        `File is ${size} bytes; preview limit is ${MAX_PREVIEW_BYTES}. Download instead.`,
      ),
      "preview size limit",
    );
    logOp("preview", false, remotePath, "exceeds preview size limit");
    return;
  }
  try {
    const { stdout } = await execFileAsync(
      inv.passwordArgs.length ? inv.command : inv.sshCommand,
      inv.passwordArgs.length
        ? [
            ...inv.passwordArgs,
            inv.sshCommand,
            ...inv.sshArgs,
            inv.target,
            `cat ${shellQuoteRemotePath(remotePath)}`,
          ]
        : [
            ...inv.sshArgs,
            inv.target,
            `cat ${shellQuoteRemotePath(remotePath)}`,
          ],
      {
        timeout: 15_000,
        encoding: "buffer",
        maxBuffer: MAX_PREVIEW_BYTES + 1024,
      },
    );
    const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));

    // H1: binary detection — offer download instead when the payload
    // isn't plausibly a text file.
    const sample = new Uint8Array(buf.subarray(0, Math.min(buf.length, 4096)));
    if (looksBinary(sample)) {
      const pick = await vscode.window.showWarningMessage(
        `vsCRT: "${remotePath.slice(remotePath.lastIndexOf("/") + 1)}" looks like binary content.`,
        { modal: true, detail: "Download it instead of previewing?" },
        "Download…",
      );
      if (pick === "Download…") {
        await handleDownload(
          inv,
          remotePath,
          remotePath.slice(remotePath.lastIndexOf("/") + 1),
          // No size known at this point — we only ruled out text
          // content, didn't stat the entry. Live-progress degrades to
          // "bytes transferred so far" without a percent.
          0,
          postInfo,
          postError,
          logOp,
        );
      }
      logOp("preview", false, remotePath, "binary content refused");
      return;
    }

    const content = buf.toString("utf8");
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: guessLanguageId(remotePath),
    });
    await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
    postInfo(`Preview (read-only): ${remotePath}`);
    logOp("preview", true, remotePath);
  } catch (err) {
    postError(err, `preview of ${remotePath} failed`);
    logOp("preview", false, remotePath, formatError(err));
  }
}
