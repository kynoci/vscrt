/**
 * Commands that open SSH terminals: connect a single server, or every server
 * in a folder. Also the non-interactive "Test Connection" diagnostic probe.
 * Owns terminal-location resolution (per-node override → config file → user
 * setting → hardcoded default).
 */

import * as vscode from "vscode";
import { CRTConfig, CRTConfigNode } from "../config/vscrtConfig";
import { log } from "../log";
import { TestResult, testConnection } from "../remote";
import type { CRTTarget } from "../treeView/treeTarget";
import { isUserCancellation } from "./commandUtils";
import { pushRecent } from "./quickConnectCommand";
import { CommandDeps } from "./types";

export function registerConnectCommands(
  deps: CommandDeps,
): vscode.Disposable[] {
  const { context, configManager, secretService, sshService } = deps;

  const connectCommand = vscode.commands.registerCommand(
    "vsCRT.connect",
    async (
      treeItem: CRTTarget,
      opts?: {
        trigger?: "dblclick" | "button";
        location?: "panel" | "editor";
      },
    ) => {
      // Only works on nodes
      if (!treeItem || treeItem.item.type !== "node") {
        return;
      }
      const node = treeItem.item.config;
      const trigger = opts?.trigger ?? "button";
      const cfg = await configManager.loadConfig();
      const location = resolveTerminalLocation(
        node,
        trigger,
        opts?.location,
        cfg ?? undefined,
      );
      // Surface the trigger + resolved location so users can diagnose
      // "why did the terminal open in X" questions without us having
      // to ask for reproduction steps.
      log.info(
        `connect "${node.name}": trigger=${trigger}, override=${opts?.location ?? "—"}, node.terminalLocation=${node.terminalLocation ?? "—"}, resolved=${location}`,
      );
      sshService.connectFromConfig(node, location).catch((err: unknown) => {
        if (!isUserCancellation(err)) {
          vscode.window.showErrorMessage(
            vscode.l10n.t(
              "vsCRT: connection failed — {0}",
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
      });
      void pushRecent(context, treeItem.item.path);
    },
  );

  const connectAllInFolderCommand = vscode.commands.registerCommand(
    "vsCRT.connectAllInFolder",
    async (
      target?: CRTTarget,
      opts?: { trigger?: "dblclick" | "button" },
    ) => {
      if (
        !target ||
        (target.item.type !== "cluster" && target.item.type !== "subcluster")
      ) {
        vscode.window.showErrorMessage(
          vscode.l10n.t("vsCRT: select a folder to connect all servers."),
        );
        return;
      }
      const nodes = await configManager.getAllNodesInFolder(target.item.path);
      if (!nodes) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: could not find folder "{0}".',
            target.item.label,
          ),
        );
        return;
      }
      if (nodes.length === 0) {
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'vsCRT: folder "{0}" has no servers.',
            target.item.label,
          ),
        );
        return;
      }

      const confirmLabel = vscode.l10n.t("Connect");
      const choice = await vscode.window.showWarningMessage(
        nodes.length === 1
          ? vscode.l10n.t(
              'Connect to all {0} server in "{1}"?',
              nodes.length,
              target.item.label,
            )
          : vscode.l10n.t(
              'Connect to all {0} servers in "{1}"?',
              nodes.length,
              target.item.label,
            ),
        {
          modal: true,
          detail: vscode.l10n.t(
            "Each server opens in its own terminal. Password prompts may appear for several servers.",
          ),
        },
        confirmLabel,
      );
      if (choice !== confirmLabel) {
        return;
      }

      const trigger = opts?.trigger ?? "dblclick";
      const cfg = await configManager.loadConfig();
      for (const node of nodes) {
        const location = resolveTerminalLocation(
          node,
          trigger,
          undefined,
          cfg ?? undefined,
        );
        sshService.connectFromConfig(node, location).catch((err: unknown) => {
          if (!isUserCancellation(err)) {
            vscode.window.showErrorMessage(
              vscode.l10n.t(
                'vsCRT: connection to "{0}" failed — {1}',
                node.name,
                err instanceof Error ? err.message : String(err),
              ),
            );
          }
        });
      }
    },
  );

  const testConnectionCommand = vscode.commands.registerCommand(
    "vsCRT.testConnection",
    async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage(
          vscode.l10n.t("vsCRT: select a server to test."),
        );
        return;
      }
      const node = target.item.config;

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('vsCRT: Testing "{0}"…', node.name),
          cancellable: false,
        },
        () => testConnection(node, secretService),
      );
      announceTestResult(node.name, result);
    },
  );

  return [connectCommand, connectAllInFolderCommand, testConnectionCommand];
}

/**
 * Surface the outcome as a toast, and — when things didn't succeed —
 * offer a "Show Log" action that opens the vsCRT output channel right
 * where `sshTest.ts`'s diagnostics (full argv + stderr + classification)
 * already live. Users report Test Connection issues that the Output
 * Log would diagnose in one glance; we stop making them hunt for it.
 */
function offerShowLog(kind: "info" | "warning" | "error", message: string): void {
  const showLog = vscode.l10n.t("Show Log");
  const api =
    kind === "error"
      ? vscode.window.showErrorMessage
      : kind === "warning"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
  api(message, showLog).then((pick) => {
    if (pick === showLog) {
      void vscode.commands.executeCommand("vsCRT.showLog");
    }
  });
}

function announceTestResult(nodeName: string, result: TestResult): void {
  const secs = (result.durationMs / 1000).toFixed(1);
  switch (result.outcome) {
    case "connected":
      vscode.window.showInformationMessage(
        vscode.l10n.t('vsCRT: "{0}" connected in {1}s.', nodeName, secs),
      );
      return;
    case "auth-failed":
      offerShowLog(
        "warning",
        vscode.l10n.t(
          'vsCRT: "{0}" reachable but authentication failed — {1}',
          nodeName,
          result.message,
        ),
      );
      return;
    case "timeout":
      offerShowLog(
        "error",
        vscode.l10n.t('vsCRT: "{0}" timed out after {1}s.', nodeName, secs),
      );
      return;
    case "no-credentials":
      vscode.window.showWarningMessage(
        vscode.l10n.t('vsCRT: "{0}" — {1}', nodeName, result.message),
      );
      return;
    case "cancelled":
      // User dismissed a passphrase prompt — silent, matching the connect flow.
      return;
    default:
      offerShowLog(
        "error",
        vscode.l10n.t('vsCRT: "{0}" — {1}', nodeName, result.message),
      );
  }
}

/**
 * Resolve where the SSH terminal should open for this connect invocation.
 * Precedence (higher wins):
 *   1. Explicit `override` (rare — reserved for flows that intentionally
 *      bypass the setting, e.g. a future "Open elsewhere" command).
 *   2. Per-node `terminalLocation` field in vscrtConfig.json.
 *   3. Top-level setting in vscrtConfig.json:
 *        dblclick → "vsCRT.doubleClickTerminalLocation"
 *        button   → "vsCRT.buttonClickTerminalLocation"
 *   4. VS Code user/workspace setting of the same name (no prefix key).
 *   5. Hardcoded fallback: dblclick → panel, button → editor.
 *      Matches the package.json `default` for each setting so callers
 *      that never pass through VS Code's settings layer still get the
 *      same out-of-the-box behaviour.
 */
export function resolveTerminalLocation(
  node: CRTConfigNode,
  trigger: "dblclick" | "button",
  override?: "panel" | "editor",
  fileConfig?: CRTConfig,
): "panel" | "editor" {
  if (override === "panel" || override === "editor") {
    return override;
  }
  if (node.terminalLocation === "panel" || node.terminalLocation === "editor") {
    return node.terminalLocation;
  }

  const fileKey =
    trigger === "dblclick"
      ? "vsCRT.doubleClickTerminalLocation"
      : "vsCRT.buttonClickTerminalLocation";
  const fromFile = fileConfig?.[fileKey];
  if (fromFile === "panel" || fromFile === "editor") {
    return fromFile;
  }

  const cfg = vscode.workspace.getConfiguration("vsCRT");
  const settingKey =
    trigger === "dblclick"
      ? "doubleClickTerminalLocation"
      : "buttonClickTerminalLocation";
  const fallback: "panel" | "editor" =
    trigger === "dblclick" ? "panel" : "editor";
  const v = cfg.get<string>(settingKey);
  return v === "editor" || v === "panel" ? v : fallback;
}
