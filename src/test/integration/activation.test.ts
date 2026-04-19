/**
 * Integration tests for the vsCRT extension running inside a real VS Code
 * Extension Development Host. Loaded by @vscode/test-cli — see
 * `.vscode-test.mjs` for wiring.
 *
 * These tests mutate the real filesystem (under the tmp HOME the test
 * launcher provides) and interact with the real VS Code command API, so
 * they're much slower than the pure-Mocha unit suite. Keep them focused
 * on contracts unit tests can't cover: command registration, activation
 * side effects, and command wiring round-trips.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const EXT_ID = "kynoci.vscrt";

interface PackageJson {
  contributes: {
    commands: Array<{ command: string }>;
  };
}

describe("vsCRT extension — integration", () => {
  let ext: vscode.Extension<unknown> | undefined;

  before(async function () {
    this.timeout(30_000); // activation + Argon2id first-load can be slow
    ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is not present in the test host`);
    if (!ext.isActive) {
      await ext.activate();
    }
  });

  describe("activation", () => {
    it("registers every command declared in package.json", async () => {
      assert.ok(ext, "extension handle from before() is present");
      const pkg = ext.packageJSON as PackageJson;
      const declared = pkg.contributes.commands.map((c) => c.command);

      const registered = new Set(await vscode.commands.getCommands(true));
      const missing = declared.filter((id) => !registered.has(id));
      assert.deepStrictEqual(
        missing,
        [],
        `commands declared in package.json but not registered: ${missing.join(", ")}`,
      );
    });

    it("activates without throwing", () => {
      assert.ok(ext?.isActive, "extension reports isActive === true");
    });
  });

  describe("config seeding", () => {
    it("vsCRT.openConfig creates ~/.vscrt/vscrtConfig.json on first run", async function () {
      this.timeout(10_000);
      const configPath = path.join(os.homedir(), ".vscrt", "vscrtConfig.json");

      // If a prior test already triggered seeding, delete the file so we
      // observe the create path. Under the tmp HOME the .vscrt dir and its
      // contents are safe to remove.
      if (fs.existsSync(configPath)) {
        fs.rmSync(configPath);
      }

      await vscode.commands.executeCommand("vsCRT.openConfig");
      // showTextDocument is async; give VS Code a moment to surface the editor.
      await wait(300);

      assert.ok(
        fs.existsSync(configPath),
        `expected seeded config at ${configPath}`,
      );

      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        folder?: unknown[];
      };
      assert.ok(
        Array.isArray(parsed.folder),
        "seeded config has a 'folder' array",
      );
      // First-run now seeds `{"folder": []}` and drives onboarding via
      // the welcome walkthrough + webview empty-state. A populated demo
      // is opt-in via the "Load Example" button / `vsCRT.loadExample`.
      assert.strictEqual(parsed.folder.length, 0, "seeded config is empty");
    });

    it("vsCRT.openConfig opens the config file in an active editor", async function () {
      this.timeout(10_000);
      await vscode.commands.executeCommand("vsCRT.openConfig");
      await wait(300);

      const active = vscode.window.activeTextEditor;
      assert.ok(active, "an editor is active after vsCRT.openConfig");
      const fsPath = active.document.uri.fsPath;
      assert.ok(
        fsPath.endsWith(path.join(".vscrt", "vscrtConfig.json")) ||
          fsPath.endsWith("vscrtConfig.json"),
        `expected active editor on vscrtConfig.json, got ${fsPath}`,
      );
    });
  });

  describe("refresh commands (smoke)", () => {
    it("vsCRT.refresh resolves without throwing", async () => {
      await vscode.commands.executeCommand("vsCRT.refresh");
    });

    it("vsCRT.refreshStatus resolves without throwing", async function () {
      // Status probes shell out to wsl / where / sshpass detection — allow
      // up to 15 s to account for slow subprocess responses on CI runners.
      this.timeout(15_000);
      await vscode.commands.executeCommand("vsCRT.refreshStatus");
    });
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
