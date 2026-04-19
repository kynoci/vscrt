/**
 * vsCRT terminal-profile provider.
 *
 * Registers a VS Code `TerminalProfileProvider` so the native terminal
 * dropdown (`+ ▾` in the terminal pane) lists a "vsCRT: SSH Server"
 * entry. Selecting it pops a QuickPick of configured servers and routes
 * through the existing `vsCRT.connect` pipeline — same auth / fingerprint
 * handling as the Connection view, no duplicate code.
 *
 * The provider intentionally returns `undefined` after delegating: the
 * connect command opens its own terminal, so we don't want VS Code to
 * open an empty second one.
 */
import * as vscode from "vscode";
import { findNodeByPath } from "./config/vscrtConfigPaths";
import { flattenConfigNodes } from "./commands/quickConnectCommand";
import { resolveEndpoint } from "./remote";
import type { CommandDeps } from "./commands/types";

export const TERMINAL_PROFILE_ID = "vsCRT.terminalProfile";

/** Shape of the items the provider shows in the server picker. */
export interface TerminalProfilePickItem extends vscode.QuickPickItem {
  nodePath: string;
}

/**
 * Build the QuickPick items. Exported for the unit suite so we can assert
 * shape without a live VS Code host.
 */
export function buildTerminalProfilePickItems(
  flat: ReturnType<typeof flattenConfigNodes>,
): TerminalProfilePickItem[] {
  return flat.map((f) => {
    const { target, port } = resolveEndpoint(f.node);
    return {
      label: f.path,
      description: port === 22 ? target : `${target}:${port}`,
      nodePath: f.path,
    };
  });
}

export function registerTerminalProfileProvider(
  deps: Pick<CommandDeps, "configManager">,
): vscode.Disposable {
  return vscode.window.registerTerminalProfileProvider(TERMINAL_PROFILE_ID, {
    provideTerminalProfile: async (): Promise<vscode.TerminalProfile | undefined> => {
      const cfg = await deps.configManager.loadConfig();
      const flat = flattenConfigNodes(cfg);
      if (flat.length === 0) {
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            "vsCRT: no servers configured yet. Add one via the Connection view or run 'vsCRT: Import from ~/.ssh/config'.",
          ),
        );
        return undefined;
      }
      const items = buildTerminalProfilePickItems(flat);
      const picked = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("vsCRT: Pick a server to connect"),
        placeHolder: vscode.l10n.t("Type to filter — Enter to connect"),
        matchOnDescription: true,
      });
      if (!picked || !cfg) {
        return undefined;
      }
      const node = findNodeByPath(cfg, picked.nodePath);
      if (!node) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: server "{0}" is no longer in the config.',
            picked.nodePath,
          ),
        );
        return undefined;
      }
      // Delegate to the existing connect command. It opens its own terminal
      // via sshService.connectFromConfig → `panel` location. Returning
      // undefined here means VS Code does not open an additional terminal.
      await vscode.commands.executeCommand("vsCRT.connect", {
        item: {
          type: "node",
          path: picked.nodePath,
          label: node.name,
          config: node,
        },
      });
      return undefined;
    },
  });
}
