/**
 * Schema migrations applied whenever vscrtConfig.json is loaded. Each function
 * mutates the config in place and reports whether it changed anything so the
 * caller knows when to persist the updated file.
 */

import { SECRET_PREFIX } from "./vscrtSecret";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
} from "./vscrtConfigTypes";

/**
 * One-shot rename of legacy JSON keys: { "clusters": [...] } → { "folder": [...] }
 * and nested "subclusters" → "subfolder". Mutates the config in place.
 * Returns true if anything was renamed (caller should persist).
 */
export function migrateLegacyKeys(config: CRTConfig): boolean {
  const raw = config as unknown as Record<string, unknown>;
  let changed = false;

  if (Array.isArray(raw.clusters) && !Array.isArray(raw.folder)) {
    raw.folder = raw.clusters;
    delete raw.clusters;
    changed = true;
  }

  const walk = (arr: unknown): void => {
    if (!Array.isArray(arr)) {
      return;
    }
    for (const item of arr) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const node = item as Record<string, unknown>;
      if (Array.isArray(node.subclusters) && !Array.isArray(node.subfolder)) {
        node.subfolder = node.subclusters;
        delete node.subclusters;
        changed = true;
      }
      if (Array.isArray(node.subfolder)) {
        walk(node.subfolder);
      }
    }
  };
  walk(raw.folder);
  return changed;
}

/**
 * Older configs stored the SSH port in a separate `port` field. The schema
 * now folds the port into the endpoint string (e.g. "user@host:2201"). This
 * migration merges any legacy `port` into `endpoint` and drops the field.
 * Mutates the config in place; returns the count of nodes whose endpoint
 * string actually changed.
 */
export function migratePortField(config: CRTConfig): boolean {
  let changed = false;
  const hasPortSuffix = /:\d+$/;
  const walkNodes = (nodes: CRTConfigNode[]): void => {
    for (const n of nodes) {
      const raw = n as unknown as Record<string, unknown>;
      const p = raw.port;
      if (typeof p === "number") {
        const ep = typeof n.endpoint === "string" ? n.endpoint.trim() : "";
        if (ep && p !== 22 && !hasPortSuffix.test(ep)) {
          n.endpoint = `${ep}:${p}`;
        }
        delete raw.port;
        changed = true;
      } else if (p !== undefined) {
        delete raw.port;
        changed = true;
      }
    }
  };
  const walkClusters = (cs: CRTConfigCluster[]): void => {
    for (const c of cs) {
      if (c.nodes) {
        walkNodes(c.nodes);
      }
      if (c.subfolder) {
        walkClusters(c.subfolder);
      }
    }
  };
  if (config.folder) {
    walkClusters(config.folder);
  }
  return changed;
}

/**
 * Loose servers at the config root are no longer supported. If any are found
 * (e.g. from an older schema), move them into an "Unfiled" folder so no user
 * data is lost. Mutates the config in place; returns the count migrated.
 */
export function migrateLooseNodes(config: CRTConfig): number {
  const raw = config as unknown as Record<string, unknown>;
  const loose = raw.nodes;
  if (!Array.isArray(loose)) {
    return 0;
  }
  if (loose.length === 0) {
    delete raw.nodes;
    return 0;
  }
  config.folder = config.folder ?? [];
  let unfiled = config.folder.find((f) => f.name === "Unfiled");
  if (!unfiled) {
    unfiled = { name: "Unfiled", nodes: [], subfolder: [] };
    config.folder.push(unfiled);
  }
  unfiled.nodes = unfiled.nodes ?? [];
  unfiled.nodes.push(...(loose as CRTConfigNode[]));
  delete raw.nodes;
  return loose.length;
}

/** Gather every @secret:<uuid> reference in the config (depth-first). */
export function collectRefs(config: CRTConfig): string[] {
  const refs: string[] = [];
  const walkNodes = (nodes: CRTConfigNode[]): void => {
    for (const n of nodes) {
      if (n.password && n.password.startsWith(SECRET_PREFIX)) {
        refs.push(n.password);
      }
    }
  };
  const walkClusters = (clusters: CRTConfigCluster[]): void => {
    for (const c of clusters) {
      if (c.nodes) {
        walkNodes(c.nodes);
      }
      if (c.subfolder) {
        walkClusters(c.subfolder);
      }
    }
  };
  if (config.folder) {
    walkClusters(config.folder);
  }
  return refs;
}
