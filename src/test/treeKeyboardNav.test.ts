import * as assert from "assert";
import {
  FlatRow,
  computeNextFocusedPath,
  firstChildPath,
  parentPathIfVisible,
} from "../treeView/treeKeyboardNav";

const rows = (paths: string[]): FlatRow[] =>
  paths.map((p) => ({ path: p, hasChildren: false }));

describe("computeNextFocusedPath", () => {
  const flat = rows([
    "Prod",
    "Prod/Web",
    "Prod/DB",
    "Staging",
    "Staging/Box",
  ]);

  it("returns null for an empty list", () => {
    assert.strictEqual(
      computeNextFocusedPath([], null, "ArrowDown"),
      null,
    );
  });

  it("lands on the first row when nothing is focused (ArrowDown)", () => {
    assert.strictEqual(
      computeNextFocusedPath(flat, null, "ArrowDown"),
      "Prod",
    );
  });

  it("lands on the last row when nothing is focused (ArrowUp)", () => {
    assert.strictEqual(
      computeNextFocusedPath(flat, null, "ArrowUp"),
      "Staging/Box",
    );
  });

  it("moves down by one", () => {
    assert.strictEqual(
      computeNextFocusedPath(flat, "Prod", "ArrowDown"),
      "Prod/Web",
    );
  });

  it("stays on the last row at the bottom (ArrowDown clamps)", () => {
    assert.strictEqual(
      computeNextFocusedPath(flat, "Staging/Box", "ArrowDown"),
      "Staging/Box",
    );
  });

  it("moves up by one", () => {
    assert.strictEqual(
      computeNextFocusedPath(flat, "Staging", "ArrowUp"),
      "Prod/DB",
    );
  });

  it("stays on the first row at the top (ArrowUp clamps)", () => {
    assert.strictEqual(
      computeNextFocusedPath(flat, "Prod", "ArrowUp"),
      "Prod",
    );
  });

  it("Home jumps to the first row", () => {
    assert.strictEqual(
      computeNextFocusedPath(flat, "Staging/Box", "Home"),
      "Prod",
    );
  });

  it("End jumps to the last row", () => {
    assert.strictEqual(
      computeNextFocusedPath(flat, "Prod", "End"),
      "Staging/Box",
    );
  });

  it("treats an unknown current path like a fresh nav", () => {
    assert.strictEqual(
      computeNextFocusedPath(flat, "ghost/path", "ArrowDown"),
      "Prod",
    );
    assert.strictEqual(
      computeNextFocusedPath(flat, "ghost/path", "ArrowUp"),
      "Staging/Box",
    );
  });
});

describe("parentPathIfVisible", () => {
  const flat = rows(["Prod", "Prod/Web", "Prod/DB/Primary"]);

  it("returns the parent when it's present", () => {
    assert.strictEqual(parentPathIfVisible(flat, "Prod/Web"), "Prod");
  });

  it("returns null at the root (no '/' in path)", () => {
    assert.strictEqual(parentPathIfVisible(flat, "Prod"), null);
  });

  it("returns null when the parent row is not in the flat list (collapsed)", () => {
    assert.strictEqual(
      parentPathIfVisible(flat, "Prod/DB/Primary"),
      null,
    );
  });
});

describe("firstChildPath", () => {
  it("returns the first child when the next row is beneath the current path", () => {
    const flat = rows(["Prod", "Prod/Web", "Prod/DB"]);
    assert.strictEqual(firstChildPath(flat, "Prod"), "Prod/Web");
  });

  it("returns null when the current row has no descendants below it", () => {
    const flat = rows(["Prod", "Staging"]);
    assert.strictEqual(firstChildPath(flat, "Prod"), null);
  });

  it("returns null for an unknown current row", () => {
    const flat = rows(["Prod"]);
    assert.strictEqual(firstChildPath(flat, "ghost"), null);
  });

  it("returns null when the current row is the last row", () => {
    const flat = rows(["Prod/Web"]);
    assert.strictEqual(firstChildPath(flat, "Prod/Web"), null);
  });
});
