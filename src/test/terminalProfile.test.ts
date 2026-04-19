import * as assert from "assert";
import type { FlatNode } from "../commands/quickConnectCommand";
import {
  TERMINAL_PROFILE_ID,
  buildTerminalProfilePickItems,
} from "../terminalProfile";

describe("terminalProfile", () => {
  describe("TERMINAL_PROFILE_ID", () => {
    it("matches the manifest profile id", () => {
      // If this changes, package.json contributes.terminal.profiles and
      // activationEvents onTerminalProfile:<id> must change too.
      assert.strictEqual(TERMINAL_PROFILE_ID, "vsCRT.terminalProfile");
    });
  });

  describe("buildTerminalProfilePickItems", () => {
    it("omits port suffix when port is 22", () => {
      const flat: FlatNode[] = [
        {
          path: "Prod/alpha",
          node: { name: "alpha", endpoint: "user@host1" },
        },
      ];
      const items = buildTerminalProfilePickItems(flat);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].label, "Prod/alpha");
      assert.strictEqual(items[0].description, "user@host1");
      assert.strictEqual(items[0].nodePath, "Prod/alpha");
    });

    it("appends :<port> when a custom port is set", () => {
      const flat: FlatNode[] = [
        {
          path: "Prod/bastion",
          node: { name: "bastion", endpoint: "user@host:2222" },
        },
      ];
      const items = buildTerminalProfilePickItems(flat);
      assert.strictEqual(items[0].description, "user@host:2222");
    });

    it("preserves depth-first order of the flattened input", () => {
      const flat: FlatNode[] = [
        { path: "A/one", node: { name: "one", endpoint: "u@a" } },
        { path: "A/two", node: { name: "two", endpoint: "u@b" } },
        { path: "B/three", node: { name: "three", endpoint: "u@c" } },
      ];
      const items = buildTerminalProfilePickItems(flat);
      assert.deepStrictEqual(
        items.map((i) => i.nodePath),
        ["A/one", "A/two", "B/three"],
      );
    });

    it("returns an empty list for an empty input", () => {
      assert.deepStrictEqual(buildTerminalProfilePickItems([]), []);
    });
  });
});
