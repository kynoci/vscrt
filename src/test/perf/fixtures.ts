/**
 * Deterministic fixture generators for the perf suite. Builds configs of
 * varying shapes (flat, wide, deep) so benchmarks exercise the real
 * patterns users have in production (~/.ssh/config imports are often
 * 10-500 hosts in a mostly-flat "Imported" folder; team setups can have
 * 50-200 deeply nested folders).
 */

import { CRTConfig, CRTConfigCluster, CRTConfigNode } from "../../config/vscrtConfig";

/** A flat single-folder config with `nodeCount` servers. */
export function flatConfig(nodeCount: number): CRTConfig {
  const nodes: CRTConfigNode[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    nodes.push({
      name: `host-${i.toString().padStart(4, "0")}`,
      endpoint: `user${i}@host-${i}.example:${2200 + (i % 64)}`,
    });
  }
  return {
    folder: [{ name: "Imported", nodes }],
  };
}

/** A deep, wide config mimicking a large org: environments → regions → clusters → nodes. */
export function nestedConfig(targetNodes: number): CRTConfig {
  // 4 envs × 4 regions × 5 clusters × N nodes each
  const envs = ["Prod", "Staging", "Dev", "Sandbox"];
  const regions = ["us-east", "us-west", "eu-west", "ap-south"];
  const clusters = ["api", "db", "cache", "worker", "edge"];
  const perLeaf = Math.max(1, Math.ceil(targetNodes / (envs.length * regions.length * clusters.length)));

  const folder: CRTConfigCluster[] = envs.map((envName) => {
    const envCluster: CRTConfigCluster = {
      name: envName,
      subfolder: regions.map((regionName) => {
        const region: CRTConfigCluster = {
          name: regionName,
          subfolder: clusters.map((clusterName, cIdx) => {
            const leaf: CRTConfigCluster = {
              name: clusterName,
              nodes: Array.from({ length: perLeaf }, (_v, i) => ({
                name: `${envName}-${regionName}-${clusterName}-${i}`,
                endpoint: `svc@${envName}-${regionName}-${clusterName}-${i}.internal`,
                // Every 7th node has a saved command list to exercise the
                // `commands` schema path in the walker benchmarks.
                ...(i % 7 === 0
                  ? {
                      commands: [
                        { name: "health", script: "systemctl status app" },
                      ],
                    }
                  : {}),
              })),
            };
            // Mark every Nth leaf with a codicon to diversify the shape.
            if (cIdx === 0) {
              leaf.icon = "server-process";
            }
            return leaf;
          }),
        };
        return region;
      }),
    };
    return envCluster;
  });

  return { folder };
}

/** Count the leaf nodes in a config — useful for asserting fixture sizes. */
export function countNodes(cfg: CRTConfig): number {
  let n = 0;
  const walk = (clusters: CRTConfigCluster[]): void => {
    for (const c of clusters) {
      n += c.nodes?.length ?? 0;
      if (c.subfolder) {
        walk(c.subfolder);
      }
    }
  };
  walk(cfg.folder ?? []);
  return n;
}

/** Wrap a function + count iterations, return average ms per iteration. */
export function benchmark(
  label: string,
  iterations: number,
  fn: () => void | Promise<void>,
): Promise<{ label: string; iterations: number; avgMs: number; totalMs: number }> {
  return (async () => {
    // Warm-up so JIT doesn't skew the first invocation.
    for (let i = 0; i < Math.min(3, iterations); i += 1) {
      await fn();
    }
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      await fn();
    }
    const totalMs = performance.now() - start;
    return {
      label,
      iterations,
      avgMs: totalMs / iterations,
      totalMs,
    };
  })();
}
