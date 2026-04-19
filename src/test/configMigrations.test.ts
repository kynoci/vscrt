import * as assert from "assert";
import {
  CRTConfig,
  isDescendantPath,
  migrateLegacyKeys,
  migrateLooseNodes,
  migratePortField,
  uniqueName,
} from "../config/vscrtConfig";

describe("vscrtConfig migrations", () => {
  describe("migrateLegacyKeys", () => {
    it("renames clusters → folder at the top level", () => {
      const cfg = {
        clusters: [{ name: "Prod", nodes: [] }],
      } as unknown as CRTConfig;
      const changed = migrateLegacyKeys(cfg);
      assert.strictEqual(changed, true);
      assert.deepStrictEqual(cfg.folder, [{ name: "Prod", nodes: [] }]);
      assert.strictEqual(
        (cfg as unknown as Record<string, unknown>).clusters,
        undefined,
      );
    });

    it("renames subclusters → subfolder, recursively", () => {
      const cfg = {
        clusters: [
          {
            name: "Prod",
            subclusters: [
              {
                name: "DB",
                subclusters: [{ name: "Read Replicas", nodes: [] }],
              },
            ],
          },
        ],
      } as unknown as CRTConfig;

      migrateLegacyKeys(cfg);

      const prod = cfg.folder![0];
      assert.ok(prod.subfolder);
      const db = prod.subfolder![0];
      assert.strictEqual(db.name, "DB");
      assert.ok(db.subfolder);
      assert.strictEqual(db.subfolder![0].name, "Read Replicas");
    });

    it("returns false and leaves the config untouched when keys are already modern", () => {
      const cfg: CRTConfig = {
        folder: [{ name: "Prod", subfolder: [{ name: "DB", nodes: [] }] }],
      };
      const before = JSON.stringify(cfg);
      const changed = migrateLegacyKeys(cfg);
      assert.strictEqual(changed, false);
      assert.strictEqual(JSON.stringify(cfg), before);
    });

    it("does not overwrite an existing folder key when clusters is also present", () => {
      const cfg = {
        folder: [{ name: "Keep", nodes: [] }],
        clusters: [{ name: "Stale", nodes: [] }],
      } as unknown as CRTConfig;
      const changed = migrateLegacyKeys(cfg);
      assert.strictEqual(changed, false);
      assert.deepStrictEqual(cfg.folder, [{ name: "Keep", nodes: [] }]);
    });
  });

  describe("migratePortField", () => {
    it("folds a legacy numeric port into the endpoint string", () => {
      const cfg: CRTConfig = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "web",
                endpoint: "deploy@web",
                ...({ port: 2222 } as object),
              },
            ],
          },
        ],
      };
      const changed = migratePortField(cfg);
      assert.strictEqual(changed, true);
      const n = cfg.folder![0].nodes![0];
      assert.strictEqual(n.endpoint, "deploy@web:2222");
      assert.strictEqual(
        (n as unknown as Record<string, unknown>).port,
        undefined,
      );
    });

    it("drops port=22 without modifying the endpoint (default port)", () => {
      const cfg: CRTConfig = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "web",
                endpoint: "deploy@web",
                ...({ port: 22 } as object),
              },
            ],
          },
        ],
      };
      const changed = migratePortField(cfg);
      assert.strictEqual(changed, true);
      const n = cfg.folder![0].nodes![0];
      assert.strictEqual(n.endpoint, "deploy@web");
      assert.strictEqual(
        (n as unknown as Record<string, unknown>).port,
        undefined,
      );
    });

    it("leaves an existing :port suffix alone when the port field agrees", () => {
      const cfg: CRTConfig = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "web",
                endpoint: "deploy@web:2201",
                ...({ port: 2201 } as object),
              },
            ],
          },
        ],
      };
      migratePortField(cfg);
      assert.strictEqual(
        cfg.folder![0].nodes![0].endpoint,
        "deploy@web:2201",
      );
    });

    it("drops a non-numeric legacy port field silently", () => {
      const cfg: CRTConfig = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "web",
                endpoint: "deploy@web",
                ...({ port: "not-a-number" } as object),
              },
            ],
          },
        ],
      };
      const changed = migratePortField(cfg);
      assert.strictEqual(changed, true);
      const n = cfg.folder![0].nodes![0];
      assert.strictEqual(n.endpoint, "deploy@web");
      assert.strictEqual(
        (n as unknown as Record<string, unknown>).port,
        undefined,
      );
    });

    it("recurses into subfolders", () => {
      const cfg: CRTConfig = {
        folder: [
          {
            name: "Prod",
            subfolder: [
              {
                name: "DB",
                nodes: [
                  {
                    name: "db1",
                    endpoint: "dba@db1",
                    ...({ port: 5432 } as object),
                  },
                ],
              },
            ],
          },
        ],
      };
      migratePortField(cfg);
      assert.strictEqual(
        cfg.folder![0].subfolder![0].nodes![0].endpoint,
        "dba@db1:5432",
      );
    });

    it("returns false when no nodes carry a port field", () => {
      const cfg: CRTConfig = {
        folder: [{ name: "Prod", nodes: [{ name: "w", endpoint: "a@b" }] }],
      };
      assert.strictEqual(migratePortField(cfg), false);
    });
  });

  describe("migrateLooseNodes", () => {
    it("moves root-level nodes into a new Unfiled folder", () => {
      const cfg = {
        nodes: [
          { name: "orphan1", endpoint: "u@h1" },
          { name: "orphan2", endpoint: "u@h2" },
        ],
      } as unknown as CRTConfig;
      const moved = migrateLooseNodes(cfg);
      assert.strictEqual(moved, 2);
      assert.strictEqual(
        (cfg as unknown as Record<string, unknown>).nodes,
        undefined,
      );
      assert.ok(cfg.folder);
      const unfiled = cfg.folder!.find((f) => f.name === "Unfiled");
      assert.ok(unfiled);
      assert.strictEqual(unfiled!.nodes?.length, 2);
      assert.strictEqual(unfiled!.nodes![0].name, "orphan1");
    });

    it("appends to an existing Unfiled folder when present", () => {
      const cfg = {
        folder: [{ name: "Unfiled", nodes: [{ name: "pre", endpoint: "u@p" }] }],
        nodes: [{ name: "new", endpoint: "u@n" }],
      } as unknown as CRTConfig;
      migrateLooseNodes(cfg);
      const unfiled = cfg.folder!.find((f) => f.name === "Unfiled");
      assert.strictEqual(unfiled!.nodes?.length, 2);
      assert.deepStrictEqual(
        unfiled!.nodes!.map((n) => n.name),
        ["pre", "new"],
      );
    });

    it("returns 0 and deletes an empty nodes array without creating Unfiled", () => {
      const cfg = { nodes: [] } as unknown as CRTConfig;
      const moved = migrateLooseNodes(cfg);
      assert.strictEqual(moved, 0);
      assert.strictEqual(
        (cfg as unknown as Record<string, unknown>).nodes,
        undefined,
      );
      assert.strictEqual(cfg.folder, undefined);
    });

    it("returns 0 when there is no loose nodes array at all", () => {
      const cfg: CRTConfig = { folder: [{ name: "Prod", nodes: [] }] };
      assert.strictEqual(migrateLooseNodes(cfg), 0);
    });
  });

  describe("uniqueName", () => {
    it("returns the base name when it doesn't collide", () => {
      assert.strictEqual(uniqueName("web", ["db", "cache"]), "web");
    });

    it("appends ' 2' on first collision", () => {
      assert.strictEqual(uniqueName("web", ["web"]), "web 2");
    });

    it("skips existing numbered variants", () => {
      assert.strictEqual(
        uniqueName("web", ["web", "web 2", "web 3"]),
        "web 4",
      );
    });

    it("handles an empty existing list", () => {
      assert.strictEqual(uniqueName("web", []), "web");
    });
  });

  describe("isDescendantPath", () => {
    it("recognises direct children", () => {
      assert.strictEqual(isDescendantPath("Prod", "Prod/DB"), true);
    });

    it("recognises deeper descendants", () => {
      assert.strictEqual(
        isDescendantPath("Prod", "Prod/DB/Read Replicas"),
        true,
      );
    });

    it("rejects self and unrelated paths", () => {
      assert.strictEqual(isDescendantPath("Prod", "Prod"), false);
      assert.strictEqual(isDescendantPath("Prod", "Staging"), false);
      assert.strictEqual(isDescendantPath("Prod", "Production"), false);
    });
  });
});
