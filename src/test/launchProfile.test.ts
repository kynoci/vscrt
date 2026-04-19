import * as assert from "assert";
import {
  orderByDelay,
  resolveTargets,
} from "../commands/launchProfileCommands";
import { CRTConfig } from "../config/vscrtConfig";

const fixtureConfig: CRTConfig = {
  folder: [
    {
      name: "Prod",
      nodes: [
        { name: "Web", endpoint: "u@prod-web" },
        { name: "DB", endpoint: "u@prod-db" },
      ],
      subfolder: [
        {
          name: "Staging",
          nodes: [{ name: "Box", endpoint: "u@staging" }],
        },
      ],
    },
  ],
};

describe("resolveTargets", () => {
  it("resolves every valid nodePath", () => {
    const out = resolveTargets(fixtureConfig, {
      name: "morning",
      targets: [
        { nodePath: "Prod/Web" },
        { nodePath: "Prod/Staging/Box" },
      ],
    });
    assert.strictEqual(out.resolved.length, 2);
    assert.strictEqual(out.missing.length, 0);
    assert.strictEqual(out.resolved[0].node.name, "Web");
  });

  it("reports missing targets without aborting", () => {
    const out = resolveTargets(fixtureConfig, {
      name: "broken",
      targets: [
        { nodePath: "Prod/Web" },
        { nodePath: "Prod/Gone" },
      ],
    });
    assert.strictEqual(out.resolved.length, 1);
    assert.deepStrictEqual(out.missing, ["Prod/Gone"]);
  });

  it("returns empty results for an empty profile", () => {
    const out = resolveTargets(fixtureConfig, { name: "empty", targets: [] });
    assert.deepStrictEqual(out.resolved, []);
    assert.deepStrictEqual(out.missing, []);
  });
});

describe("orderByDelay", () => {
  it("sorts ascending by delayMs, treating unset as 0", () => {
    const sorted = orderByDelay([
      {
        target: { nodePath: "a", delayMs: 500 },
        node: { name: "a", endpoint: "" },
      },
      {
        target: { nodePath: "b" },
        node: { name: "b", endpoint: "" },
      },
      {
        target: { nodePath: "c", delayMs: 100 },
        node: { name: "c", endpoint: "" },
      },
    ]);
    assert.deepStrictEqual(
      sorted.map((s) => s.target.nodePath),
      ["b", "c", "a"],
    );
  });

  it("is stable for equal delays (input order preserved)", () => {
    const sorted = orderByDelay([
      { target: { nodePath: "a" }, node: { name: "a", endpoint: "" } },
      { target: { nodePath: "b" }, node: { name: "b", endpoint: "" } },
      { target: { nodePath: "c" }, node: { name: "c", endpoint: "" } },
    ]);
    assert.deepStrictEqual(
      sorted.map((s) => s.target.nodePath),
      ["a", "b", "c"],
    );
  });
});
