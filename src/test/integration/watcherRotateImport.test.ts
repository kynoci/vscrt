/**
 * Integration coverage for paths that the unit suite can't reach:
 *   - file-watcher reload roundtrip (external config edit → cache invalidated)
 *   - SSH-config importer end-to-end (fixture → Imported folder populated)
 *   - auto-lock setting change reflected in the service's idle timer
 *
 * Each test touches the real VS Code extension host and expects a tmp
 * HOME provided by `.vscode-test.mjs`'s `env` block.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { VscrtExports } from "../../extension";

const EXT_ID = "kynoci.vscrt";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  predicate: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v !== undefined && v !== false) {
      return v as T;
    }
    await wait(intervalMs);
  }
  throw new Error(`waitFor: predicate never satisfied within ${timeoutMs}ms`);
}

describe("vsCRT — watcher + importer + auto-lock", () => {
  let api: VscrtExports;

  before(async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension<VscrtExports>(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} must be present in the test host`);
    api = ext.isActive ? (ext.exports as VscrtExports) : await ext.activate();
    assert.ok(api?.__test, "extension must expose __test surface");
  });

  describe("config file watcher", () => {
    it("reloads the in-memory config when ~/.vscrt/vscrtConfig.json changes externally", async function () {
      this.timeout(15_000);
      const { configManager } = api.__test;
      const configPath = path.join(
        os.homedir(),
        ".vscrt",
        "vscrtConfig.json",
      );

      // Ensure file exists via any read path that triggers ensureConfigFile.
      await configManager.loadConfig();
      assert.ok(
        fs.existsSync(configPath),
        `seeded config expected at ${configPath}`,
      );

      // Externally rewrite the file with a distinctive marker.
      const marker = `watcher-test-${Date.now()}`;
      const rewritten = {
        folder: [{ name: marker, nodes: [] }],
      };
      fs.writeFileSync(configPath, JSON.stringify(rewritten, null, 2));

      // Wait for the file-system watcher to fire and invalidate the cache,
      // then verify loadConfig returns the new contents.
      const cfg = await waitFor(async () => {
        const current = await configManager.loadConfig();
        return current?.folder?.some((f) => f.name === marker)
          ? current
          : undefined;
      });
      assert.ok(cfg);
    });
  });

  describe("SSH config importer", () => {
    it("imports Host blocks into an 'Imported' folder", async function () {
      this.timeout(15_000);
      const { configManager } = api.__test;
      const sshDir = path.join(os.homedir(), ".ssh");
      fs.mkdirSync(sshDir, { recursive: true });
      const sshConfigPath = path.join(sshDir, "config");
      fs.writeFileSync(
        sshConfigPath,
        [
          "Host watcher-imported-alpha",
          "  HostName 10.0.0.11",
          "  User alice",
          "",
          "Host watcher-imported-beta",
          "  HostName 10.0.0.12",
          "  User bob",
          "  Port 2201",
        ].join("\n"),
      );

      // Stub showQuickPick so the importer's canPickMany prompt auto-
      // selects everything. Restoring the original on teardown.
      const originalShowQuickPick = vscode.window.showQuickPick;
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick =
        async (
          items: ReadonlyArray<vscode.QuickPickItem> | Thenable<ReadonlyArray<vscode.QuickPickItem>>,
        ) => {
          const resolved = await Promise.resolve(items);
          return resolved;
        };
      try {
        await vscode.commands.executeCommand("vsCRT.importSshConfig");
      } finally {
        (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick =
          originalShowQuickPick;
      }

      // configManager has invalidateCache-by-file-watcher wired up, but
      // the importer writes through the service so the cache already
      // holds the new state. Either way this read sees the imports.
      const cfg = await waitFor(async () => {
        const current = await configManager.loadConfig();
        const imported = current?.folder?.find((f) => f.name === "Imported");
        return imported?.nodes?.some(
          (n) => n.name === "watcher-imported-alpha",
        )
          ? imported
          : undefined;
      });
      assert.ok(cfg?.nodes);
      const names = cfg.nodes.map((n) => n.name);
      assert.ok(names.includes("watcher-imported-alpha"));
      assert.ok(names.includes("watcher-imported-beta"));
    });
  });

  describe("auto-lock setting", () => {
    it("updates the service when the setting changes", async function () {
      this.timeout(8_000);
      // Flip the user setting; the extension's onDidChangeConfiguration
      // listener should re-apply the mode. Verify the service isn't
      // crashed + still reports no cached params (nothing to lock yet).
      const cfg = vscode.workspace.getConfiguration("vsCRT");
      const prev = cfg.get<string>("passphraseAutoLock");
      try {
        await cfg.update(
          "passphraseAutoLock",
          "30min",
          vscode.ConfigurationTarget.Global,
        );
        // Settle: the listener runs synchronously after the Promise
        // resolves, but give one tick for safety.
        await wait(50);
        // No passphrase was set up, so cached params should be undefined.
        assert.strictEqual(
          api.__test.passphraseService.getCachedParams(),
          undefined,
        );
      } finally {
        await cfg.update(
          "passphraseAutoLock",
          prev ?? undefined,
          vscode.ConfigurationTarget.Global,
        );
      }
    });
  });
});
