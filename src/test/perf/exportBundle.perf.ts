/**
 * Perf budget for the export/import walker — a JSON deep-clone per call.
 * Ships on every `vsCRT.exportProfile` invocation before the Argon2id
 * re-encryption round. The deep-clone step must stay O(n) in node count.
 *
 * Run with `npm run test:perf`.
 */

import * as assert from "assert";
import { mapNodePasswords } from "../../config/vscrtExportBundle";
import { benchmark, flatConfig, nestedConfig } from "./fixtures";

// Budgets chosen for a shared CI runner — export is an interactive,
// user-initiated flow so we care about UI jank not throughput. 100 ms on
// 1000 nodes is fine; over that the user notices the freeze.
const BUDGET_MAP_PASSWORDS_1K = 120;
const BUDGET_MAP_PASSWORDS_5K = 500;

describe("perf: mapNodePasswords (export walker)", function () {
  this.timeout(60_000);

  it("walks a 1000-node flat config under 120 ms", async () => {
    const cfg = flatConfig(1000);
    const { avgMs } = await benchmark(
      "mapNodePasswords(flat-1k)",
      10,
      async () => {
        await mapNodePasswords(cfg, async () => undefined);
      },
    );
     
    console.log(`  mapNodePasswords(flat-1000): ${avgMs.toFixed(2)}ms`);
    assert.ok(
      avgMs < BUDGET_MAP_PASSWORDS_1K,
      `mapNodePasswords(1000) took ${avgMs.toFixed(2)}ms per call — budget is ${BUDGET_MAP_PASSWORDS_1K}ms.`,
    );
  });

  it("walks a ~5000-node nested config under 500 ms", async () => {
    const cfg = nestedConfig(5000);
    const { avgMs } = await benchmark(
      "mapNodePasswords(nested-~5k)",
      5,
      async () => {
        await mapNodePasswords(cfg, async () => undefined);
      },
    );
     
    console.log(`  mapNodePasswords(nested-~5000): ${avgMs.toFixed(2)}ms`);
    assert.ok(
      avgMs < BUDGET_MAP_PASSWORDS_5K,
      `mapNodePasswords(5k nested) took ${avgMs.toFixed(2)}ms per call — budget is ${BUDGET_MAP_PASSWORDS_5K}ms.`,
    );
  });
});
