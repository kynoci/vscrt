import * as assert from "assert";
import { resolveTerminalLocation } from "../commands/connectCommands";
import { CRTConfigNode } from "../config/vscrtConfig";

function node(partial: Partial<CRTConfigNode> = {}): CRTConfigNode {
  return { name: "n", endpoint: "u@h", ...partial };
}

describe("resolveTerminalLocation", () => {
  it("honours an explicit override over everything else", () => {
    assert.strictEqual(
      resolveTerminalLocation(
        node({ terminalLocation: "panel" }),
        "dblclick",
        "editor",
        { "vsCRT.doubleClickTerminalLocation": "panel" },
      ),
      "editor",
    );
  });

  it("falls back to per-node terminalLocation when no override", () => {
    assert.strictEqual(
      resolveTerminalLocation(
        node({ terminalLocation: "editor" }),
        "dblclick",
      ),
      "editor",
    );
    assert.strictEqual(
      resolveTerminalLocation(
        node({ terminalLocation: "panel" }),
        "button",
      ),
      "panel",
    );
  });

  it("falls back to the file-level setting matching the trigger", () => {
    assert.strictEqual(
      resolveTerminalLocation(node(), "dblclick", undefined, {
        "vsCRT.doubleClickTerminalLocation": "panel",
      }),
      "panel",
    );
    assert.strictEqual(
      resolveTerminalLocation(node(), "button", undefined, {
        "vsCRT.buttonClickTerminalLocation": "editor",
      }),
      "editor",
    );
  });

  it("uses the hardcoded default when nothing else applies (dblclick → panel)", () => {
    assert.strictEqual(
      resolveTerminalLocation(node(), "dblclick"),
      "panel",
    );
  });

  it("uses the hardcoded default when nothing else applies (button → editor)", () => {
    assert.strictEqual(
      resolveTerminalLocation(node(), "button"),
      "editor",
    );
  });

  it("ignores a non-panel/non-editor override value", () => {
    // @ts-expect-error — simulates stale config value
    const r = resolveTerminalLocation(node(), "dblclick", "elsewhere");
    assert.strictEqual(r, "panel");
  });

  it("ignores a non-panel/non-editor per-node value", () => {
    assert.strictEqual(
      resolveTerminalLocation(
        // @ts-expect-error — simulates stale config value
        node({ terminalLocation: "elsewhere" }),
        "button",
      ),
      "editor",
    );
  });
});
