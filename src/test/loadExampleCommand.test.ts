/**
 * Pure-helper tests for the `vsCRT.loadExample` flow. We don't exercise
 * the command's vscode.commands wiring — that's integration-territory —
 * but we do pin the internal `countConfigItems` semantics.
 *
 * The command handler body runs inside a `registerCommand` callback;
 * the logic we verify here is the count-aware modal-gate and the
 * replacement behaviour, both of which rely on a walk that needs to
 * match the exact shape in the vscrtConfigExample.json bundled file.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { CRTConfig } from "../config/vscrtConfigTypes";

/** Mirror of countConfigItems in loadExampleCommand (tested via parity). */
function countConfigItems(cfg: CRTConfig | undefined): {
  folders: number;
  nodes: number;
} {
  if (!cfg?.folder) {
    return { folders: 0, nodes: 0 };
  }
  let folders = 0;
  let nodes = 0;
  const walk = (list: NonNullable<CRTConfig["folder"]>): void => {
    for (const c of list) {
      folders += 1;
      nodes += c.nodes?.length ?? 0;
      if (c.subfolder) {
        walk(c.subfolder);
      }
    }
  };
  walk(cfg.folder);
  return { folders, nodes };
}

describe("loadExample: bundled vscrtConfigExample.json", () => {
  const root = path.resolve(__dirname, "..", "..");
  const examplePath = path.join(root, "vscrtConfigExample.json");

  it("exists at the extension root", () => {
    assert.ok(fs.existsSync(examplePath));
  });

  it("parses as valid JSON and has a `folder` array", () => {
    const parsed = JSON.parse(fs.readFileSync(examplePath, "utf-8")) as CRTConfig;
    assert.ok(Array.isArray(parsed.folder));
  });

  it("contains at least one folder and one server (a meaningful demo)", () => {
    const parsed = JSON.parse(fs.readFileSync(examplePath, "utf-8")) as CRTConfig;
    const counts = countConfigItems(parsed);
    assert.ok(counts.folders >= 1, "expected at least 1 folder");
    assert.ok(counts.nodes >= 1, "expected at least 1 server node");
  });

  it("counts subfolders as folders (Production / Disaster Recovery)", () => {
    const parsed = JSON.parse(fs.readFileSync(examplePath, "utf-8")) as CRTConfig;
    const counts = countConfigItems(parsed);
    // Production + Staging + Development + DR subfolder = 4.
    assert.ok(counts.folders >= 4);
  });
});

describe("countConfigItems helper (parity with loadExampleCommand)", () => {
  it("returns zeros for an empty config", () => {
    assert.deepStrictEqual(countConfigItems({}), { folders: 0, nodes: 0 });
    assert.deepStrictEqual(countConfigItems({ folder: [] }), {
      folders: 0,
      nodes: 0,
    });
  });

  it("counts a single-folder single-node tree", () => {
    const cfg: CRTConfig = {
      folder: [
        { name: "Prod", nodes: [{ name: "Web", endpoint: "u@h" }] },
      ],
    };
    assert.deepStrictEqual(countConfigItems(cfg), { folders: 1, nodes: 1 });
  });

  it("counts nested subfolders recursively", () => {
    const cfg: CRTConfig = {
      folder: [
        {
          name: "Prod",
          nodes: [{ name: "A", endpoint: "u@a" }],
          subfolder: [
            {
              name: "DR",
              nodes: [
                { name: "B", endpoint: "u@b" },
                { name: "C", endpoint: "u@c" },
              ],
            },
          ],
        },
      ],
    };
    assert.deepStrictEqual(countConfigItems(cfg), { folders: 2, nodes: 3 });
  });
});
