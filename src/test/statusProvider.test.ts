import * as assert from "assert";
import * as vscode from "vscode";
import { buildBinaryItem, detectBinary } from "../status/statusProvider";

const icons = {
  ok: () => new vscode.ThemeIcon("check"),
  missing: () => new vscode.ThemeIcon("error"),
};

describe("detectBinary", () => {
  const isWin = process.platform === "win32";

  it("returns a path for a binary that exists on PATH", async function () {
    this.timeout(10_000);
    // `true` is on POSIX; on Windows use `cmd` which is guaranteed.
    const bin = isWin ? "cmd.exe" : "true";
    const out = await detectBinary(process.platform, bin);
    assert.ok(
      out && out.length > 0,
      `expected a path for ${bin}, got ${out}`,
    );
  });

  it("returns null when the binary doesn't exist", async function () {
    this.timeout(10_000);
    const out = await detectBinary(
      process.platform,
      "definitely-not-a-real-binary-abc123xyz",
    );
    assert.strictEqual(out, null);
  });
});

describe("buildBinaryItem", () => {
  it("renders 'found' when a path is provided, with description + tooltip", () => {
    const item = buildBinaryItem("sftp", "/usr/bin/sftp", icons);
    assert.ok(String(item.label).includes("found"));
    assert.strictEqual(item.description, "/usr/bin/sftp");
    assert.ok(
      String(item.tooltip).includes("/usr/bin/sftp"),
      "tooltip mentions the path",
    );
  });

  it("renders 'missing' when path is null, with install hint", () => {
    const item = buildBinaryItem("scp", null, icons);
    assert.ok(String(item.label).includes("missing"));
    assert.strictEqual(item.description, undefined);
    assert.ok(
      String(item.tooltip).toLowerCase().includes("not on path"),
      "tooltip nudges the user toward installation",
    );
  });

  it("passes icons through: ok icon when found, missing icon when not", () => {
    const okItem = buildBinaryItem("sftp", "/usr/bin/sftp", icons);
    const missingItem = buildBinaryItem("sftp", null, icons);
    // ThemeIcon.id is the internal name we passed in.
    assert.strictEqual((okItem.iconPath as vscode.ThemeIcon).id, "check");
    assert.strictEqual(
      (missingItem.iconPath as vscode.ThemeIcon).id,
      "error",
    );
  });
});
