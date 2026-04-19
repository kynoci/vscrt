import * as assert from "assert";
import { isValidCodiconName } from "../commands/iconCommand";

describe("isValidCodiconName", () => {
  it("accepts canonical codicon names", () => {
    for (const ok of ["folder", "terminal-bash", "server-process", "vm-active", "terminal"]) {
      assert.strictEqual(isValidCodiconName(ok), true, `expected ${ok} OK`);
    }
  });

  it("rejects empty + whitespace", () => {
    assert.strictEqual(isValidCodiconName(""), false);
    assert.strictEqual(isValidCodiconName(" "), false);
    assert.strictEqual(isValidCodiconName("folder "), false);
  });

  it("rejects uppercase (codicon names are lowercase)", () => {
    assert.strictEqual(isValidCodiconName("Folder"), false);
    assert.strictEqual(isValidCodiconName("TERMINAL"), false);
  });

  it("rejects special characters that aren't hyphen", () => {
    for (const bad of ["folder_plus", "folder.plus", "folder+plus", "folder/plus", "folder plus"]) {
      assert.strictEqual(isValidCodiconName(bad), false, `expected ${bad} bad`);
    }
  });

  it("rejects overlong names (length > 40)", () => {
    assert.strictEqual(isValidCodiconName("a".repeat(41)), false);
    assert.strictEqual(isValidCodiconName("a".repeat(40)), true);
  });

  it("returns false for non-string input", () => {
    // @ts-expect-error — defensive
    assert.strictEqual(isValidCodiconName(null), false);
    // @ts-expect-error — defensive
    assert.strictEqual(isValidCodiconName(undefined), false);
    // @ts-expect-error — defensive
    assert.strictEqual(isValidCodiconName(42), false);
  });
});
