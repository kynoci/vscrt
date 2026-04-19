/**
 * vsCRT.quickConnect — palette- and keybinding-driven launcher.
 *
 * Opens a QuickPick populated with every configured node, plus a "Recent"
 * group at the top showing the last few successful connections. Selecting an
 * item fires the existing sshService.connectFromConfig path, so this module
 * owns no SSH logic of its own.
 *
 * Recents are persisted in `context.globalState` under RECENTS_KEY, capped at
 * RECENTS_MAX, and stripped of paths that no longer resolve to a node at
 * pick-time (renamed/deleted servers drop out silently).
 */

import * as vscode from "vscode";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
} from "../config/vscrtConfig";
import { findNodeByPath } from "../config/vscrtConfigPaths";
import { formatError } from "../errorUtils";
import { buildDisplayTarget } from "../remote";
import { CommandDeps } from "./types";

export const RECENTS_KEY = "vscrt.recentConnections";
export const RECENTS_MAX = 5;

export interface FlatNode {
  path: string;
  node: CRTConfigNode;
}

interface QuickConnectItem extends vscode.QuickPickItem {
  /** Undefined on separator rows. */
  nodePath?: string;
}

/** Flatten the config tree into `{ path, node }` pairs in depth-first order. */
export function flattenConfigNodes(cfg: CRTConfig | null | undefined): FlatNode[] {
  const out: FlatNode[] = [];
  if (!cfg?.folder) {
    return out;
  }
  const walk = (clusters: CRTConfigCluster[], prefix: string): void => {
    for (const c of clusters) {
      const here = prefix ? `${prefix}/${c.name}` : c.name;
      for (const n of c.nodes ?? []) {
        out.push({ path: `${here}/${n.name}`, node: n });
      }
      if (c.subfolder) {
        walk(c.subfolder, here);
      }
    }
  };
  walk(cfg.folder, "");
  return out;
}

/**
 * Read recents from globalState, coerce to string[], and drop entries that
 * don't correspond to a currently-configured node path.
 */
export function loadRecents(
  context: vscode.ExtensionContext,
  validPaths: ReadonlySet<string>,
): string[] {
  const raw = context.globalState.get<unknown>(RECENTS_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p === "string" && validPaths.has(p) && !out.includes(p)) {
      out.push(p);
      if (out.length >= RECENTS_MAX) {
        break;
      }
    }
  }
  return out;
}

/**
 * Move `nodePath` to the head of the recents list, dedupe, cap at RECENTS_MAX,
 * and persist. Called after a connection is initiated.
 */
export async function pushRecent(
  context: vscode.ExtensionContext,
  nodePath: string,
): Promise<void> {
  const raw = context.globalState.get<unknown>(RECENTS_KEY);
  const prior: string[] = Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === "string" && p !== nodePath)
    : [];
  const next = [nodePath, ...prior].slice(0, RECENTS_MAX);
  await context.globalState.update(RECENTS_KEY, next);
}

function describeEndpoint(node: CRTConfigNode): string {
  return buildDisplayTarget(node);
}

/**
 * Build the QuickPick items: a "Recent" section (if any) then a full "All
 * servers" section, each preceded by a separator so VS Code renders the group
 * heading natively.
 */
export function buildQuickConnectItems(
  flat: FlatNode[],
  recents: string[],
): QuickConnectItem[] {
  const byPath = new Map(flat.map((f) => [f.path, f] as const));
  const toItem = (f: FlatNode): QuickConnectItem => ({
    label: f.path,
    description: describeEndpoint(f.node),
    detail: f.node.extraArgs?.trim() || undefined,
    nodePath: f.path,
  });

  const items: QuickConnectItem[] = [];
  const resolvedRecents = recents
    .map((p) => byPath.get(p))
    .filter((f): f is FlatNode => f !== undefined);

  if (resolvedRecents.length > 0) {
    items.push({
      label: "Recent",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const r of resolvedRecents) {
      items.push(toItem(r));
    }
    items.push({
      label: "All servers",
      kind: vscode.QuickPickItemKind.Separator,
    });
  }
  for (const f of flat) {
    items.push(toItem(f));
  }
  return items;
}

export function registerQuickConnectCommand(
  deps: CommandDeps,
): vscode.Disposable[] {
  const { context, configManager, sshService } = deps;

  return [
    vscode.commands.registerCommand("vsCRT.quickConnect", async () => {
    const cfg = await configManager.loadConfig();
    const flat = flattenConfigNodes(cfg);
    if (flat.length === 0) {
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          "vsCRT: no servers configured yet. Add one via the Connection view or run 'vsCRT: Import from ~/.ssh/config'.",
        ),
      );
      return;
    }
    const validPaths = new Set(flat.map((f) => f.path));
    const recents = loadRecents(context, validPaths);
    const items = buildQuickConnectItems(flat, recents);

    const picked = await vscode.window.showQuickPick(items, {
      title: "vsCRT: Quick Connect",
      placeHolder: "Type to filter — Enter to connect",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked?.nodePath || !cfg) {
      return;
    }

    const node = findNodeByPath(cfg, picked.nodePath);
    if (!node) {
      vscode.window.showErrorMessage(
        `vsCRT: server "${picked.nodePath}" is no longer in the config.`,
      );
      return;
    }

    await pushRecent(context, picked.nodePath);
    sshService.connectFromConfig(node, "panel").catch((err: unknown) => {
      if (err instanceof Error && err.name === "PassphraseCancelled") {
        return; // user cancelled — not an error
      }
      vscode.window.showErrorMessage(
        `vsCRT: connection failed — ${formatError(err)}`,
      );
    });
  }),
  ];
}
