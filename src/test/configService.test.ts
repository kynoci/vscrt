import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CRTConfigService } from "../config/vscrtConfig";
import { __fsPutFile } from "./stubs/vscode";
import { resetVscodeStub } from "./testUtils";

function configFileUri(): vscode.Uri {
  return vscode.Uri.file(path.join(os.homedir(), ".vscrt", "vscrtConfig.json"));
}

/** Seed the in-memory stub FS with the given config JSON. */
function seed(obj: unknown): void {
  __fsPutFile(
    configFileUri(),
    new TextEncoder().encode(JSON.stringify(obj)),
  );
}

describe("CRTConfigService cache", () => {
  beforeEach(() => {
    resetVscodeStub();
  });

  it("returns the same reference on subsequent loadConfig calls", async () => {
    seed({ folder: [{ name: "Production", nodes: [] }] });
    const svc = new CRTConfigService();
    const first = await svc.loadConfig();
    const second = await svc.loadConfig();
    assert.ok(first, "first load succeeded");
    assert.strictEqual(first, second, "second load returns cached reference");
  });

  it("sees updated disk content only after invalidateCache", async () => {
    seed({ folder: [{ name: "Before" }] });
    const svc = new CRTConfigService();
    const first = await svc.loadConfig();
    assert.strictEqual(first?.folder?.[0].name, "Before");

    // Simulate an external edit (e.g., the user editing vscrtConfig.json).
    seed({ folder: [{ name: "After" }] });

    // Cache still serves stale data until invalidated.
    const stillCached = await svc.loadConfig();
    assert.strictEqual(stillCached?.folder?.[0].name, "Before");

    svc.invalidateCache();
    const fresh = await svc.loadConfig();
    assert.strictEqual(fresh?.folder?.[0].name, "After");
  });

  it("saveConfig keeps the cache in sync", async () => {
    seed({ folder: [] });
    const svc = new CRTConfigService();
    const cfg = await svc.loadConfig();
    assert.ok(cfg);
    cfg.folder = [{ name: "Production", nodes: [] }];
    await svc.saveConfig(cfg);

    // Next loadConfig returns the in-memory mutated ref without a disk round-trip.
    const after = await svc.loadConfig();
    assert.strictEqual(after, cfg, "cache holds the saved reference");
    assert.strictEqual(after?.folder?.[0].name, "Production");
  });

  it("appendNode (direct writer) keeps the cache in sync", async () => {
    seed({ folder: [{ name: "Prod", nodes: [] }] });
    const svc = new CRTConfigService();
    await svc.loadConfig(); // warm the cache
    const ok = await svc.appendNode("Prod", {
      name: "web",
      endpoint: "user@host",
    });
    assert.strictEqual(ok, true);

    const after = await svc.loadConfig();
    assert.strictEqual(after?.folder?.[0].nodes?.[0].name, "web");
  });

  it("dedups concurrent first-loads via the in-flight promise", async () => {
    seed({ folder: [{ name: "A" }] });
    const svc = new CRTConfigService();
    const [a, b, c] = await Promise.all([
      svc.loadConfig(),
      svc.loadConfig(),
      svc.loadConfig(),
    ]);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
  });

  it("repopulates the cache after invalidateCache and a re-load", async () => {
    seed({ folder: [{ name: "First" }] });
    const svc = new CRTConfigService();
    const first = await svc.loadConfig();

    svc.invalidateCache();
    seed({ folder: [{ name: "Second" }] });
    const second = await svc.loadConfig();

    // Distinct references — different parse events — and identical refs on repeat.
    assert.notStrictEqual(first, second);
    const third = await svc.loadConfig();
    assert.strictEqual(second, third);
  });
});
