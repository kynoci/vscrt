import * as assert from "assert";
import {
  CURRENT_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
} from "../config/vscrtConfigSchemaVersion";
import { CRTConfig } from "../config/vscrtConfig";

type Loose = CRTConfig & Record<string, unknown>;

describe("readSchemaVersion", () => {
  it("returns 0 for a missing $schemaVersion field", () => {
    assert.strictEqual(readSchemaVersion({} as Loose), 0);
  });

  it("returns 0 for non-integer values", () => {
    assert.strictEqual(readSchemaVersion({ $schemaVersion: "1" } as Loose), 0);
    assert.strictEqual(readSchemaVersion({ $schemaVersion: 1.5 } as Loose), 0);
    assert.strictEqual(readSchemaVersion({ $schemaVersion: -1 } as Loose), 0);
  });

  it("returns the numeric value when present", () => {
    assert.strictEqual(readSchemaVersion({ $schemaVersion: 1 } as Loose), 1);
    assert.strictEqual(readSchemaVersion({ $schemaVersion: 42 } as Loose), 42);
  });
});

describe("runMigrations", () => {
  it("stamps $schemaVersion on a fresh empty config", () => {
    const cfg: Loose = {};
    const result = runMigrations(cfg);
    assert.strictEqual(result.from, 0);
    assert.strictEqual(result.to, CURRENT_SCHEMA_VERSION);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.forwardIncompatible, false);
    assert.strictEqual(cfg.$schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it("is idempotent — re-running on a current-version config is a no-op for `changed`", () => {
    const cfg: Loose = { $schemaVersion: CURRENT_SCHEMA_VERSION, folder: [] };
    const result = runMigrations(cfg);
    assert.strictEqual(result.from, CURRENT_SCHEMA_VERSION);
    assert.strictEqual(result.to, CURRENT_SCHEMA_VERSION);
    assert.strictEqual(result.changed, false);
  });

  it("migrates legacy 'clusters' → 'folder' as part of v0→v1", () => {
    const cfg: Loose = {
      clusters: [{ name: "Prod" }],
    };
    const result = runMigrations(cfg);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(cfg.clusters, undefined);
    assert.ok(Array.isArray(cfg.folder));
    assert.strictEqual((cfg.folder as { name: string }[])[0].name, "Prod");
  });

  it("signals forwardIncompatible when $schemaVersion exceeds CURRENT", () => {
    const cfg: Loose = { $schemaVersion: CURRENT_SCHEMA_VERSION + 5 };
    const result = runMigrations(cfg);
    assert.strictEqual(result.forwardIncompatible, true);
    assert.strictEqual(result.changed, false);
    // Version is left untouched so the caller can show the original
    // value in a recovery modal.
    assert.strictEqual(cfg.$schemaVersion, CURRENT_SCHEMA_VERSION + 5);
  });

  it("doesn't run v0→v1 migrations on a v1 config", () => {
    // If we mistakenly re-ran migrateLegacyKeys on a v1 file with a
    // "clusters" field (unlikely but defensive), the field would be
    // stripped. Lock in the "migrations respect `from`" invariant.
    const cfg: Loose = {
      $schemaVersion: 1,
      folder: [],
      // Hypothetical stray legacy field that a v1 file might preserve.
      clusters: "should-be-untouched",
    };
    const result = runMigrations(cfg);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(cfg.clusters, "should-be-untouched");
  });
});
