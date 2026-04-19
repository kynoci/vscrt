/**
 * Palette-discoverable entry point for the SFTP Browser:
 *
 *   - `vsCRT.openSftpBrowserPick` → QuickPick of servers → `vsCRT.openSftpBrowser`
 *
 * The menu-only command `vsCRT.openSftpBrowser` already exists (hidden
 * from the palette with `when: false`); this wrapper adds a way to
 * reach it without clicking through the tree. Useful for keybinding
 * targets too.
 */

import * as vscode from "vscode";
import { findNodeByPath } from "../config/vscrtConfigPaths";
import { flattenConfigNodes } from "./quickConnectCommand";
import { resolveEndpoint } from "../remote";
import type { CommandDeps } from "./types";

async function pickServerAndInvoke(
  deps: CommandDeps,
  invokeCommandId: string,
  title: string,
): Promise<void> {
  const cfg = await deps.configManager.loadConfig();
  const flat = flattenConfigNodes(cfg);
  if (flat.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "vsCRT: no servers configured yet. Add one via the Connection view first.",
      ),
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    flat.map((f) => {
      const { target, port } = resolveEndpoint(f.node);
      return {
        label: f.path,
        description: port === 22 ? target : `${target}:${port}`,
        nodePath: f.path,
      };
    }),
    { title, placeHolder: "Type to filter — Enter to select" },
  );
  if (!picked || !cfg) {
    return;
  }
  const node = findNodeByPath(cfg, picked.nodePath);
  if (!node) {
    vscode.window.showErrorMessage(
      `vsCRT: server "${picked.nodePath}" is no longer in the config.`,
    );
    return;
  }
  await vscode.commands.executeCommand(invokeCommandId, {
    item: {
      type: "node",
      path: picked.nodePath,
      label: node.name,
      config: node,
    },
  });
}

export function registerSftpPickCommands(
  deps: CommandDeps,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.openSftpBrowserPick", () =>
      pickServerAndInvoke(
        deps,
        "vsCRT.openSftpBrowser",
        "vsCRT: Open SFTP Browser — pick a server",
      ),
    ),
  ];
}
