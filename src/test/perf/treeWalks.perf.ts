/**
 * Perf budget tests for the hot-path tree walks that run on every
 * webview reload and every quickConnect invocation. Budgets are set
 * conservatively for a low-end CI runner — the goal is to catch
 * accidental O(n²) regressions, not to chase microseconds.
 *
 * Run with `npm run test:perf`.
 */

import * as assert from "assert";
import { configToItems } from "../../treeView/webviewTreeModel";
import { flattenConfigNodes } from "../../commands/quickConnectCommand";
import { benchmark, countNodes, flatConfig, nestedConfig } from "./fixtures";

// Budgets (ms per invocation). Generous enough that a noisy shared runner
// won't flake; tight enough that a 10× regression (e.g. a nested O(n²)
// walker slipped in by a refactor) will fail the assertion.
const BUDGET_CONFIG_TO_ITEMS_1K = 10;
const BUDGET_FLATTEN_1K = 10;
const BUDGET_CONFIG_TO_ITEMS_5K = 40;

describe("perf: configToItems", function () {
  this.timeout(30_000);

  it("is linear on a 1000-node flat config (budget: 10 ms avg)", async () => {
    const cfg = flatConfig(1000);
    assert.strictEqual(countNodes(cfg), 1000);
    const { avgMs } = await benchmark(
      "configToItems(flat-1k)",
      20,
      () => {
        configToItems(cfg);
      },
    );
     
    console.log(`  configToItems(flat-1000): ${avgMs.toFixed(2)}ms`);
    assert.ok(
      avgMs < BUDGET_CONFIG_TO_ITEMS_1K,
      `configToItems(1000) took ${avgMs.toFixed(2)}ms per call — budget is ${BUDGET_CONFIG_TO_ITEMS_1K}ms. A regression likely introduced O(n²) behaviour in the tree walk.`,
    );
  });

  it("stays linear on a 5000-node nested config (budget: 40 ms avg)", async () => {
    const cfg = nestedConfig(5000);
    // Nested fixture overshoots target slightly because of integer rounding;
    // assert a floor not an exact count.
    assert.ok(countNodes(cfg) >= 4000);
    const { avgMs } = await benchmark(
      "configToItems(nested-5k)",
      10,
      () => {
        configToItems(cfg);
      },
    );
     
    console.log(`  configToItems(nested-~5000): ${avgMs.toFixed(2)}ms`);
    assert.ok(
      avgMs < BUDGET_CONFIG_TO_ITEMS_5K,
      `configToItems(5k nested) took ${avgMs.toFixed(2)}ms per call — budget is ${BUDGET_CONFIG_TO_ITEMS_5K}ms.`,
    );
  });
});

describe("perf: flattenConfigNodes (quick-connect hot path)", function () {
  this.timeout(30_000);

  it("flattens 1000 nodes under budget (10 ms avg)", async () => {
    const cfg = flatConfig(1000);
    const { avgMs } = await benchmark(
      "flattenConfigNodes(flat-1k)",
      30,
      () => {
        flattenConfigNodes(cfg);
      },
    );
     
    console.log(`  flattenConfigNodes(1000): ${avgMs.toFixed(2)}ms`);
    assert.ok(
      avgMs < BUDGET_FLATTEN_1K,
      `flattenConfigNodes(1000) took ${avgMs.toFixed(2)}ms per call — budget is ${BUDGET_FLATTEN_1K}ms. Keyboard-shortcut quickConnect would feel sluggish at this scale.`,
    );
  });
});
