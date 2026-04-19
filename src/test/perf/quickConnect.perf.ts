/**
 * Perf budget for the full `vsCRT.quickConnect` hot path: flatten + build
 * items + recents filter + QuickPick-item construction. This is the
 * latency a user feels between `Ctrl+Alt+S` and the picker appearing.
 *
 * Run with `npm run test:perf`.
 */

import * as assert from "assert";
import {
  buildQuickConnectItems,
  flattenConfigNodes,
} from "../../commands/quickConnectCommand";
import { benchmark, flatConfig } from "./fixtures";

const BUDGET_QUICK_CONNECT_1K = 20;
const BUDGET_QUICK_CONNECT_5K = 80;

describe("perf: quickConnect full pipeline", function () {
  this.timeout(30_000);

  it("builds items for a 1000-node config under 20 ms", async () => {
    const cfg = flatConfig(1000);
    // Simulate the command handler's sequence.
    const { avgMs } = await benchmark(
      "quickConnect(1k)",
      25,
      () => {
        const flat = flattenConfigNodes(cfg);
        buildQuickConnectItems(flat, [
          "Imported/host-0005",
          "Imported/host-0100",
          "Imported/host-0500",
        ]);
      },
    );
     
    console.log(`  quickConnect(1000): ${avgMs.toFixed(2)}ms`);
    assert.ok(
      avgMs < BUDGET_QUICK_CONNECT_1K,
      `quickConnect pipeline (1000) took ${avgMs.toFixed(2)}ms — budget is ${BUDGET_QUICK_CONNECT_1K}ms.`,
    );
  });

  it("builds items for a 5000-node config under 80 ms", async () => {
    const cfg = flatConfig(5000);
    const { avgMs } = await benchmark(
      "quickConnect(5k)",
      10,
      () => {
        const flat = flattenConfigNodes(cfg);
        buildQuickConnectItems(flat, []);
      },
    );
     
    console.log(`  quickConnect(5000): ${avgMs.toFixed(2)}ms`);
    assert.ok(
      avgMs < BUDGET_QUICK_CONNECT_5K,
      `quickConnect pipeline (5000) took ${avgMs.toFixed(2)}ms — budget is ${BUDGET_QUICK_CONNECT_5K}ms.`,
    );
  });
});
