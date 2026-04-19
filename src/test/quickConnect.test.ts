import * as assert from "assert";
import { CRTConfig } from "../config/vscrtConfig";
import {
  RECENTS_KEY,
  RECENTS_MAX,
  buildQuickConnectItems,
  flattenConfigNodes,
  loadRecents,
  pushRecent,
} from "../commands/quickConnectCommand";

function fakeContext(initial: unknown = undefined): {
  context: {
    globalState: {
      get: <T>(key: string) => T | undefined;
      update: (key: string, value: unknown) => Promise<void>;
    };
  };
  store: Record<string, unknown>;
} {
  const store: Record<string, unknown> = {};
  if (initial !== undefined) {
    store[RECENTS_KEY] = initial;
  }
  const globalState = {
    get: <T>(key: string): T | undefined => store[key] as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      store[key] = value;
    },
  };
  return { context: { globalState }, store };
}

describe("flattenConfigNodes", () => {
  it("returns [] for empty / missing config", () => {
    assert.deepStrictEqual(flattenConfigNodes(null), []);
    assert.deepStrictEqual(flattenConfigNodes(undefined), []);
    assert.deepStrictEqual(flattenConfigNodes({}), []);
    assert.deepStrictEqual(flattenConfigNodes({ folder: [] }), []);
  });

  it("flattens nested folders depth-first with slash-joined paths", () => {
    const cfg: CRTConfig = {
      folder: [
        {
          name: "Prod",
          nodes: [{ name: "Web", endpoint: "deploy@prod-web" }],
          subfolder: [
            {
              name: "DB",
              nodes: [{ name: "Primary", endpoint: "pg@prod-db" }],
            },
          ],
        },
        {
          name: "Staging",
          nodes: [{ name: "Box", endpoint: "dev@staging" }],
        },
      ],
    };
    const flat = flattenConfigNodes(cfg);
    assert.deepStrictEqual(
      flat.map((f) => f.path),
      ["Prod/Web", "Prod/DB/Primary", "Staging/Box"],
    );
  });
});

describe("loadRecents", () => {
  it("returns [] when nothing stored", () => {
    const { context } = fakeContext();
    assert.deepStrictEqual(loadRecents(context as never, new Set()), []);
  });

  it("returns [] when stored value is not an array", () => {
    const { context } = fakeContext("not-an-array");
    assert.deepStrictEqual(loadRecents(context as never, new Set()), []);
  });

  it("drops entries whose paths are no longer valid", () => {
    const { context } = fakeContext(["Prod/Web", "gone/server", "Staging/Box"]);
    const valid = new Set(["Prod/Web", "Staging/Box"]);
    assert.deepStrictEqual(
      loadRecents(context as never, valid),
      ["Prod/Web", "Staging/Box"],
    );
  });

  it("dedupes and caps at RECENTS_MAX", () => {
    const stored = [
      "a/1", "a/1", "a/2", "a/3", "a/4", "a/5", "a/6", "a/7",
    ];
    const valid = new Set(stored);
    const { context } = fakeContext(stored);
    const out = loadRecents(context as never, valid);
    assert.strictEqual(out.length, RECENTS_MAX);
    assert.deepStrictEqual(out, ["a/1", "a/2", "a/3", "a/4", "a/5"]);
  });
});

describe("pushRecent", () => {
  it("persists a single entry on first call", async () => {
    const { context, store } = fakeContext();
    await pushRecent(context as never, "Prod/Web");
    assert.deepStrictEqual(store[RECENTS_KEY], ["Prod/Web"]);
  });

  it("moves an existing entry to the head (dedupe)", async () => {
    const { context, store } = fakeContext(["a/1", "a/2", "a/3"]);
    await pushRecent(context as never, "a/3");
    assert.deepStrictEqual(store[RECENTS_KEY], ["a/3", "a/1", "a/2"]);
  });

  it("caps at RECENTS_MAX, dropping the oldest", async () => {
    const { context, store } = fakeContext([
      "a/1", "a/2", "a/3", "a/4", "a/5",
    ]);
    await pushRecent(context as never, "a/6");
    const out = store[RECENTS_KEY] as string[];
    assert.strictEqual(out.length, RECENTS_MAX);
    assert.strictEqual(out[0], "a/6");
    assert.ok(!out.includes("a/5"));
  });

  it("survives a junk-shaped prior value by starting fresh", async () => {
    const { context, store } = fakeContext({ not: "an array" });
    await pushRecent(context as never, "Prod/Web");
    assert.deepStrictEqual(store[RECENTS_KEY], ["Prod/Web"]);
  });
});

describe("buildQuickConnectItems", () => {
  const cfg: CRTConfig = {
    folder: [
      {
        name: "Prod",
        nodes: [
          { name: "Web", endpoint: "deploy@prod-web" },
          { name: "DB", endpoint: "pg@prod-db:5432" },
        ],
      },
    ],
  };
  const flat = flattenConfigNodes(cfg);

  it("returns just the flat list (no separators) when there are no recents", () => {
    const items = buildQuickConnectItems(flat, []);
    assert.strictEqual(items.length, flat.length);
    assert.ok(items.every((i) => i.nodePath !== undefined));
    assert.deepStrictEqual(
      items.map((i) => i.label),
      ["Prod/Web", "Prod/DB"],
    );
  });

  it("prepends a Recent separator + rows + All separator when recents exist", () => {
    const items = buildQuickConnectItems(flat, ["Prod/DB"]);
    // "Recent" | "Prod/DB" | "All servers" | "Prod/Web" | "Prod/DB"
    assert.strictEqual(items.length, 5);
    assert.strictEqual(items[0].label, "Recent");
    assert.strictEqual(items[0].nodePath, undefined);
    assert.strictEqual(items[1].label, "Prod/DB");
    assert.strictEqual(items[1].nodePath, "Prod/DB");
    assert.strictEqual(items[2].label, "All servers");
    assert.strictEqual(items[2].nodePath, undefined);
    assert.strictEqual(items[3].nodePath, "Prod/Web");
    assert.strictEqual(items[4].nodePath, "Prod/DB");
  });

  it("silently drops stale recents that no longer appear in flat", () => {
    const items = buildQuickConnectItems(flat, ["ghost/path", "Prod/Web"]);
    const recentRows = items.filter((i) => i.nodePath !== undefined)
      .slice(0, 1);
    assert.strictEqual(recentRows[0].nodePath, "Prod/Web");
  });

  it("renders user@host with non-default port in description", () => {
    const items = buildQuickConnectItems(flat, []);
    const db = items.find((i) => i.label === "Prod/DB");
    assert.ok(db);
    assert.strictEqual(db.description, "pg@prod-db:5432");
  });

  it("omits the default port :22 from description", () => {
    const items = buildQuickConnectItems(flat, []);
    const web = items.find((i) => i.label === "Prod/Web");
    assert.ok(web);
    assert.strictEqual(web.description, "deploy@prod-web");
  });
});
