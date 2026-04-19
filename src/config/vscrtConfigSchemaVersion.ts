/**
 * Registry-based schema migration runner. Each version bump is an
 * immutable entry in the `MIGRATIONS` list; on load we run the subset
 * that applies to the incoming file's `$schemaVersion`. Missing version
 * = v0 (everything before we started stamping).
 *
 * Design rules:
 *   - Migrations mutate in place. The runner stamps the final version
 *     onto the config object.
 *   - Never re-order MIGRATIONS. Append only.
 *   - If a newer file is opened by an older install (forward-incompat),
 *     the runner signals `forwardIncompatible: true` so the caller can
 *     show a recovery modal instead of running old migrations on a
 *     newer shape.
 *
 * Kept in a separate file so `vscrtConfigMigrations.ts` can retire to a
 * simple "v0→v1" content-file once the surrounding bookkeeping lives
 * here.
 */

import {
  migrateLegacyKeys,
  migrateLooseNodes,
  migratePortField,
} from "./vscrtConfigMigrations";
import { CRTConfig } from "./vscrtConfigTypes";

/**
 * The current schema version. Bump when you add a new migration to
 * MIGRATIONS. Pre-versioned files (missing `$schemaVersion`) are
 * treated as version 0.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export const SCHEMA_VERSION_KEY = "$schemaVersion";

/**
 * One entry per version bump. `from` is the schema version the migration
 * upgrades FROM; the `to` is implicitly `from + 1`. `apply` mutates the
 * config and reports whether it touched anything.
 */
interface MigrationEntry {
  from: number;
  description: string;
  apply: (cfg: CRTConfig) => boolean;
}

const MIGRATIONS: readonly MigrationEntry[] = [
  {
    from: 0,
    description:
      "v0 → v1: consolidate legacy key renames, loose-node promotion, " +
      "and the deprecated `port` field into one explicit baseline.",
    apply: (cfg: CRTConfig) => {
      const renamed = migrateLegacyKeys(cfg);
      const moved = migrateLooseNodes(cfg) > 0;
      const portsFolded = migratePortField(cfg);
      return renamed || moved || portsFolded;
    },
  },
];

export interface MigrationResult {
  /** Version the file was at on disk (before migration). */
  from: number;
  /** Version the file is at now. Equals CURRENT_SCHEMA_VERSION on success. */
  to: number;
  /** True if any migration actually mutated the config. */
  changed: boolean;
  /**
   * Set when the incoming file's `$schemaVersion` exceeds the runner's
   * CURRENT_SCHEMA_VERSION — indicates the user has opened a file
   * written by a newer vsCRT install. The caller should NOT save the
   * config in this state; instead, surface a recovery modal.
   */
  forwardIncompatible: boolean;
}

/**
 * Read `$schemaVersion` from an already-parsed config. Returns 0 for
 * missing/malformed values.
 */
export function readSchemaVersion(cfg: CRTConfig): number {
  const raw = (cfg as unknown as Record<string, unknown>)[SCHEMA_VERSION_KEY];
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  return 0;
}

/**
 * Run the subset of MIGRATIONS needed to bring `cfg` up to
 * CURRENT_SCHEMA_VERSION. Stamps the new version onto the config on
 * success. Pure (no I/O) — the caller decides whether to persist.
 */
export function runMigrations(cfg: CRTConfig): MigrationResult {
  const from = readSchemaVersion(cfg);
  if (from > CURRENT_SCHEMA_VERSION) {
    return {
      from,
      to: from,
      changed: false,
      forwardIncompatible: true,
    };
  }
  let changed = false;
  for (const m of MIGRATIONS) {
    if (m.from < from) {
      continue;
    }
    if (m.apply(cfg)) {
      changed = true;
    }
  }
  const current = CURRENT_SCHEMA_VERSION;
  (cfg as unknown as Record<string, unknown>)[SCHEMA_VERSION_KEY] = current;
  if (from < current) {
    changed = true;
  }
  return {
    from,
    to: current,
    changed,
    forwardIncompatible: false,
  };
}
