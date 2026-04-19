/**
 * View-model types and tree-builder helpers for the connection webview.
 * Pure functions — no VS Code imports. The provider in webviewTree.ts owns
 * all I/O.
 */

import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
} from "../config/vscrtConfig";

/** Flat shape sent to the webview for rendering. */
export interface WebviewItem {
  type: "cluster" | "subcluster" | "node";
  path: string;
  label: string;
  description?: string;
  icon?: string; // codicon name override; falls back to per-kind default
  children?: WebviewItem[];
  /**
   * Derived from the connection audit log. Only populated for nodes
   * when `vsCRT.connectionLogging` has recorded something. The webview
   * renders this alongside the row's description as a small badge.
   */
  badge?: {
    text: string;
    kind: "success" | "error" | "muted";
    tooltip: string;
  };
}

/** Messages the webview posts back to the extension host. */
export type W2E =
  | { type: "ready" }
  | { type: "toggle"; path: string; expanded: boolean }
  | {
      type: "invoke";
      command:
        | "addCluster"
        | "addServer"
        | "editServer"
        | "duplicateNode"
        | "renameCluster"
        | "deleteNode"
        | "deleteCluster"
        | "connect"
        | "connectAllInFolder"
        | "testConnection"
        | "changePassword"
        | "setPasswordStorage"
        | "changeIcon"
        | "importSshConfig"
        | "removeHostKey"
        | "runServerCommand"
        | "bulkConnect"
        | "bulkTest"
        | "bulkDelete"
        | "openSftpBrowser"
        | "loadExample";
      targetPath?: string;
      targetKind?: "cluster" | "subcluster" | "node";
      trigger?: "dblclick" | "button";
      location?: "panel" | "editor";
      /** For bulk commands — the set of selected node paths. */
      paths?: string[];
    }
  | {
      type: "move";
      sourcePath: string;
      sourceKind: "cluster" | "subcluster" | "node";
      targetPath?: string;
      targetKind?: "cluster" | "subcluster" | "node";
      position: "before" | "after" | "inside";
    };

/** Map of webview-command enum values to VS Code command IDs. */
export const COMMAND_IDS: Record<
  Extract<W2E, { type: "invoke" }>["command"],
  string
> = {
  addCluster: "vsCRT.addCluster",
  addServer: "vsCRT.addServer",
  editServer: "vsCRT.editServer",
  duplicateNode: "vsCRT.duplicateNode",
  renameCluster: "vsCRT.renameCluster",
  deleteNode: "vsCRT.deleteNode",
  deleteCluster: "vsCRT.deleteCluster",
  connect: "vsCRT.connect",
  connectAllInFolder: "vsCRT.connectAllInFolder",
  testConnection: "vsCRT.testConnection",
  changePassword: "vsCRT.changePassword",
  setPasswordStorage: "vsCRT.setPasswordStorage",
  changeIcon: "vsCRT.changeIcon",
  importSshConfig: "vsCRT.importSshConfig",
  removeHostKey: "vsCRT.removeHostKey",
  runServerCommand: "vsCRT.runServerCommand",
  bulkConnect: "vsCRT.bulkConnect",
  bulkTest: "vsCRT.bulkTest",
  bulkDelete: "vsCRT.bulkDelete",
  openSftpBrowser: "vsCRT.openSftpBrowser",
  loadExample: "vsCRT.loadExample",
};

export function configToItems(cfg: CRTConfig): WebviewItem[] {
  return (cfg.folder ?? []).map((c) => clusterToItem(c, "", "cluster"));
}

function clusterToItem(
  c: CRTConfigCluster,
  parentPath: string,
  type: "cluster" | "subcluster",
): WebviewItem {
  const myPath = parentPath ? `${parentPath}/${c.name}` : c.name;
  return {
    type,
    path: myPath,
    label: c.name,
    icon: c.icon,
    children: [
      ...(c.subfolder ?? []).map((sc) =>
        clusterToItem(sc, myPath, "subcluster"),
      ),
      ...(c.nodes ?? []).map((n) => nodeToItem(n, myPath)),
    ],
  };
}

function nodeToItem(n: CRTConfigNode, parentPath: string): WebviewItem {
  const myPath = parentPath ? `${parentPath}/${n.name}` : n.name;
  return {
    type: "node",
    path: myPath,
    label: n.name,
    description: n.endpoint,
    icon: n.icon,
  };
}

/** Collect every item path that has children (for default-expansion logic). */
export function collectExpandablePaths(
  items: WebviewItem[],
  out: Set<string>,
): void {
  for (const item of items) {
    if (item.children && item.children.length > 0) {
      out.add(item.path);
      collectExpandablePaths(item.children, out);
    }
  }
}

/**
 * Drop expanded-set entries whose paths no longer exist after a
 * mutation. Returns the number of paths removed — callers that
 * persist the set elsewhere can skip a disk write when this is 0.
 */
export function pruneStaleExpanded(
  items: WebviewItem[],
  set: Set<string>,
): number {
  const alive = new Set<string>();
  collectExpandablePaths(items, alive);
  let removed = 0;
  for (const p of [...set]) {
    if (!alive.has(p)) {
      set.delete(p);
      removed += 1;
    }
  }
  return removed;
}
