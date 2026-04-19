/**
 * Phase-8 regression guard — pure helper for the ⇆ Local QuickPick
 * candidate list (`src/commands/sftpBrowser/panelHost/localStartFolders.ts`).
 */
import * as assert from "assert";
import * as path from "path";
import {
  collectLocalStartCandidates,
  resolveDownloadsDir,
} from "../commands/sftpBrowser/panelHost/localStartFolders";

describe("resolveDownloadsDir", () => {
  it("uses ~/Downloads on macOS", () => {
    assert.strictEqual(
      resolveDownloadsDir("/Users/alice", "darwin", {}),
      path.join("/Users/alice", "Downloads"),
    );
  });

  it("uses ~/Downloads on Windows", () => {
    assert.strictEqual(
      resolveDownloadsDir("C:\\Users\\alice", "win32", {}),
      path.join("C:\\Users\\alice", "Downloads"),
    );
  });

  it("respects $XDG_DOWNLOAD_DIR on Linux", () => {
    assert.strictEqual(
      resolveDownloadsDir("/home/alice", "linux", {
        XDG_DOWNLOAD_DIR: "/mnt/data/dl",
      }),
      "/mnt/data/dl",
    );
  });

  it("falls back to ~/Downloads on Linux without XDG_DOWNLOAD_DIR", () => {
    assert.strictEqual(
      resolveDownloadsDir("/home/alice", "linux", {}),
      path.join("/home/alice", "Downloads"),
    );
  });

  it("also reads XDG on BSD variants", () => {
    assert.strictEqual(
      resolveDownloadsDir("/home/alice", "freebsd", {
        XDG_DOWNLOAD_DIR: "/tmp/dl",
      }),
      "/tmp/dl",
    );
  });

  it("ignores empty/whitespace XDG_DOWNLOAD_DIR", () => {
    assert.strictEqual(
      resolveDownloadsDir("/home/alice", "linux", {
        XDG_DOWNLOAD_DIR: "   ",
      }),
      path.join("/home/alice", "Downloads"),
    );
  });
});

describe("collectLocalStartCandidates", () => {
  it("returns Downloads + Home + Custom when no workspace + no last-path", () => {
    const out = collectLocalStartCandidates({
      homeDir: "/home/alice",
      platform: "linux",
      env: {},
    });
    const ids = out.map((c) => c.id);
    assert.deepStrictEqual(ids, ["downloads", "home", "custom"]);
  });

  it("prepends every workspace folder (multi-root respected)", () => {
    const out = collectLocalStartCandidates({
      homeDir: "/home/alice",
      platform: "linux",
      env: {},
      workspace: [
        { name: "api", uri: { fsPath: "/work/api" } },
        { name: "web", uri: { fsPath: "/work/web" } },
      ],
    });
    assert.strictEqual(out[0].id, "workspace");
    assert.strictEqual(out[0].description, "/work/api");
    assert.strictEqual(out[1].id, "workspace");
    assert.strictEqual(out[1].description, "/work/web");
  });

  it("inserts a Last-location row when lastPath is non-empty", () => {
    const out = collectLocalStartCandidates({
      homeDir: "/home/alice",
      platform: "linux",
      env: {},
      lastPath: "/tmp/some/recent",
    });
    const last = out.find((c) => c.id === "last");
    assert.ok(last);
    assert.strictEqual(last?.path, "/tmp/some/recent");
  });

  it("omits the Last-location row when lastPath is undefined or whitespace", () => {
    const noLast = collectLocalStartCandidates({
      homeDir: "/h",
      platform: "linux",
      env: {},
      lastPath: undefined,
    });
    assert.ok(!noLast.some((c) => c.id === "last"));
    const blank = collectLocalStartCandidates({
      homeDir: "/h",
      platform: "linux",
      env: {},
      lastPath: "   ",
    });
    assert.ok(!blank.some((c) => c.id === "last"));
  });

  it("always ends with the Choose-folder escape hatch", () => {
    const out = collectLocalStartCandidates({
      homeDir: "/h",
      platform: "linux",
      env: {},
      lastPath: "/tmp",
    });
    assert.strictEqual(out[out.length - 1].id, "custom");
  });

  it("Downloads candidate uses XDG override on Linux", () => {
    const out = collectLocalStartCandidates({
      homeDir: "/home/alice",
      platform: "linux",
      env: { XDG_DOWNLOAD_DIR: "/mnt/dl" },
    });
    const downloads = out.find((c) => c.id === "downloads");
    assert.strictEqual(downloads?.path, "/mnt/dl");
  });

  it("skips workspace entries with malformed uri shapes", () => {
    const out = collectLocalStartCandidates({
      homeDir: "/h",
      platform: "linux",
      env: {},
      // Intentionally malformed — defensive against bad stubs.
      workspace: [
        // @ts-expect-error — exercising the guard
        { name: "bad" },
        { name: "ok", uri: { fsPath: "/work/ok" } },
      ],
    });
    const wsRows = out.filter((c) => c.id === "workspace");
    assert.strictEqual(wsRows.length, 1);
    assert.strictEqual(wsRows[0].description, "/work/ok");
  });

  it("icon names are codicon keys, not emoji", () => {
    const out = collectLocalStartCandidates({
      homeDir: "/h",
      platform: "linux",
      env: {},
      lastPath: "/a",
    });
    for (const c of out) {
      assert.match(c.icon, /^[a-z][a-z0-9-]*$/, `icon "${c.icon}"`);
    }
  });
});
