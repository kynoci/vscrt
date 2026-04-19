import * as assert from "assert";
import { CRTConfig } from "../config/vscrtConfigTypes";
import {
  lastSegment,
  parentPathOf,
  uniqueName,
  isDescendantPath,
  findNodeByName,
  findNodeByPath,
  findClusterByPath,
  findParent,
  extractNodeByPath,
  extractClusterByPath,
  getContainers,
  isCluster,
} from "../config/vscrtConfigPaths";

function cfg(partial: Partial<CRTConfig> = {}): CRTConfig {
  return {
    folder: [
      {
        name: "Prod",
        nodes: [
          { name: "Web", endpoint: "deploy@prod-web" },
          { name: "DB", endpoint: "postgres@prod-db" },
        ],
        subfolder: [
          {
            name: "Monitoring",
            nodes: [{ name: "Grafana", endpoint: "admin@grafana" }],
          },
        ],
      },
      { name: "Staging", nodes: [{ name: "Web", endpoint: "deploy@staging" }] },
    ],
    ...partial,
  };
}

describe("vscrtConfigPaths", () => {
  describe("lastSegment", () => {
    it("returns the part after the last /", () => {
      assert.strictEqual(lastSegment("Prod/Web"), "Web");
    });
    it("returns the whole string when no /", () => {
      assert.strictEqual(lastSegment("Prod"), "Prod");
    });
    it("handles deeply nested paths", () => {
      assert.strictEqual(lastSegment("A/B/C/D"), "D");
    });
    it("handles empty string", () => {
      assert.strictEqual(lastSegment(""), "");
    });
  });

  describe("parentPathOf", () => {
    it("returns path up to last segment", () => {
      assert.strictEqual(parentPathOf("Prod/Web"), "Prod");
    });
    it("returns null for root-level path", () => {
      assert.strictEqual(parentPathOf("Prod"), null);
    });
    it("handles deeply nested", () => {
      assert.strictEqual(parentPathOf("A/B/C"), "A/B");
    });
  });

  describe("uniqueName", () => {
    it("returns base if no collision", () => {
      assert.strictEqual(uniqueName("Web", ["DB", "App"]), "Web");
    });
    it("appends ' 2' on first collision", () => {
      assert.strictEqual(uniqueName("Web", ["Web"]), "Web 2");
    });
    it("appends ' 3' when ' 2' is also taken", () => {
      assert.strictEqual(uniqueName("Web", ["Web", "Web 2"]), "Web 3");
    });
    it("works with empty existing list", () => {
      assert.strictEqual(uniqueName("Server", []), "Server");
    });
    it("handles many collisions", () => {
      // ["X", "X 2", "X 3", ..., "X 50"]
      const taken = ["X", ...Array.from({ length: 49 }, (_, i) => `X ${i + 2}`)];
      assert.strictEqual(uniqueName("X", taken), "X 51");
    });
  });

  describe("isDescendantPath", () => {
    it("returns true for direct child", () => {
      assert.strictEqual(isDescendantPath("Prod", "Prod/Web"), true);
    });
    it("returns true for nested descendant", () => {
      assert.strictEqual(isDescendantPath("Prod", "Prod/Monitoring/Grafana"), true);
    });
    it("returns false for non-descendant", () => {
      assert.strictEqual(isDescendantPath("Prod", "Staging/Web"), false);
    });
    it("returns false for same path", () => {
      assert.strictEqual(isDescendantPath("Prod", "Prod"), false);
    });
    it("returns false for prefix that isn't a path boundary", () => {
      assert.strictEqual(isDescendantPath("Prod", "Production/Web"), false);
    });
  });

  describe("findNodeByName", () => {
    it("finds a node in a top-level folder", () => {
      const node = findNodeByName(cfg(), "Web");
      assert.strictEqual(node?.endpoint, "deploy@prod-web");
    });
    it("finds a node in a subfolder", () => {
      const node = findNodeByName(cfg(), "Grafana");
      assert.strictEqual(node?.endpoint, "admin@grafana");
    });
    it("returns undefined for missing node", () => {
      assert.strictEqual(findNodeByName(cfg(), "Nonexistent"), undefined);
    });
    it("returns undefined for empty config", () => {
      assert.strictEqual(findNodeByName({}, "Web"), undefined);
    });
  });

  describe("findClusterByPath", () => {
    it("finds a top-level folder", () => {
      const cluster = findClusterByPath(cfg(), "Prod");
      assert.strictEqual(cluster?.name, "Prod");
    });
    it("finds a nested subfolder", () => {
      const cluster = findClusterByPath(cfg(), "Prod/Monitoring");
      assert.strictEqual(cluster?.name, "Monitoring");
    });
    it("returns null for missing path", () => {
      assert.strictEqual(findClusterByPath(cfg(), "Nonexistent"), null);
    });
    it("returns null for empty config", () => {
      assert.strictEqual(findClusterByPath({}, "Prod"), null);
    });
  });

  describe("findNodeByPath", () => {
    it("finds a node by full path", () => {
      const node = findNodeByPath(cfg(), "Prod/Web");
      assert.strictEqual(node?.endpoint, "deploy@prod-web");
    });
    it("finds a nested node", () => {
      const node = findNodeByPath(cfg(), "Prod/Monitoring/Grafana");
      assert.strictEqual(node?.endpoint, "admin@grafana");
    });
    it("returns null for root-level path (nodes must be inside folders)", () => {
      assert.strictEqual(findNodeByPath(cfg(), "Web"), null);
    });
    it("returns null for missing node", () => {
      assert.strictEqual(findNodeByPath(cfg(), "Prod/Nonexistent"), null);
    });
  });

  describe("findParent", () => {
    it("returns root config for top-level folder path", () => {
      const parent = findParent(cfg(), "Prod");
      assert.ok(parent !== null);
      assert.ok(!isCluster(parent!));
    });
    it("returns cluster for node path", () => {
      const parent = findParent(cfg(), "Prod/Web");
      assert.ok(parent !== null && isCluster(parent!));
      assert.strictEqual((parent as { name: string }).name, "Prod");
    });
  });

  describe("extractNodeByPath", () => {
    it("removes and returns the node, mutating the config", () => {
      const c = cfg();
      const node = extractNodeByPath(c, "Prod/Web");
      assert.strictEqual(node?.endpoint, "deploy@prod-web");
      assert.strictEqual(c.folder![0].nodes!.length, 1);
      assert.strictEqual(c.folder![0].nodes![0].name, "DB");
    });
    it("returns null for missing node", () => {
      assert.strictEqual(extractNodeByPath(cfg(), "Prod/Missing"), null);
    });
    it("returns null for root path (no parent)", () => {
      assert.strictEqual(extractNodeByPath(cfg(), "Web"), null);
    });
  });

  describe("extractClusterByPath", () => {
    it("removes and returns a top-level cluster", () => {
      const c = cfg();
      const cluster = extractClusterByPath(c, "Staging");
      assert.strictEqual(cluster?.name, "Staging");
      assert.strictEqual(c.folder!.length, 1);
    });
    it("removes and returns a nested subfolder", () => {
      const c = cfg();
      const cluster = extractClusterByPath(c, "Prod/Monitoring");
      assert.strictEqual(cluster?.name, "Monitoring");
      assert.strictEqual(c.folder![0].subfolder!.length, 0);
    });
    it("returns null for missing cluster", () => {
      assert.strictEqual(extractClusterByPath(cfg(), "Nonexistent"), null);
    });
  });

  describe("getContainers", () => {
    it("returns cluster arrays for a folder", () => {
      const c = cfg();
      const containers = getContainers(c.folder![0]);
      assert.ok(containers.clusters === c.folder![0].subfolder);
      assert.ok(containers.nodes === c.folder![0].nodes);
    });
    it("initializes missing arrays", () => {
      const cluster = { name: "Empty" };
      const containers = getContainers(cluster);
      assert.ok(Array.isArray(containers.clusters));
      assert.ok(Array.isArray(containers.nodes));
    });
    it("returns root folder array for config", () => {
      const c = cfg();
      const containers = getContainers(c);
      assert.ok(containers.clusters === c.folder);
      assert.deepStrictEqual(containers.nodes, []);
    });
  });
});
