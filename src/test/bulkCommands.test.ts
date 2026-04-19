import * as assert from "assert";
import { buildBulkTestSummary } from "../commands/bulkCommands";

describe("buildBulkTestSummary", () => {
  it("aggregates counts by outcome, ordered by frequency", () => {
    const out = buildBulkTestSummary([
      { path: "a", outcome: "connected" },
      { path: "b", outcome: "connected" },
      { path: "c", outcome: "timeout" },
    ]);
    assert.match(out.message, /3 — 2 connected, 1 timeout/);
    assert.strictEqual(out.anyFailed, true);
  });

  it("reports anyFailed=false when everything succeeded", () => {
    const out = buildBulkTestSummary([
      { path: "a", outcome: "connected" },
      { path: "b", outcome: "connected" },
    ]);
    assert.strictEqual(out.anyFailed, false);
  });

  it("sets anyFailed on auth-failed outcomes", () => {
    const out = buildBulkTestSummary([
      { path: "a", outcome: "auth-failed" },
    ]);
    assert.strictEqual(out.anyFailed, true);
  });

  it("lists one detail line per result", () => {
    const out = buildBulkTestSummary([
      { path: "Prod/Web", outcome: "connected" },
      { path: "Prod/DB", outcome: "timeout" },
    ]);
    assert.ok(out.detail.includes("Prod/Web: connected"));
    assert.ok(out.detail.includes("Prod/DB: timeout"));
  });

  it("handles an empty input", () => {
    const out = buildBulkTestSummary([]);
    assert.match(out.message, /tested 0/);
    assert.strictEqual(out.anyFailed, false);
  });
});
