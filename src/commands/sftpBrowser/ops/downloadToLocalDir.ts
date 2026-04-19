/**
 * handleDownloadToLocalDir — drag-a-file-from-remote-to-local handler.
 *
 * Differs from `handleBulkDownload` in one meaningful way: the local
 * destination directory is supplied by the webview (the local pane's
 * current path) rather than prompted via `showOpenDialog`. That makes
 * the UX feel like an OS file-manager drag instead of a button press.
 *
 * Collision handling: we `fs.stat` each target up-front and, if any
 * already exist, pop one `showWarningMessage` with Overwrite / Skip /
 * Cancel. No per-file prompts — that's modal-fatigue territory for
 * multi-file drags.
 *
 * After transfer, re-lists the local pane so the new files are
 * visible without a manual refresh.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { formatError } from "../../../errorUtils";
import { withLiveTransferProgress } from "../progress/withLiveTransferProgress";
import { runSshDownloadToFile } from "../../../remote";
import { handleLocalList } from "./localList";
import type { E2W, LogOp, SshInvocation } from "../types";

/** Tilde-expand the local dir — the webview may send "~" if the user
 *  hasn't navigated away from the initial pane location. */
function expandLocalDir(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export async function handleDownloadToLocalDir(
  inv: SshInvocation,
  remotePaths: string[],
  intoLocalPath: string,
  post: (msg: E2W) => void,
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  logOp: LogOp,
): Promise<void> {
  if (remotePaths.length === 0) {
    return;
  }
  const localDir = expandLocalDir(intoLocalPath);

  // Sanity-check the destination dir before the downloads start —
  // catching a typo here is much cheaper than having sftp fail per-file.
  try {
    const st = await fs.promises.stat(localDir);
    if (!st.isDirectory()) {
      postError(
        new Error(`${localDir} is not a directory`),
        `drop destination is not a directory`,
      );
      return;
    }
  } catch (err) {
    postError(err, `drop destination ${localDir} not accessible`);
    return;
  }

  // Build (remote, local) pairs and detect existing-file collisions.
  const pairs = remotePaths.map((rp) => ({
    remote: rp,
    local: path.join(localDir, rp.slice(rp.lastIndexOf("/") + 1)),
  }));
  const existing: typeof pairs = [];
  for (const p of pairs) {
    try {
      await fs.promises.access(p.local, fs.constants.F_OK);
      existing.push(p);
    } catch {
      // Not-exists — good, no collision.
    }
  }

  let toTransfer = pairs;
  if (existing.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      existing.length === 1
        ? `${path.basename(existing[0].local)} already exists in ${localDir}.`
        : `${existing.length} files already exist in ${localDir}.`,
      { modal: true },
      "Overwrite",
      "Skip existing",
    );
    if (!choice) {
      return; // User cancelled.
    }
    if (choice === "Skip existing") {
      const existingSet = new Set(existing.map((e) => e.local));
      toTransfer = pairs.filter((p) => !existingSet.has(p.local));
      if (toTransfer.length === 0) {
        postInfo("All target files already exist — nothing to do.");
        return;
      }
    }
    // Overwrite: sftp `get` clobbers by default, so no pre-delete needed.
  }

  // Sequential `ssh cat > local` per file, NOT `sftp get`.
  //
  // Why: `sftp -b -` spawns ssh internally via pipes (not a PTY).
  // sshpass can only catch password prompts on a PTY, so sftp's
  // password-auto path fails with "Permission denied (publickey,
  // password)" while plain `ssh <cmd>` works (direct PTY child of
  // sshpass). See `runSshDownloadToFile.ts` for the full rationale.
  //
  // Sequential (not parallel) because launching N concurrent sshpass
  // processes sharing one password tempfile has historically caused
  // flaky "Connection closed" failures. One session at a time keeps
  // the auth deterministic for the ~1-5 files a typical drag carries.
  const probeLocalAggregate = async (): Promise<number> => {
    let total = 0;
    for (const { local } of toTransfer) {
      try {
        const stat = await fs.promises.stat(local);
        total += stat.size;
      } catch {
        // Not started yet.
      }
    }
    return total;
  };

  let successCount = 0;
  /** @type {{ remote: string; error: unknown }[]} */
  const failures: { remote: string; error: unknown }[] = [];

  try {
    await withLiveTransferProgress(
      {
        title: `Downloading ${toTransfer.length} ${toTransfer.length === 1 ? "file" : "files"} to ${path.basename(localDir) || localDir}…`,
        totalBytes: 0,
        getBytes: probeLocalAggregate,
      },
      async () => {
        for (const { remote, local } of toTransfer) {
          try {
            await runSshDownloadToFile(inv, remote, local);
            logOp("download", true, remote);
            successCount += 1;
          } catch (err) {
            logOp("download", false, remote, formatError(err));
            failures.push({ remote, error: err });
          }
        }
      },
    );
  } catch (err) {
    // withLiveTransferProgress itself failed — unusual, surface it.
    postError(err, `drag download failed`);
    await handleLocalList(intoLocalPath, post);
    return;
  }

  if (failures.length === 0) {
    postInfo(
      `Downloaded ${successCount} ${successCount === 1 ? "file" : "files"} → ${localDir}`,
    );
  } else if (successCount === 0) {
    postError(
      new Error(
        `${failures.length} / ${toTransfer.length} failed — ${formatError(failures[0].error)}`,
      ),
      `drag download failed`,
    );
  } else {
    postError(
      new Error(
        `${successCount} / ${toTransfer.length} succeeded; ${failures.length} failed — ${formatError(failures[0].error)}`,
      ),
      `drag download partial`,
    );
  }

  // Refresh the local pane so the user sees any files that did land
  // before a failure (sftp batch writes files in order).
  await handleLocalList(intoLocalPath, post);
}
