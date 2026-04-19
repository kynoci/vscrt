import * as assert from "assert";
import { CRTConfig } from "../config/vscrtConfigTypes";
import {
  configToItems,
  collectExpandablePaths,
  pruneStaleExpanded,
  COMMAND_IDS,
  WebviewItem,
} from "../treeView/webviewTreeModel";

function sampleConfig(): CRTConfig {
  return {
    folder: [
      {
        name: "Prod",
        icon: "server",
        nodes: [
          { name: "Web", endpoint: "deploy@web" },
          { name: "DB", endpoint: "postgres@db" },
        ],
        subfolder: [
          {
            name: "Monitoring",
            nodes: [{ name: "Grafana", endpoint: "admin@grafana" }],
          },
        ],
      },
      { name: "Staging", nodes: [] },
    ],
  };
}

describe("configToItems", () => {
  it("maps top-level folders to cluster items", () => {
    const items = configToItems(sampleConfig());
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].type, "cluster");
    assert.strictEqual(items[0].label, "Prod");
    assert.strictEqual(items[0].path, "Prod");
    assert.strictEqual(items[0].icon, "server");
  });

  it("maps subfolder children as subcluster type", () => {
    const items = configToItems(sampleConfig());
    const prod = items[0];
    const monitoring = prod.children!.find((c) => c.label === "Monitoring");
    assert.ok(monitoring);
    assert.strictEqual(monitoring!.type, "subcluster");
    assert.strictEqual(monitoring!.path, "Prod/Monitoring");
  });

  it("maps nodes with correct paths and descriptions", () => {
    const items = configToItems(sampleConfig());
    const prod = items[0];
    const web = prod.children!.find((c) => c.label === "Web");
    assert.ok(web);
    assert.strictEqual(web!.type, "node");
    assert.strictEqual(web!.path, "Prod/Web");
    assert.strictEqual(web!.description, "deploy@web");
  });

  it("handles empty folder array", () => {
    assert.deepStrictEqual(configToItems({ folder: [] }), []);
  });

  it("handles missing folder key", () => {
    assert.deepStrictEqual(configToItems({}), []);
  });

  it("nests subfolders before nodes in children", () => {
    const items = configToItems(sampleConfig());
    const prod = items[0];
    // subfolder "Monitoring" should come before nodes "Web" and "DB"
    assert.strictEqual(prod.children![0].type, "subcluster");
    assert.strictEqual(prod.children![1].type, "node");
  });
});

describe("collectExpandablePaths", () => {
  it("collects paths of items with children", () => {
    const items = configToItems(sampleConfig());
    const out = new Set<string>();
    collectExpandablePaths(items, out);
    assert.ok(out.has("Prod"));
    assert.ok(out.has("Prod/Monitoring"));
    // Staging has no children (empty nodes array → no children)
    assert.ok(!out.has("Staging"));
  });

  it("returns empty set for flat list with no children", () => {
    const items: WebviewItem[] = [
      { type: "node", path: "A", label: "A" },
    ];
    const out = new Set<string>();
    collectExpandablePaths(items, out);
    assert.strictEqual(out.size, 0);
  });
});

describe("pruneStaleExpanded", () => {
  it("removes paths no longer in the tree", () => {
    const items = configToItems(sampleConfig());
    const expanded = new Set(["Prod", "Prod/Monitoring", "Deleted/Folder"]);
    pruneStaleExpanded(items, expanded);
    assert.ok(expanded.has("Prod"));
    assert.ok(expanded.has("Prod/Monitoring"));
    assert.ok(!expanded.has("Deleted/Folder"));
  });
});

describe("COMMAND_IDS", () => {
  it("maps every webview command to a vsCRT.* string", () => {
    for (const [key, value] of Object.entries(COMMAND_IDS)) {
      assert.ok(
        value.startsWith("vsCRT."),
        `COMMAND_IDS.${key} should start with "vsCRT.", got "${value}"`,
      );
    }
  });

  // Regression: `openSftpBrowser` was missing from both the W2E
  // enum and COMMAND_IDS, so the "Open SFTP Browser" context-menu
  // click in the Connection view silently dropped. Pin every command
  // the webview context menu can fire, so the same class of bug
  // can't recur without a test failure.
  it("includes every command the webview ctxmenu can post", () => {
    const webviewPostable = [
      "addCluster",
      "addServer",
      "editServer",
      "duplicateNode",
      "renameCluster",
      "deleteNode",
      "deleteCluster",
      "connect",
      "connectAllInFolder",
      "testConnection",
      "changePassword",
      "setPasswordStorage",
      "changeIcon",
      "importSshConfig",
      "removeHostKey",
      "runServerCommand",
      "bulkConnect",
      "bulkTest",
      "bulkDelete",
      "openSftpBrowser",
      "loadExample",
    ];
    for (const cmd of webviewPostable) {
      assert.ok(
        cmd in COMMAND_IDS,
        `COMMAND_IDS is missing "${cmd}" — webview clicks for this action will silently no-op.`,
      );
    }
  });
});
