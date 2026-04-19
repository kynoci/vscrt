import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTable } from "../../out/commands.js";

test("formatTable: single row renders header + divider + row", () => {
  const out = formatTable([{ path: "Prod/Web", endpoint: "u@h:22", auth: "publickey" }]);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("PATH"));
  assert.ok(lines[1].startsWith("----"));
  assert.ok(lines[2].startsWith("Prod/Web"));
});

test("formatTable: column widths adapt to the longest row", () => {
  const out = formatTable([
    { path: "a", endpoint: "x" },
    { path: "very-long-path", endpoint: "shorter" },
  ]);
  const lines = out.trimEnd().split("\n");
  // Header PATH column width should match the longest path (14 chars)
  assert.ok(lines[0].slice(0, 14).includes("PATH"));
  // Each data row should have its path padded to at least 14 chars.
  const pathCol = lines[2].slice(0, 14);
  assert.equal(pathCol, "a             ".slice(0, 14));
});

test("formatTable: handles rows with no endpoint / no auth", () => {
  const out = formatTable([{ path: "Bare" }]);
  assert.ok(out.includes("Bare"));
  assert.ok(out.endsWith("\n"));
});

test("formatTable: ends with exactly one newline", () => {
  const out = formatTable([{ path: "A", endpoint: "b", auth: "c" }]);
  assert.ok(out.endsWith("\n"));
  assert.ok(!out.endsWith("\n\n"));
});

test("formatTable: header widths when all rows are short", () => {
  const out = formatTable([{ path: "a", endpoint: "b" }]);
  const lines = out.split("\n");
  // PATH column minimum width is 4 (PATH = 4 chars)
  assert.ok(lines[0].startsWith("PATH  "));
  // ENDPOINT column minimum width is 8
  assert.ok(lines[0].includes("ENDPOINT  "));
});

test("formatTable: caps column widths at 80 chars with ellipsis", () => {
  const longPath = "a".repeat(120);
  const out = formatTable([{ path: longPath, endpoint: "x", auth: "y" }]);
  const lines = out.trimEnd().split("\n");
  // Data row's path column should be ≤ 80 chars.
  const pathCol = lines[2].split("  ")[0];
  assert.ok(pathCol.length <= 80, `got ${pathCol.length}`);
  assert.ok(pathCol.endsWith("…"));
});

test("formatTable: short paths pass through unchanged", () => {
  const out = formatTable([{ path: "short", endpoint: "endpoint-x" }]);
  assert.ok(out.includes("short"));
  assert.ok(!out.includes("…"));
});

test("formatTable: empty input still renders header only", () => {
  const out = formatTable([]);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("PATH"));
  assert.ok(lines[1].startsWith("----"));
});
