/**
 * Tests for the pure configReader helpers (filterRows, flattenTree, defaultConfigPath).
 * No fs or OS calls — pure-function coverage.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultConfigPath,
  filterRows,
  flattenTree,
} from "../../out/configReader.js";

test("filterRows: undefined substring returns a copy of all rows", () => {
  const rows = [{ path: "Prod/Web", endpoint: "ubuntu@a:22" }];
  const out = filterRows(rows, undefined);
  assert.deepEqual(out, rows);
  assert.notEqual(out, rows); // defensive copy
});

test("filterRows: empty string returns a copy of all rows", () => {
  const rows = [{ path: "Prod/Web", endpoint: "ubuntu@a:22" }];
  assert.deepEqual(filterRows(rows, ""), rows);
});

test("filterRows: matches on path substring (case-insensitive)", () => {
  const rows = [
    { path: "Prod/Web", endpoint: "a" },
    { path: "Dev/Web", endpoint: "b" },
  ];
  assert.deepEqual(filterRows(rows, "PROD"), [
    { path: "Prod/Web", endpoint: "a" },
  ]);
});

test("filterRows: matches on endpoint substring", () => {
  const rows = [
    { path: "A", endpoint: "root@db.example.com" },
    { path: "B", endpoint: "root@web.example.com" },
  ];
  assert.deepEqual(filterRows(rows, "db"), [
    { path: "A", endpoint: "root@db.example.com" },
  ]);
});

test("filterRows: handles rows without endpoint", () => {
  const rows = [
    { path: "A" },
    { path: "B", endpoint: "b" },
  ];
  assert.deepEqual(filterRows(rows, "a"), [{ path: "A" }]);
});

test("filterRows: no match yields empty array", () => {
  const rows = [{ path: "A", endpoint: "b" }];
  assert.deepEqual(filterRows(rows, "zzz"), []);
});

test("flattenTree: undefined folder yields []", () => {
  assert.deepEqual(flattenTree(undefined), []);
});

test("flattenTree: flat list is yielded with prefix paths", () => {
  const folder = [
    {
      name: "Prod",
      nodes: [
        { name: "Web", endpoint: "a", preferredAuthentication: "publickey" },
      ],
    },
  ];
  assert.deepEqual(flattenTree(folder), [
    {
      path: "Prod/Web",
      endpoint: "a",
      auth: "publickey",
    },
  ]);
});

test("flattenTree: nested subfolder paths join with /", () => {
  const folder = [
    {
      name: "Prod",
      subfolder: [
        {
          name: "Web",
          nodes: [{ name: "A", endpoint: "x" }],
        },
      ],
    },
  ];
  assert.deepEqual(flattenTree(folder), [
    { path: "Prod/Web/A", endpoint: "x", auth: undefined },
  ]);
});

test("defaultConfigPath: joins home + .vscrt/vscrtConfig.json", () => {
  const p = defaultConfigPath("/home/alice");
  assert.ok(p.endsWith("/.vscrt/vscrtConfig.json") || p.endsWith("\\.vscrt\\vscrtConfig.json"));
});

// readConfig edge cases --------------------------------------------------

import { readConfig } from "../../out/configReader.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("readConfig: returns exists=false for a missing file", () => {
  const fake = "/nonexistent/vscrt-missing-" + Date.now() + ".json";
  const r = readConfig(fake);
  assert.equal(r.exists, false);
  assert.equal(r.path, fake);
});

test("readConfig: returns error for malformed JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-cli-cfg-"));
  const p = path.join(dir, "broken.json");
  fs.writeFileSync(p, "{ not valid json ]");
  const r = readConfig(p);
  assert.equal(r.exists, true);
  assert.ok(r.error, "should surface a parse error message");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readConfig: accepts a file with no folder field (returns empty array)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-cli-cfg-"));
  const p = path.join(dir, "empty.json");
  fs.writeFileSync(p, "{}");
  const r = readConfig(p);
  assert.equal(r.exists, true);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.folder, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readConfig: rejects array-shaped folder gracefully (coerces to [])", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-cli-cfg-"));
  const p = path.join(dir, "bad-shape.json");
  fs.writeFileSync(p, '{"folder": "not-an-array"}');
  const r = readConfig(p);
  assert.equal(r.exists, true);
  assert.deepEqual(r.folder, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readConfig: accepts a full tree round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-cli-cfg-"));
  const p = path.join(dir, "ok.json");
  const cfg = {
    folder: [
      {
        name: "Prod",
        nodes: [{ name: "Web", endpoint: "u@h", preferredAuthentication: "publickey" }],
      },
    ],
  };
  fs.writeFileSync(p, JSON.stringify(cfg));
  const r = readConfig(p);
  assert.equal(r.exists, true);
  assert.equal(r.folder.length, 1);
  assert.equal(r.folder[0].name, "Prod");
  fs.rmSync(dir, { recursive: true, force: true });
});
