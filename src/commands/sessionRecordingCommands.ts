/**
 * vsCRT.showSessionRecordings — QuickPick over ~/.vscrt/sessions/*.meta.json.
 * Each pick opens the metadata file in an editor tab. Future versions
 * will also show the transcript gzip file when the pty-tee lands.
 */

import * as vscode from "vscode";
import { listSessionRecordings } from "../remote";
import { log } from "../log";

export function registerSessionRecordingCommand(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.showSessionRecordings", async () => {
      const entries = await listSessionRecordings();
      if (entries.length === 0) {
        const enable = "Open Settings";
        const pick = await vscode.window.showInformationMessage(
          "vsCRT: no session recordings yet. Enable via `vsCRT.sessionRecording` (off by default).",
          enable,
        );
        if (pick === enable) {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "vsCRT.sessionRecording",
          );
        }
        return;
      }
      const items = entries.map((e) => ({
        label: e.filename,
        description: Number.isFinite(e.timestamp)
          ? new Date(e.timestamp).toLocaleString()
          : "",
        entry: e,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: "vsCRT: Session Recordings",
        placeHolder: "Pick a session (newest first) to open its metadata file.",
        matchOnDescription: true,
      });
      if (!picked) {return;}
      try {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(picked.entry.fullPath),
        );
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        log.warn("showSessionRecordings: open failed:", err);
      }
    }),
  ];
}
