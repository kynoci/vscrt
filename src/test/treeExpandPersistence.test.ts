/**
 * PLAN 3 — tree expand/collapse state persistence.
 *
 * Exercises `CRTWebviewProvider`'s globalState integration without
 * standing up a real webview host:
 *   - Constructor `loadPersisted` round-trip.
 *   - `toggle` handler → globalState write via `schedulePersist`.
 *   - Microtask coalescing (burst of toggles = 1 write).
 *   - First-run vs restored disambiguation (R1, plan Edge cases).
 *   - Corrupt / wrong-version defensive fallback.
 */
import * as assert from "assert";
import type { CRTConfigService } from "../config/vscrtConfig";
import { CRTWebviewProvider } from "../treeView/webviewTree";

const STATE_KEY = "vscrt.tree.expandedPaths";

/** Vscode `ExtensionContext.globalState` stub. Records every `update`
 *  call so tests can assert coalescing semantics. */
function fakeContext(initial?: unknown): {
  context: {
    globalState: {
      get: <T>(key: string) => T | undefined;
      update: (key: string, value: unknown) => Promise<void>;
    };
  };
  store: Record<string, unknown>;
  updateCalls: Array<{ key: string; value: unknown }>;
} {
  const store: Record<string, unknown> = {};
  if (initial !== undefined) {
    store[STATE_KEY] = initial;
  }
  const updateCalls: Array<{ key: string; value: unknown }> = [];
  const globalState = {
    get: <T>(key: string): T | undefined => store[key] as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      updateCalls.push({ key, value });
      store[key] = value;
    },
  };
  return { context: { globalState }, store, updateCalls };
}

/** Stand up a provider with a stub configManager / extensionUri. */
function makeProvider(context?: unknown): CRTWebviewProvider {
  // We never invoke methods that touch these — suffice to cast.
  const configManager = {} as CRTConfigService;
  const extensionUri = {} as { fsPath: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new CRTWebviewProvider(configManager, extensionUri as any, context as any);
}

/** Let queued microtasks (schedulePersist) flush. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CRTWebviewProvider — expand/collapse persistence (PLAN 3)", () => {
  describe("constructor / loadPersisted", () => {
    it("seeds from a valid stored record", () => {
      const { context } = fakeContext({
        version: 1,
        paths: ["Production", "Production/DB"],
      });
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      assert.strictEqual(any_.expanded.size, 2);
      assert.ok(any_.expanded.has("Production"));
      assert.ok(any_.expanded.has("Production/DB"));
      assert.strictEqual(any_.hasEverPersisted, true);
    });

    it("treats an absent record as first-run (hasEverPersisted=false)", () => {
      const { context } = fakeContext();
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      assert.strictEqual(any_.expanded.size, 0);
      assert.strictEqual(any_.hasEverPersisted, false);
    });

    it("treats an empty-but-valid record as hasEverPersisted=true", () => {
      // User deliberately collapsed everything yesterday — we MUST NOT
      // expand-all-on-first-render again today.
      const { context } = fakeContext({ version: 1, paths: [] });
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      assert.strictEqual(any_.expanded.size, 0);
      assert.strictEqual(any_.hasEverPersisted, true);
    });

    it("ignores a corrupt stored value (string where object expected)", () => {
      const { context } = fakeContext("not-an-object");
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      assert.strictEqual(any_.expanded.size, 0);
      assert.strictEqual(any_.hasEverPersisted, false);
    });

    it("ignores a forward-incompat version and resets", () => {
      const { context } = fakeContext({ version: 99, paths: ["X"] });
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      assert.strictEqual(any_.expanded.size, 0);
      assert.strictEqual(any_.hasEverPersisted, false);
    });

    it("filters non-string entries from the paths array", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { context } = fakeContext({ version: 1, paths: ["A", 42, null, "B"] as any });
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      assert.deepStrictEqual(
        [...any_.expanded].sort(),
        ["A", "B"],
      );
      assert.strictEqual(any_.hasEverPersisted, true);
    });

    it("works with no context at all (unit-test fallback)", () => {
      const p = makeProvider(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      assert.strictEqual(any_.expanded.size, 0);
      assert.strictEqual(any_.hasEverPersisted, false);
    });
  });

  describe("toggle handler persists", () => {
    it("add-toggle writes the path to globalState on next tick", async () => {
      const { context, updateCalls } = fakeContext();
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      await any_.handleMessage({ type: "toggle", path: "A", expanded: true });
      await flushMicrotasks();
      assert.strictEqual(updateCalls.length, 1);
      assert.deepStrictEqual(updateCalls[0], {
        key: STATE_KEY,
        value: { version: 1, paths: ["A"] },
      });
    });

    it("remove-toggle writes the smaller set", async () => {
      const { context, updateCalls } = fakeContext({
        version: 1,
        paths: ["A", "B"],
      });
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      await any_.handleMessage({ type: "toggle", path: "A", expanded: false });
      await flushMicrotasks();
      assert.strictEqual(updateCalls.length, 1);
      assert.deepStrictEqual(
        (updateCalls[0].value as { paths: string[] }).paths,
        ["B"],
      );
    });
  });

  describe("microtask coalescing", () => {
    it("N toggles within the same tick = 1 globalState.update call", async () => {
      const { context, updateCalls } = fakeContext();
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      // Fire 5 rapid toggles WITHOUT awaiting each one — mirrors the
      // real case where the webview posts a burst of toggle messages
      // and the extension host drains them in the same event-loop
      // tick. Awaiting between calls would let each queued microtask
      // drain individually and defeat the coalesce.
      const pending = [
        any_.handleMessage({ type: "toggle", path: "A", expanded: true }),
        any_.handleMessage({ type: "toggle", path: "A/x", expanded: true }),
        any_.handleMessage({ type: "toggle", path: "A/y", expanded: true }),
        any_.handleMessage({ type: "toggle", path: "B", expanded: true }),
        any_.handleMessage({ type: "toggle", path: "A/y", expanded: false }),
      ];
      await Promise.all(pending);
      await flushMicrotasks();
      assert.strictEqual(
        updateCalls.length,
        1,
        `expected 1 coalesced write, got ${updateCalls.length}`,
      );
      const paths = (updateCalls[0].value as { paths: string[] }).paths;
      assert.deepStrictEqual(paths.sort(), ["A", "A/x", "B"]);
    });

    it("toggles across ticks accumulate into separate writes", async () => {
      const { context, updateCalls } = fakeContext();
      const p = makeProvider(context);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      await any_.handleMessage({ type: "toggle", path: "A", expanded: true });
      await flushMicrotasks();
      await any_.handleMessage({ type: "toggle", path: "B", expanded: true });
      await flushMicrotasks();
      assert.strictEqual(updateCalls.length, 2);
    });
  });

  describe("no-context safety", () => {
    it("toggle is a no-op on globalState when context is absent", async () => {
      // Provider built without ExtensionContext — the method must not
      // throw, even though it has nowhere to write. A missing-context
      // provider is only ever built by unit tests, but the
      // defensive guard keeps the production shape resilient against
      // future refactors.
      const p = makeProvider(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const any_ = p as any;
      await any_.handleMessage({ type: "toggle", path: "A", expanded: true });
      await flushMicrotasks();
      assert.strictEqual(any_.expanded.size, 1);
      assert.ok(any_.expanded.has("A"));
    });
  });
});
