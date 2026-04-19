/**
 * handleDropUpload — OS drag-drop upload entry point. The webview
 * serializes Electron-extended `File.path` values; we stat each one,
 * drop directories + unreadable paths, then hand the surviving URIs
 * to the shared `uploadUris` pipeline.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "../../../log";
import { uploadUris } from "./upload";
import type { LogOp, SshInvocation } from "../types";

export async function handleDropUpload(
  inv: SshInvocation,
  intoPath: string,
  localPaths: string[],
  postInfo: (msg: string) => void,
  postError: (err: unknown, fallback: string) => void,
  runLs: (p: string) => Promise<void>,
  logOp: LogOp,
): Promise<void> {
  log.info(
    `dropUpload: intoPath=${intoPath} received ${localPaths.length} local path(s): ` +
      JSON.stringify(localPaths),
  );
  const uris: vscode.Uri[] = [];
  const skipped: string[] = [];
  for (const p of localPaths) {
    if (typeof p !== "string" || p.trim() === "") {
      continue;
    }
    try {
      const stat = await fs.promises.stat(p);
      if (stat.isFile()) {
        uris.push(vscode.Uri.file(p));
      } else {
        skipped.push(path.basename(p) + (stat.isDirectory() ? " (dir)" : ""));
        log.info(
          `dropUpload: skipping "${p}" — ` +
            (stat.isDirectory() ? "is directory" : "not a regular file"),
        );
      }
    } catch (err) {
      skipped.push(path.basename(p) + " (unreadable)");
      // Bumped from debug to info — this is the single most common
      // failure mode for drag-from-local-pane (webview serialized a
      // tilde-prefixed path, a stale listing path, etc.) and users
      // need it visible in the Output channel without cranking the
      // log level.
      log.info(
        `dropUpload: fs.stat failed for "${p}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (uris.length === 0) {
    const detail =
      skipped.length > 0
        ? `dropped ${skipped.length} item(s) skipped: ${skipped.slice(0, 4).join(", ")}` +
          (skipped.length > 4 ? "…" : "")
        : "nothing to upload";
    log.warn(`dropUpload: aborting — ${detail}`);
    postError(new Error(detail), "drop-upload: nothing to upload");
    return;
  }
  log.info(
    `dropUpload: ${uris.length} file(s) ready to upload, ` +
      `${skipped.length} skipped`,
  );
  if (skipped.length > 0) {
    postInfo(
      `Skipping ${skipped.length} non-file item(s): ${skipped.slice(0, 3).join(", ")}` +
        (skipped.length > 3 ? "…" : ""),
    );
  }
  await uploadUris(inv, intoPath, uris, postInfo, postError, runLs, logOp);
}
