/**
 * vsCRT.runServerCommand — pick one of a node's saved `commands` and send
 * it to the server's terminal. If a terminal for the node is already open
 * it goes straight there; otherwise we spawn the SSH session first and
 * queue the snippet for a short delay so auth has time to settle.
 *
 * `commands` live on CRTConfigNode (optional array of `{name, script}`).
 * The snippet is passed to `terminal.sendText(script, true)` verbatim —
 * shell features (pipes, heredocs, quoting) work normally because the
 * remote shell interprets the string.
 */

import * as vscode from "vscode";
import {
  CRTConfigNode,
  CRTNodeCommand,
} from "../config/vscrtConfig";
import { log } from "../log";
import type { CRTTarget } from "../treeView/treeTarget";
import { CommandDeps } from "./types";

const TERMINAL_PREFIX = "vsCRT: ";
/** How long to wait after spawning a new SSH terminal before sending the snippet. */
const POST_CONNECT_DELAY_MS = 1500;

export interface QuickCommandPick extends vscode.QuickPickItem {
  command: CRTNodeCommand;
}

/**
 * Pure helper: build QuickPick items from a node's commands list. Exported
 * for testing. Filters entries where name or script is blank (schema
 * already rejects these, but unit tests may feed hand-built fixtures).
 */
export function buildCommandPicks(commands: readonly CRTNodeCommand[]): QuickCommandPick[] {
  return commands
    .filter((c) => c.name.trim() && c.script.trim())
    .map((c) => ({
      label: c.name,
      description: c.description,
      detail: c.script.split("\n")[0],
      command: c,
    }));
}

/** Find an open vsCRT terminal for a given node (by our `vsCRT: <name>` naming convention). */
export function findTerminalForNode(
  name: string,
  terminals: readonly vscode.Terminal[] = vscode.window.terminals,
): vscode.Terminal | undefined {
  const target = TERMINAL_PREFIX + name;
  return terminals.find((t) => t.name === target);
}

export function registerRunCommandCommand(
  deps: CommandDeps,
): vscode.Disposable[] {
  const { sshService } = deps;

  return [
    vscode.commands.registerCommand("vsCRT.runServerCommand", async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage(
          "vsCRT: select a server to run a saved command on.",
        );
        return;
      }
      const node: CRTConfigNode = target.item.config;
      const commands = Array.isArray(node.commands) ? node.commands : [];
      if (commands.length === 0) {
        const edit = "Edit Server…";
        const pick = await vscode.window.showInformationMessage(
          `vsCRT: "${node.name}" has no saved commands yet. Add them in the server form's "Saved commands" section.`,
          edit,
        );
        if (pick === edit) {
          void vscode.commands.executeCommand("vsCRT.editServer", target);
        }
        return;
      }

      const items = buildCommandPicks(commands);
      if (items.length === 0) {
        vscode.window.showWarningMessage(
          `vsCRT: "${node.name}" has commands in its config but every entry is blank.`,
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(items, {
        title: `vsCRT: Run Command — ${node.name}`,
        placeHolder: "Pick a saved command to send to the terminal",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) {
        return;
      }

      const existing = findTerminalForNode(node.name);
      if (existing) {
        existing.show(true);
        existing.sendText(picked.command.script, true);
        log.info(
          `runServerCommand: sent '${picked.command.name}' to existing terminal for ${node.name}.`,
        );
        return;
      }

      // No open session: kick off a connect, then send the snippet after
      // enough delay for sshpass/auth to settle. If auth fails the user
      // will see the command queued as the next keystroke when the prompt
      // returns — not ideal but reasonably recoverable.
      log.info(
        `runServerCommand: opening a new session for ${node.name} before sending '${picked.command.name}'.`,
      );
      await sshService.connectFromConfig(node, "panel");
      setTimeout(() => {
        const terminal = findTerminalForNode(node.name);
        if (terminal) {
          terminal.sendText(picked.command.script, true);
        } else {
          vscode.window.showWarningMessage(
            `vsCRT: could not find a terminal for "${node.name}" to run the command.`,
          );
        }
      }, POST_CONNECT_DELAY_MS);
    }),
  ];
}
