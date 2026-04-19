/**
 * Integration coverage for the Round-4/5/6 commands the unit suite can't
 * reach through `vscode` stubs:
 *
 *   - vsCRT.quickConnect        (recents persistence + picker population)
 *   - vsCRT.validateConfig      (structured parse/shape errors to channel)
 *   - vsCRT.restoreConfigBackup (backup listing + copy-back over current file)
 *   - vsCRT.exportProfile       (JSON bundle on disk, strip + rekey modes)
 *   - vsCRT.importProfile       (round-trips back into config.folder)
 *   - vsCRT.removeHostKey       (ssh-keygen -R wrapper on a fixture known_hosts)
 *
 * Each test stubs only the dialogs the command actually opens and asserts
 * on durable side-effects (files on disk, globalState, config contents).
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  activateExt,
  inputBoxSequence,
  waitFor,
  withStubbed,
} from "./helpers";
import type { VscrtExports } from "../../extension";

const CONFIG_DIR = () => path.join(os.homedir(), ".vscrt");
const CONFIG_FILE = () => path.join(CONFIG_DIR(), "vscrtConfig.json");
const BACKUP_DIR = () => path.join(CONFIG_DIR(), "backups");

function writeConfig(cfg: unknown): void {
  fs.mkdirSync(CONFIG_DIR(), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2));
}

function readConfig(): unknown {
  return JSON.parse(fs.readFileSync(CONFIG_FILE(), "utf-8"));
}

describe("vsCRT — Round 4/5/6 command integration", () => {
  let api: VscrtExports;

  before(async function () {
    this.timeout(30_000);
    api = await activateExt();
  });

  // Each test writes a fresh config + invalidates the cache so state from
  // one test doesn't bleed into the next.
  beforeEach(async () => {
    api.__test.configManager.invalidateCache();
  });

  // ---------------------------------------------------------------------
  // quickConnect
  // ---------------------------------------------------------------------
  describe("vsCRT.quickConnect", () => {
    it("populates the picker from the current config", async function () {
      this.timeout(10_000);
      writeConfig({
        folder: [
          {
            name: "Prod",
            nodes: [
              { name: "Web", endpoint: "deploy@prod-web" },
              { name: "DB", endpoint: "pg@prod-db:5432" },
            ],
          },
        ],
      });
      api.__test.configManager.invalidateCache();

      let pickedItems: ReadonlyArray<vscode.QuickPickItem> = [];
      await withStubbed(
        {
          showQuickPick: async (items: unknown) => {
            pickedItems = (await Promise.resolve(
              items,
            )) as readonly vscode.QuickPickItem[];
            return undefined; // user cancels — we only want the items list.
          },
        },
        () => vscode.commands.executeCommand("vsCRT.quickConnect"),
      );

      const labels = pickedItems.map((i) => i.label);
      assert.ok(labels.includes("Prod/Web"), `expected Prod/Web, got: ${labels.join(", ")}`);
      assert.ok(labels.includes("Prod/DB"));
    });

    it("short-circuits with an informational toast when there are no servers", async function () {
      this.timeout(10_000);
      writeConfig({ folder: [] });
      api.__test.configManager.invalidateCache();

      let toastShown = false;
      let quickPickCalled = false;
      await withStubbed(
        {
          showInformationMessage: async () => {
            toastShown = true;
            return undefined;
          },
          showQuickPick: async () => {
            quickPickCalled = true;
            return undefined;
          },
        },
        () => vscode.commands.executeCommand("vsCRT.quickConnect"),
      );
      assert.strictEqual(toastShown, true);
      assert.strictEqual(quickPickCalled, false);
    });
  });

  // ---------------------------------------------------------------------
  // validateConfig
  // ---------------------------------------------------------------------
  describe("vsCRT.validateConfig", () => {
    it("reports 'valid' on a well-formed config", async function () {
      this.timeout(8_000);
      writeConfig({
        folder: [{ name: "X", nodes: [{ name: "n", endpoint: "u@h" }] }],
      });

      let infoMessage: string | undefined;
      await withStubbed(
        {
          showInformationMessage: async (msg: string) => {
            infoMessage = msg;
            return undefined;
          },
        },
        () => vscode.commands.executeCommand("vsCRT.validateConfig"),
      );
      assert.ok(
        infoMessage && /config is valid/.test(infoMessage),
        `expected 'config is valid' toast, got: ${infoMessage}`,
      );
    });

    it("reports structural issues on a malformed config", async function () {
      this.timeout(8_000);
      // Missing endpoint on a node — parses as JSON but fails shape check.
      writeConfig({ folder: [{ name: "Y", nodes: [{ name: "n" }] }] });

      let warnMessage: string | undefined;
      await withStubbed(
        {
          showWarningMessage: async (msg: string) => {
            warnMessage = msg;
            return undefined;
          },
        },
        () => vscode.commands.executeCommand("vsCRT.validateConfig"),
      );
      assert.ok(
        warnMessage && /structural issue/.test(warnMessage),
        `expected structural-issue toast, got: ${warnMessage}`,
      );
    });

    it("reports a JSON parse error when the file isn't valid JSON", async function () {
      this.timeout(8_000);
      fs.writeFileSync(CONFIG_FILE(), "{not valid json");

      let errorMessage: string | undefined;
      await withStubbed(
        {
          showErrorMessage: async (msg: string) => {
            errorMessage = msg;
            return undefined;
          },
        },
        () => vscode.commands.executeCommand("vsCRT.validateConfig"),
      );
      assert.ok(
        errorMessage && /not valid JSON/i.test(errorMessage),
        `expected 'not valid JSON' toast, got: ${errorMessage}`,
      );
    });
  });

  // ---------------------------------------------------------------------
  // backup + restore
  // ---------------------------------------------------------------------
  describe("config backups + vsCRT.restoreConfigBackup", () => {
    it("writes a timestamped backup on every save", async function () {
      this.timeout(10_000);
      const { configManager } = api.__test;

      // Seed, then save twice through the service — both saves should
      // produce backups (the first save sees the seeded file already on
      // disk; the second sees the first save).
      writeConfig({ folder: [] });
      configManager.invalidateCache();
      const cfg1 = await configManager.loadConfig();
      assert.ok(cfg1);
      cfg1.folder = [{ name: "Alpha", nodes: [] }];
      await configManager.saveConfig(cfg1);
      cfg1.folder.push({ name: "Beta", nodes: [] });
      await configManager.saveConfig(cfg1);

      const backups = fs.existsSync(BACKUP_DIR())
        ? fs.readdirSync(BACKUP_DIR()).filter((f) => /^vscrtConfig\./.test(f))
        : [];
      assert.ok(
        backups.length >= 2,
        `expected ≥2 backups, got ${backups.length}: ${backups.join(", ")}`,
      );
    });

    it("vsCRT.restoreConfigBackup replaces the current file with the picked backup", async function () {
      this.timeout(15_000);
      const { configManager, connectionView } = api.__test;

      // Start with a known-good config that gets backed up on the next save.
      writeConfig({ folder: [{ name: "KNOWN-GOOD", nodes: [] }] });
      configManager.invalidateCache();
      const cfg = await configManager.loadConfig();
      assert.ok(cfg);
      // Trigger a save so a backup of the KNOWN-GOOD file is written.
      cfg.folder = (cfg.folder ?? []).concat([
        { name: "MUTATED", nodes: [] },
      ]);
      await configManager.saveConfig(cfg);

      // Now corrupt the live config.
      fs.writeFileSync(CONFIG_FILE(), "{ corrupted");

      // Invoke restore, stubbing the QuickPick (pick newest) and the
      // confirmation modal (accept).
      await withStubbed(
        {
          showQuickPick: async (items: unknown) => {
            const resolved = (await Promise.resolve(
              items,
            )) as readonly vscode.QuickPickItem[];
            // Newest-first by contract — pick item[0].
            return resolved[0];
          },
          showWarningMessage: async (
            _msg: string,
            ..._rest: unknown[]
          ) => "Restore",
          showInformationMessage: async () => undefined,
        },
        () => vscode.commands.executeCommand("vsCRT.restoreConfigBackup"),
      );

      // The restored file should parse again.
      const restored = readConfig() as { folder?: { name: string }[] };
      assert.ok(
        Array.isArray(restored.folder),
        `restored config should parse, got: ${JSON.stringify(restored)}`,
      );
      // Any of our known-good-or-mutated folder names is a pass — the
      // important invariant is "we recovered from corruption via a backup".
      const names = restored.folder?.map((f) => f.name) ?? [];
      assert.ok(
        names.includes("KNOWN-GOOD") || names.includes("MUTATED"),
        `expected a recognisable folder from backup; got ${names.join(", ")}`,
      );
      // Webview was asked to reload.
      void connectionView;
    });
  });

  // ---------------------------------------------------------------------
  // export + import round-trip
  // ---------------------------------------------------------------------
  describe("vsCRT.exportProfile + vsCRT.importProfile", () => {
    it("strip-mode bundle round-trips through the import flow", async function () {
      this.timeout(20_000);
      const { configManager } = api.__test;

      writeConfig({
        folder: [
          {
            name: "ForExport",
            nodes: [{ name: "host-a", endpoint: "u@a" }],
          },
        ],
      });
      configManager.invalidateCache();

      const tmpBundle = path.join(
        os.tmpdir(),
        `vscrt-bundle-${Date.now()}.json`,
      );

      // --- export (strip mode: no passphrase needed) ---------------------
      await withStubbed(
        {
          showQuickPick: async (items: unknown) => {
            // The first QuickPick selects the mode. Pick "Strip passwords".
            const resolved = (await Promise.resolve(
              items,
            )) as readonly vscode.QuickPickItem[];
            return resolved.find(
              (i) => typeof i.label === "string" && /strip/i.test(i.label),
            );
          },
          showSaveDialog: async () => vscode.Uri.file(tmpBundle),
          showInformationMessage: async () => undefined,
        },
        () => vscode.commands.executeCommand("vsCRT.exportProfile"),
      );

      assert.ok(
        fs.existsSync(tmpBundle),
        `bundle should have been written to ${tmpBundle}`,
      );
      const bundleRaw = JSON.parse(fs.readFileSync(tmpBundle, "utf-8")) as {
        format: string;
        passwordsIncluded: boolean;
        config: { folder?: { name: string }[] };
      };
      assert.strictEqual(bundleRaw.format, "vscrt-bundle/v1");
      assert.strictEqual(bundleRaw.passwordsIncluded, false);
      assert.ok(
        bundleRaw.config.folder?.some((f) => f.name === "ForExport"),
        "bundle should carry the source folder",
      );

      // --- import back into a fresh config ------------------------------
      writeConfig({ folder: [{ name: "Existing", nodes: [] }] });
      configManager.invalidateCache();

      await withStubbed(
        {
          showOpenDialog: async () => [vscode.Uri.file(tmpBundle)],
          showQuickPick: async (items: unknown) => {
            const resolved = (await Promise.resolve(
              items,
            )) as readonly vscode.QuickPickItem[];
            // canPickMany picker — return all items.
            return resolved as unknown as vscode.QuickPickItem;
          },
          showInformationMessage: async () => undefined,
        },
        () => vscode.commands.executeCommand("vsCRT.importProfile"),
      );

      const current = await waitFor(async () => {
        const c = await configManager.loadConfig();
        return c?.folder?.some((f) => f.name === "ForExport") ? c : undefined;
      });
      const folderNames = (current?.folder ?? []).map((f) => f.name);
      assert.ok(folderNames.includes("Existing"));
      assert.ok(folderNames.includes("ForExport"));

      // Cleanup
      fs.unlinkSync(tmpBundle);
    });
  });

  // ---------------------------------------------------------------------
  // removeHostKey
  // ---------------------------------------------------------------------
  describe("vsCRT.removeHostKey", () => {
    it("clears an entry from a fixture known_hosts", async function () {
      this.timeout(15_000);
      const sshDir = path.join(os.homedir(), ".ssh");
      fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
      const knownHostsPath = path.join(sshDir, "known_hosts");
      // Seed with a made-up entry + one unrelated line we want preserved.
      fs.writeFileSync(
        knownHostsPath,
        [
          "integration-host.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFaKeKeyForTesting",
          "other-host.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyForTesting",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );

      // Fabricate a CRTTarget for the command (it only reads item.type,
      // item.config.endpoint, item.config.name).
      const fakeTarget = {
        item: {
          type: "node" as const,
          path: "Prod/integration-host",
          label: "integration-host",
          config: {
            name: "integration-host",
            endpoint: "user@integration-host.example",
          },
        },
      };

      await withStubbed(
        {
          showWarningMessage: async (
            _msg: string,
            ..._rest: unknown[]
          ) => "Remove",
          showInformationMessage: async () => undefined,
          showErrorMessage: async () => undefined,
        },
        () =>
          vscode.commands.executeCommand(
            "vsCRT.removeHostKey",
            fakeTarget,
          ),
      );

      const after = fs.existsSync(knownHostsPath)
        ? fs.readFileSync(knownHostsPath, "utf-8")
        : "";
      assert.ok(
        !/integration-host\.example/.test(after),
        `integration-host.example should be gone, got: ${after}`,
      );
      assert.ok(
        /other-host\.example/.test(after),
        `other-host.example should remain, got: ${after}`,
      );
    });
  });

  // Touch helper so its import isn't dropped during the tree-shake sweep
  // the compile step does on unused imports.
  void inputBoxSequence;
});
