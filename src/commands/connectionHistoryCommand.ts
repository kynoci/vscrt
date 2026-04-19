/**
 * vsCRT.showConnectionHistory — open ~/.vscrt/connections.log in an
 * editor tab when logging is enabled, or route users to the setting
 * when it's off. Deliberately simple: the log is a JSONL file that VS
 * Code syntax-highlights as JSON on each line, so no extra webview is
 * needed to make it scannable.
 *
 * Instrumentation of the connect path is handled in
 * `src/remote/actions/connect.ts` and the session-telemetry module —
 * this command only surfaces the resulting file.
 */

import * as fs from "fs";
import * as vscode from "vscode";
import { parseConnectionLogMode } from "../remote";
import { vscrtConnectionLogPath } from "../fsPaths";

export function registerConnectionHistoryCommand(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.showConnectionHistory", async () => {
      const mode = parseConnectionLogMode(
        vscode.workspace
          .getConfiguration("vsCRT")
          .get<string>("connectionLogging"),
      );
      if (mode === "off") {
        const enable = "Enable in Settings";
        const pick = await vscode.window.showInformationMessage(
          "vsCRT: connection history is disabled. Enable it via the 'vsCRT.connectionLogging' setting to start recording attempts.",
          enable,
        );
        if (pick === enable) {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "vsCRT.connectionLogging",
          );
        }
        return;
      }

      const filePath = vscrtConnectionLogPath();
      if (!fs.existsSync(filePath)) {
        vscode.window.showInformationMessage(
          "vsCRT: no connections logged yet. The log will appear after your next connect attempt.",
        );
        return;
      }
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
  ];
}
