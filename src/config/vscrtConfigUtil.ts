/**
 * Pure tree utilities extracted from `CRTConfigService` — the service
 * class stays focused on the I/O + lifecycle orchestration, while the
 * no-side-effect walks and in-place appends live here where they're
 * easier to test and reuse.
 *
 * Everything here takes the parsed `CRTConfig` (or a cluster list)
 * and returns a derived value — never touches disk, `vscode.*`, or
 * the secret service.
 */

import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
} from "./vscrtConfigTypes";
import { findClusterByPath } from "./vscrtConfigPaths";

/**
 * Count the direct + nested nodes and subfolders inside the cluster
 * at `path`. Returns `null` if the path doesn't resolve.
 */
export function countClusterContents(
  cfg: CRTConfig,
  path: string,
): { nodes: number; subfolder: number } | null {
  const cluster = findClusterByPath(cfg, path);
  if (!cluster) {
    return null;
  }
  let nodes = 0;
  let subfolder = 0;
  const walk = (c: CRTConfigCluster): void => {
    nodes += c.nodes?.length ?? 0;
    for (const s of c.subfolder ?? []) {
      subfolder += 1;
      walk(s);
    }
  };
  walk(cluster);
  return { nodes, subfolder };
}

/** Return every folder's slash-joined path, depth-first. */
export function listAllFolderPaths(cfg: CRTConfig): string[] {
  if (!cfg.folder) {
    return [];
  }
  const out: string[] = [];
  const walk = (list: CRTConfigCluster[], prefix: string): void => {
    for (const c of list) {
      const p = prefix ? `${prefix}/${c.name}` : c.name;
      out.push(p);
      if (c.subfolder) {
        walk(c.subfolder, p);
      }
    }
  };
  walk(cfg.folder, "");
  return out;
}

/**
 * Collect every node under a folder path (direct + nested in
 * subfolders). Returns `null` if the path doesn't resolve.
 */
export function listAllNodesInFolder(
  cfg: CRTConfig,
  path: string,
): CRTConfigNode[] | null {
  const cluster = findClusterByPath(cfg, path);
  if (!cluster) {
    return null;
  }
  const out: CRTConfigNode[] = [];
  const walk = (c: CRTConfigCluster): void => {
    for (const n of c.nodes ?? []) {
      out.push(n);
    }
    for (const s of c.subfolder ?? []) {
      walk(s);
    }
  };
  walk(cluster);
  return out;
}

/**
 * In-place append of `node` into the cluster matching `targetName`
 * anywhere in the tree rooted at `clusters`. Returns `true` when the
 * target was found and mutated.
 */
export function appendNodeToCluster(
  clusters: CRTConfigCluster[],
  targetName: string,
  node: CRTConfigNode,
): boolean {
  for (const c of clusters) {
    if (c.name === targetName) {
      if (!c.nodes) {
        c.nodes = [];
      }
      c.nodes.push(node);
      return true;
    }
    if (c.subfolder && appendNodeToCluster(c.subfolder, targetName, node)) {
      return true;
    }
  }
  return false;
}

/**
 * In-place append of `childCluster` as a subfolder of the cluster
 * matching `targetName` anywhere in the tree rooted at `clusters`.
 * Returns `true` when the target was found and mutated.
 */
export function appendClusterToCluster(
  clusters: CRTConfigCluster[],
  targetName: string,
  childCluster: CRTConfigCluster,
): boolean {
  for (const c of clusters) {
    if (c.name === targetName) {
      if (!c.subfolder) {
        c.subfolder = [];
      }
      c.subfolder.push(childCluster);
      return true;
    }
    if (
      c.subfolder &&
      appendClusterToCluster(c.subfolder, targetName, childCluster)
    ) {
      return true;
    }
  }
  return false;
}
