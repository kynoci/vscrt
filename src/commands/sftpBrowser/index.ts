/**
 * SFTP Browser module entry point.
 *
 * Thin shell: VS Code command registration + error envelope. All
 * lifecycle lives in `launchBrowser.ts`; all handlers in `ops/*.ts`;
 * ssh / sftp transport lives in the headless remote core
 * (`src/remote/core/session.ts` + `sessionRunners.ts`) and is reached
 * via the `../../remote` barrel.
 */
import * as vscode from "vscode";
import { PassphraseCancelled } from "../../config/vscrtPassphrase";
import { formatError } from "../../errorUtils";
import { log } from "../../log";
import type { CRTTarget } from "../../treeView/treeTarget";
import type { CommandDeps } from "../types";
import { launchBrowser } from "./launchBrowser";

export function registerSftpBrowserCommand(
  deps: CommandDeps,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.openSftpBrowser", async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "vsCRT: select a server to open the SFTP browser on.",
          ),
        );
        return;
      }
      try {
        await launchBrowser(target.item.config, deps);
      } catch (err) {
        if (err instanceof PassphraseCancelled) {
          return;
        }
        log.error("openSftpBrowser:", err);
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "vsCRT: could not open SFTP browser: {0}",
            formatError(err),
          ),
        );
      }
    }),
  ];
}

