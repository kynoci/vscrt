/**
 * Bulk tree operations — connect N, test N, move N, delete N. Fired by
 * the webview when the user has multiple rows selected and picks a
 * bulk action from the right-click menu.
 *
 * These handlers receive a plain `string[]` of node paths (not CRTTarget),
 * since the webview doesn't materialise per-node config shapes for
 * non-focused rows.
 */

import * as vscode from "vscode";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
} from "../config/vscrtConfig";
import { findNodeByPath } from "../config/vscrtConfigPaths";
import { testConnection } from "../remote";
import { log } from "../log";
import type { CommandDeps } from "./types";

interface BulkPayload {
  paths?: unknown;
}

function normalisePaths(arg: unknown): string[] {
  const src = (arg as BulkPayload | null)?.paths;
  if (!Array.isArray(src)) {
    return [];
  }
  return src.filter((p): p is string => typeof p === "string" && p.length > 0);
}

export function registerBulkCommands(deps: CommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.bulkConnect", async (arg: unknown) => {
      const paths = normalisePaths(arg);
      await runBulkConnect(paths, deps);
    }),
    vscode.commands.registerCommand("vsCRT.bulkTest", async (arg: unknown) => {
      const paths = normalisePaths(arg);
      await runBulkTest(paths, deps);
    }),
    vscode.commands.registerCommand("vsCRT.bulkDelete", async (arg: unknown) => {
      const paths = normalisePaths(arg);
      await runBulkDelete(paths, deps);
    }),
  ];
}

async function resolveNodes(
  paths: readonly string[],
  deps: CommandDeps,
): Promise<Array<{ path: string; node: CRTConfigNode }>> {
  const cfg = await deps.configManager.loadConfig();
  if (!cfg) {
    return [];
  }
  const out: Array<{ path: string; node: CRTConfigNode }> = [];
  for (const p of paths) {
    const node = findNodeByPath(cfg, p);
    if (node) {
      out.push({ path: p, node });
    }
  }
  return out;
}

async function runBulkConnect(
  paths: readonly string[],
  deps: CommandDeps,
): Promise<void> {
  if (paths.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "vsCRT: bulk connect requires at least one selected server.",
      ),
    );
    return;
  }
  const resolved = await resolveNodes(paths, deps);
  if (resolved.length === 0) {
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "vsCRT: none of the selected rows resolved to configured servers.",
      ),
    );
    return;
  }
  const proceed = await vscode.window.showWarningMessage(
    `Connect to ${resolved.length} ${resolved.length === 1 ? "server" : "servers"}?`,
    {
      modal: true,
      detail:
        "Each opens in its own terminal. Password prompts may appear for several servers in quick succession.",
    },
    "Connect",
  );
  if (proceed !== "Connect") {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `vsCRT: Connecting ${resolved.length} ${resolved.length === 1 ? "server" : "servers"}…`,
      cancellable: false,
    },
    async (progress) => {
      let i = 0;
      for (const entry of resolved) {
        i += 1;
        progress.report({
          message: `${i} of ${resolved.length}: ${entry.path}`,
          increment: 100 / resolved.length,
        });
        try {
          await deps.sshService.connectFromConfig(entry.node, "panel");
        } catch (err) {
          log.error(`bulkConnect: "${entry.path}" failed:`, err);
        }
      }
    },
  );
}

async function runBulkTest(
  paths: readonly string[],
  deps: CommandDeps,
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  const resolved = await resolveNodes(paths, deps);
  if (resolved.length === 0) {
    return;
  }
  const results = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `vsCRT: Testing ${resolved.length} ${resolved.length === 1 ? "server" : "servers"}…`,
      cancellable: false,
    },
    async (progress) => {
      const out: Array<{ path: string; outcome: string }> = [];
      let i = 0;
      for (const entry of resolved) {
        i += 1;
        progress.report({
          message: `${i} of ${resolved.length}: ${entry.path}`,
          increment: 100 / resolved.length,
        });
        const res = await testConnection(entry.node, deps.secretService);
        out.push({ path: entry.path, outcome: res.outcome });
      }
      return out;
    },
  );

  const summary = buildBulkTestSummary(results);
  log.info(`bulkTest: ${summary.detail.replace(/\n/g, "; ")}`);
  if (summary.anyFailed) {
    vscode.window.showWarningMessage(summary.message, "Show Output Log")
      .then((pick) => {
        if (pick === "Show Output Log") {
          log.show();
        }
      });
  } else {
    vscode.window.showInformationMessage(summary.message);
  }
}

/** Pure helper — aggregate N probe results into a toast-ready summary. */
export function buildBulkTestSummary(
  results: ReadonlyArray<{ path: string; outcome: string }>,
): { message: string; detail: string; anyFailed: boolean } {
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  }
  const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const summaryParts = ordered.map(
    ([outcome, n]) => `${n} ${outcome}`,
  );
  const anyFailed =
    (counts["auth-failed"] ?? 0) +
      (counts["timeout"] ?? 0) +
      (counts["error"] ?? 0) >
    0;
  return {
    message: `vsCRT: tested ${results.length} — ${summaryParts.join(", ")}.`,
    detail: results
      .map((r) => `${r.path}: ${r.outcome}`)
      .join("\n"),
    anyFailed,
  };
}

async function runBulkDelete(
  paths: readonly string[],
  deps: CommandDeps,
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  const resolved = await resolveNodes(paths, deps);
  if (resolved.length === 0) {
    return;
  }
  const sample = resolved.slice(0, 5).map((r) => `• ${r.path}`).join("\n");
  const more =
    resolved.length > 5 ? `\n… and ${resolved.length - 5} more` : "";
  const proceed = await vscode.window.showWarningMessage(
    `Delete ${resolved.length} ${resolved.length === 1 ? "server" : "servers"}?`,
    {
      modal: true,
      detail:
        `This will remove the following from your config:\n${sample}${more}\n\nStored passwords go with them (config backup is written first).`,
    },
    "Delete",
  );
  if (proceed !== "Delete") {
    return;
  }

  const cfg = await deps.configManager.loadConfig();
  if (!cfg) {
    return;
  }
  let removed = 0;
  // Sort deepest-first so splices don't shift ancestors.
  const byDepth = [...resolved]
    .map((r) => r.path)
    .sort((a, b) => b.split("/").length - a.split("/").length);
  for (const p of byDepth) {
    if (removeNodeFromConfig(cfg, p)) {
      removed += 1;
    }
  }
  await deps.configManager.saveConfig(cfg);
  await deps.connectionView.reload();
  vscode.window.showInformationMessage(
    `vsCRT: deleted ${removed} ${removed === 1 ? "server" : "servers"}.`,
  );
}

/** Pure mutator: remove the node at `path` from `cfg`. Returns true on hit. */
function removeNodeFromConfig(cfg: CRTConfig, nodePath: string): boolean {
  const segments = nodePath.split("/");
  if (segments.length < 2 || !cfg.folder) {
    return false;
  }
  const nodeName = segments[segments.length - 1];
  const folderPath = segments.slice(0, -1);
  let list: CRTConfigCluster[] | undefined = cfg.folder;
  let cluster: CRTConfigCluster | undefined;
  for (const seg of folderPath) {
    if (!list) {return false;}
    cluster = list.find((c) => c.name === seg);
    if (!cluster) {return false;}
    list = cluster.subfolder;
  }
  if (!cluster?.nodes) {return false;}
  const idx = cluster.nodes.findIndex((n) => n.name === nodeName);
  if (idx < 0) {return false;}
  cluster.nodes.splice(idx, 1);
  return true;
}
