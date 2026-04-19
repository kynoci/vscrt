/**
 * vsCRT.loadExample — populate the user's config from the bundled
 * `vscrtConfigExample.json`. Wired to the "Load Example" button in
 * the Connection view's empty-state. Protects existing data with a
 * modal confirmation when the current config already has folders or
 * nodes in it.
 */

import * as vscode from "vscode";
import type { CRTConfig } from "../config/vscrtConfig";
import { formatError } from "../errorUtils";
import { log } from "../log";
import { CommandDeps } from "./types";

function countConfigItems(cfg: CRTConfig | undefined): {
  folders: number;
  nodes: number;
} {
  if (!cfg?.folder) {
    return { folders: 0, nodes: 0 };
  }
  let folders = 0;
  let nodes = 0;
  const walk = (list: NonNullable<CRTConfig["folder"]>): void => {
    for (const c of list) {
      folders += 1;
      nodes += c.nodes?.length ?? 0;
      if (c.subfolder) {
        walk(c.subfolder);
      }
    }
  };
  walk(cfg.folder);
  return { folders, nodes };
}

export function registerLoadExampleCommand(
  deps: CommandDeps,
): vscode.Disposable[] {
  const { configManager, connectionView } = deps;

  return [
    vscode.commands.registerCommand("vsCRT.loadExample", async () => {
    try {
      const current = await configManager.loadConfig();
      const counts = countConfigItems(current);
      if (counts.folders > 0 || counts.nodes > 0) {
        const proceed = await vscode.window.showWarningMessage(
          "vsCRT: loading the example will REPLACE your current servers.",
          {
            modal: true,
            detail:
              `You currently have ${counts.folders} folder(s) and ` +
              `${counts.nodes} server(s). A rolling backup is written ` +
              `before the overwrite, so you can restore via 'vsCRT: ` +
              `Restore Config from Backup…' if you change your mind.`,
          },
          "Replace with example",
        );
        if (proceed !== "Replace with example") {
          return;
        }
      }

      const bytes = await configManager.readBundledExample();
      let parsed: CRTConfig;
      try {
        parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as CRTConfig;
      } catch (err) {
        vscode.window.showErrorMessage(
          `vsCRT: bundled example is malformed — ${formatError(err)}`,
        );
        return;
      }

      await configManager.saveConfig(parsed);
      await connectionView.reload();

      const out = countConfigItems(parsed);
      vscode.window.showInformationMessage(
        `vsCRT: loaded example (${out.folders} ${out.folders === 1 ? "folder" : "folders"}, ${out.nodes} ${out.nodes === 1 ? "server" : "servers"}).`,
      );
      log.info(
        `loadExample: populated config with ${out.folders} folders + ${out.nodes} nodes.`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `vsCRT: load example failed — ${formatError(err)}`,
      );
    }
  }),
  ];
}
