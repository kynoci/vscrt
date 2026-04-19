/**
 * Path-based helpers for navigating and mutating the CRTConfig tree. Paths
 * use "/" as a separator, e.g. "Production/Database/Prod DB". These functions
 * are all pure (no I/O) and are shared by CRTConfigService's CRUD methods.
 */

import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
} from "./vscrtConfigTypes";

export function lastSegment(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.substring(i + 1);
}

export function parentPathOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i < 0 ? null : path.substring(0, i);
}

/**
 * Return `base` if it doesn't collide with `existing`; otherwise append
 * " 2", " 3", … until unique.
 */
export function uniqueName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) {
    return base;
  }
  for (let i = 2; ; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export function isDescendantPath(ancestor: string, candidate: string): boolean {
  return candidate.startsWith(ancestor + "/");
}

/** Find a node anywhere in the tree by exact name (depth-first). */
export function findNodeByName(
  config: CRTConfig,
  name: string,
): CRTConfigNode | undefined {
  const walkNodes = (nodes: CRTConfigNode[]): CRTConfigNode | undefined =>
    nodes.find((n) => n.name === name);
  const walkClusters = (
    clusters: CRTConfigCluster[],
  ): CRTConfigNode | undefined => {
    for (const c of clusters) {
      if (c.nodes) {
        const hit = walkNodes(c.nodes);
        if (hit) {
          return hit;
        }
      }
      if (c.subfolder) {
        const hit = walkClusters(c.subfolder);
        if (hit) {
          return hit;
        }
      }
    }
    return undefined;
  };
  if (config.folder) {
    const hit = walkClusters(config.folder);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

export function findClusterByPath(
  cfg: CRTConfig,
  path: string,
): CRTConfigCluster | null {
  const segments = path.split("/");
  let list: CRTConfigCluster[] | undefined = cfg.folder;
  let found: CRTConfigCluster | null = null;
  for (const seg of segments) {
    if (!list) {
      return null;
    }
    found = list.find((c) => c.name === seg) ?? null;
    if (!found) {
      return null;
    }
    list = found.subfolder;
  }
  return found;
}

export function findNodeByPath(
  cfg: CRTConfig,
  path: string,
): CRTConfigNode | null {
  const name = lastSegment(path);
  const parentP = parentPathOf(path);
  if (parentP === null) {
    return null;
  }
  const parent = findClusterByPath(cfg, parentP);
  return parent?.nodes?.find((n) => n.name === name) ?? null;
}

export function findParent(
  cfg: CRTConfig,
  path: string,
): CRTConfig | CRTConfigCluster | null {
  const parentP = parentPathOf(path);
  if (parentP === null) {
    return cfg;
  }
  return findClusterByPath(cfg, parentP);
}

export function isCluster(
  parent: CRTConfig | CRTConfigCluster,
): parent is CRTConfigCluster {
  return (parent as CRTConfigCluster).name !== undefined;
}

/**
 * Returns the clusters and nodes arrays of a parent container, lazily
 * initializing either if missing. Works for both the root config and a
 * CRTConfigCluster. Root has no `nodes` container — servers must live inside
 * a folder — so an empty array is returned in that slot.
 */
export function getContainers(parent: CRTConfig | CRTConfigCluster): {
  clusters: CRTConfigCluster[];
  nodes: CRTConfigNode[];
} {
  if (isCluster(parent)) {
    parent.subfolder = parent.subfolder ?? [];
    parent.nodes = parent.nodes ?? [];
    return { clusters: parent.subfolder, nodes: parent.nodes };
  }
  parent.folder = parent.folder ?? [];
  return { clusters: parent.folder, nodes: [] };
}

/** Remove (splice) the node at `path` from its parent's `nodes` array. */
export function extractNodeByPath(
  cfg: CRTConfig,
  path: string,
): CRTConfigNode | null {
  const name = lastSegment(path);
  const parentP = parentPathOf(path);
  if (parentP === null) {
    return null;
  }
  const parent = findClusterByPath(cfg, parentP);
  if (!parent || !parent.nodes) {
    return null;
  }
  const idx = parent.nodes.findIndex((n) => n.name === name);
  if (idx < 0) {
    return null;
  }
  return parent.nodes.splice(idx, 1)[0];
}

/** Remove (splice) the cluster at `path` from its parent container. */
export function extractClusterByPath(
  cfg: CRTConfig,
  path: string,
): CRTConfigCluster | null {
  const name = lastSegment(path);
  const parentP = parentPathOf(path);

  if (parentP === null) {
    const arr = cfg.folder;
    if (!arr) {
      return null;
    }
    const idx = arr.findIndex((c) => c.name === name);
    if (idx < 0) {
      return null;
    }
    return arr.splice(idx, 1)[0];
  }

  const parent = findClusterByPath(cfg, parentP);
  if (!parent || !parent.subfolder) {
    return null;
  }
  const idx = parent.subfolder.findIndex((c) => c.name === name);
  if (idx < 0) {
    return null;
  }
  return parent.subfolder.splice(idx, 1)[0];
}
