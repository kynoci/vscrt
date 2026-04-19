import * as assert from "assert";
import {
  emptySelection,
  prune,
  range,
  selectAll,
  single,
  toggle,
  validateBulkMove,
} from "../treeView/bulkSelection";

describe("bulkSelection", () => {
  describe("toggle", () => {
    it("adds a new path", () => {
      const out = toggle(emptySelection(), "Prod/Web");
      assert.ok(out.selected.has("Prod/Web"));
      assert.strictEqual(out.anchor, "Prod/Web");
    });

    it("removes an already-selected path", () => {
      const out = toggle(single("Prod/Web"), "Prod/Web");
      assert.strictEqual(out.selected.size, 0);
      assert.strictEqual(out.anchor, "Prod/Web");
    });

    it("preserves other selections", () => {
      const start = toggle(single("a"), "b");
      const out = toggle(start, "c");
      assert.deepStrictEqual(
        [...out.selected].sort(),
        ["a", "b", "c"],
      );
    });
  });

  describe("range", () => {
    const flat = ["a", "b", "c", "d", "e"];

    it("selects the inclusive range from anchor to target (forward)", () => {
      const out = range(single("b"), flat, "d");
      assert.deepStrictEqual([...out.selected].sort(), ["b", "c", "d"]);
    });

    it("selects the inclusive range backward", () => {
      const out = range(single("d"), flat, "b");
      assert.deepStrictEqual([...out.selected].sort(), ["b", "c", "d"]);
    });

    it("falls back to single-select when anchor isn't in flat", () => {
      const state = single("vanished");
      const out = range(state, flat, "c");
      assert.deepStrictEqual([...out.selected], ["c"]);
    });

    it("preserves the anchor across range clicks", () => {
      const out = range(single("b"), flat, "d");
      assert.strictEqual(out.anchor, "b");
    });
  });

  describe("selectAll / prune", () => {
    const flat = ["a", "b", "c"];

    it("selectAll picks every path and anchors to the first", () => {
      const out = selectAll(flat);
      assert.strictEqual(out.selected.size, 3);
      assert.strictEqual(out.anchor, "a");
    });

    it("prune drops vanished paths", () => {
      const start = selectAll(flat);
      const pruned = prune(start, ["a", "c"]);
      assert.deepStrictEqual([...pruned.selected].sort(), ["a", "c"]);
    });

    it("prune clears the anchor if it's gone", () => {
      const start = single("b");
      const pruned = prune(start, ["a", "c"]);
      assert.strictEqual(pruned.anchor, null);
    });
  });

  describe("validateBulkMove", () => {
    it("accepts independent sources", () => {
      const out = validateBulkMove(["Prod/a", "Prod/b"], "Staging");
      assert.deepStrictEqual(out, []);
    });

    it("rejects when the destination is inside a selected ancestor", () => {
      const out = validateBulkMove(["Prod"], "Prod/Staging");
      assert.deepStrictEqual(out, ["Prod"]);
    });

    it("rejects when one selected path is a descendant of another", () => {
      const out = validateBulkMove(["Prod", "Prod/Web"], "Staging");
      assert.ok(out.includes("Prod"));
    });

    it("allows moving to root (null dest)", () => {
      const out = validateBulkMove(["Prod/Web"], null);
      assert.deepStrictEqual(out, []);
    });
  });
});
