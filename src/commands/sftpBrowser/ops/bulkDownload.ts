/**
 * handleBulkDownload — downloads N files into a user-picked dir via
 * the concurrency-limited TransferQueue (default 3 parallel). Live
 * progress aggregates local `fs.stat` across every target.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { runSftpBatch, shellQuoteRemotePath } from "../../../remote";
import { TransferQueue, summarizeTransferResults } from "../../transferQueue";
import { withLiveTransferProgress } from "../progress/withLiveTransferProgress";
import type { LogOp, SshInvocation } from "../types";

export async function handleBulkDownload(
  inv: SshInvocation,
  remotePaths: string[],
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  logOp: LogOp,
): Promise<void> {
  if (remotePaths.length === 0) {
    return;
  }
  const dirUris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Download selected files here",
  });
  if (!dirUris || dirUris.length === 0) {
    return;
  }
  const localDir = dirUris[0].fsPath;
  const localTargets: string[] = remotePaths.map((rp) =>
    path.join(localDir, rp.slice(rp.lastIndexOf("/") + 1)),
  );

  // One task per file, drained through a concurrency-limited queue.
  // sshd's default MaxSessions is 10; we cap at 3 to be well-behaved
  // and leave room for interactive sessions on the same host.
  const queue = new TransferQueue<void>({ concurrency: 3 });
  for (let i = 0; i < remotePaths.length; i += 1) {
    const rp = remotePaths[i];
    const localPath = localTargets[i];
    queue.add({
      id: `dl-${i}`,
      label: rp.slice(rp.lastIndexOf("/") + 1),
      run: async () =>
        runSftpBatch(inv, [
          `get ${shellQuoteRemotePath(rp)} ${shellQuoteRemotePath(localPath)}`,
        ]).then(() => undefined),
    });
  }

  const probeLocalAggregate = async (): Promise<number> => {
    let total = 0;
    for (const p of localTargets) {
      try {
        const stat = await fs.promises.stat(p);
        total += stat.size;
      } catch {
        // Files that haven't started downloading yet — skip.
      }
    }
    return total;
  };

  const results = await withLiveTransferProgress(
    {
      title: `Downloading ${remotePaths.length} ${remotePaths.length === 1 ? "file" : "files"}…`,
      totalBytes: 0,
      getBytes: probeLocalAggregate,
    },
    () => queue.drain(),
  );

  // Per-item audit log so partial failures are visible.
  for (const r of results) {
    const rp = remotePaths[parseInt(r.id.replace("dl-", ""), 10)] || r.label;
    if (r.outcome === "success") {
      logOp("download", true, rp);
    } else {
      logOp("download", false, rp, r.error ? formatError(r.error) : r.outcome);
    }
  }

  const summary = summarizeTransferResults(results);
  if (summary.kind === "success") {
    postInfo(`Downloaded ${results.length} files → ${localDir}`);
  } else if (summary.kind === "partial") {
    postError(new Error(summary.message), `bulk download: ${summary.message}`);
  } else if (summary.kind === "failed") {
    postError(new Error(summary.message), `bulk download failed`);
  } else {
    postInfo(summary.message);
  }
}
