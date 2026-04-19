import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  SHARED_FOLDER_NAME,
  buildSharedFolder,
  isSharedPath,
  mergeSharedIntoConfig,
  readSharedConfigFile,
  resolveSharedConfigPath,
  sanitizeSharedCluster,
  sanitizeSharedNode,
  stripSharedFolder,
} from "../config/sharedConfig";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
} from "../config/vscrtConfigTypes";

describe("sharedConfig", () => {
  describe("isSharedPath", () => {
    it("matches the bare shared folder", () => {
      assert.strictEqual(isSharedPath(SHARED_FOLDER_NAME), true);
    });
    it("matches descendants of the shared folder", () => {
      assert.strictEqual(
        isSharedPath(`${SHARED_FOLDER_NAME}/Prod/Web 1`),
        true,
      );
    });
    it("rejects paths that are prefix-similar but not shared", () => {
      assert.strictEqual(isSharedPath(`${SHARED_FOLDER_NAME}X/Foo`), false);
      assert.strictEqual(isSharedPath("Production/Web"), false);
    });
    it("handles null / empty", () => {
      assert.strictEqual(isSharedPath(null), false);
      assert.strictEqual(isSharedPath(undefined), false);
      assert.strictEqual(isSharedPath(""), false);
    });
  });

  describe("sanitizeSharedNode", () => {
    it("drops password, passwordStorage, passwordDelivery", () => {
      const input: CRTConfigNode = {
        name: "n",
        endpoint: "u@h",
        password: "@secret:xxx",
        passwordStorage: "passphrase",
        passwordDelivery: "tempfile",
      };
      const out = sanitizeSharedNode(input);
      assert.strictEqual(out.password, undefined);
      assert.strictEqual(out.passwordStorage, undefined);
      assert.strictEqual(out.passwordDelivery, undefined);
    });
    it("coerces password auth to publickey", () => {
      const out = sanitizeSharedNode({
        name: "n",
        endpoint: "u@h",
        preferredAuthentication: "password",
      });
      assert.strictEqual(out.preferredAuthentication, "publickey");
    });
    it("preserves publickey + identityFile untouched", () => {
      const out = sanitizeSharedNode({
        name: "n",
        endpoint: "u@h",
        preferredAuthentication: "publickey",
        identityFile: "~/.ssh/id_ed25519",
      });
      assert.strictEqual(out.preferredAuthentication, "publickey");
      assert.strictEqual(out.identityFile, "~/.ssh/id_ed25519");
    });
    it("does not mutate the input", () => {
      const input: CRTConfigNode = {
        name: "n",
        endpoint: "u@h",
        password: "@secret:yyy",
      };
      sanitizeSharedNode(input);
      assert.strictEqual(input.password, "@secret:yyy");
    });
  });

  describe("sanitizeSharedCluster", () => {
    it("recursively sanitizes nested subfolders", () => {
      const input: CRTConfigCluster = {
        name: "Root",
        nodes: [
          { name: "a", endpoint: "u@h", password: "@secret:1" },
        ],
        subfolder: [
          {
            name: "Child",
            nodes: [
              { name: "b", endpoint: "u@h", password: "enc:v4:..." },
            ],
          },
        ],
      };
      const out = sanitizeSharedCluster(input);
      assert.strictEqual(out.nodes?.[0].password, undefined);
      assert.strictEqual(out.subfolder?.[0].nodes?.[0].password, undefined);
    });
    it("preserves icon when present", () => {
      const out = sanitizeSharedCluster({
        name: "Root",
        icon: "folder-library",
      });
      assert.strictEqual(out.icon, "folder-library");
    });
  });

  describe("buildSharedFolder", () => {
    it("returns undefined when every source is empty", () => {
      assert.strictEqual(buildSharedFolder([]), undefined);
      assert.strictEqual(buildSharedFolder([[]]), undefined);
    });
    it("flattens clusters from multiple files into one synthetic folder", () => {
      const folder = buildSharedFolder([
        [{ name: "TeamA" }],
        [{ name: "TeamB" }],
      ]);
      assert.strictEqual(folder?.name, SHARED_FOLDER_NAME);
      assert.strictEqual(folder?.icon, "lock");
      assert.strictEqual(folder?.subfolder?.length, 2);
      assert.deepStrictEqual(
        folder?.subfolder?.map((c) => c.name),
        ["TeamA", "TeamB"],
      );
    });
  });

  describe("mergeSharedIntoConfig", () => {
    it("appends the shared folder after the personal ones", () => {
      const user: CRTConfig = {
        folder: [{ name: "Personal" }],
      };
      const merged = mergeSharedIntoConfig(user, [[{ name: "TeamA" }]]);
      assert.deepStrictEqual(
        merged.folder?.map((c) => c.name),
        ["Personal", SHARED_FOLDER_NAME],
      );
    });
    it("is a no-op when no shared clusters exist", () => {
      const user: CRTConfig = { folder: [{ name: "Personal" }] };
      const merged = mergeSharedIntoConfig(user, []);
      assert.strictEqual(merged, user);
    });
    it("drops a stale shared folder from the personal tree before re-appending", () => {
      const user: CRTConfig = {
        folder: [
          { name: "Personal" },
          { name: SHARED_FOLDER_NAME, subfolder: [{ name: "OldStale" }] },
        ],
      };
      const merged = mergeSharedIntoConfig(user, [[{ name: "NewTeam" }]]);
      const sharedFolder = merged.folder?.find(
        (c) => c.name === SHARED_FOLDER_NAME,
      );
      assert.strictEqual(sharedFolder?.subfolder?.length, 1);
      assert.strictEqual(sharedFolder?.subfolder?.[0].name, "NewTeam");
    });
    it("does not mutate the original config", () => {
      const user: CRTConfig = { folder: [{ name: "Personal" }] };
      const clone = JSON.parse(JSON.stringify(user));
      mergeSharedIntoConfig(user, [[{ name: "TeamA" }]]);
      assert.deepStrictEqual(user, clone);
    });
  });

  describe("stripSharedFolder", () => {
    it("removes the shared folder so save never persists it", () => {
      const merged: CRTConfig = {
        folder: [
          { name: "Personal" },
          { name: SHARED_FOLDER_NAME, subfolder: [{ name: "X" }] },
        ],
      };
      const stripped = stripSharedFolder(merged);
      assert.deepStrictEqual(
        stripped.folder?.map((c) => c.name),
        ["Personal"],
      );
    });
    it("is a reference-identity no-op when there is no shared folder", () => {
      const personal: CRTConfig = { folder: [{ name: "A" }] };
      assert.strictEqual(stripSharedFolder(personal), personal);
    });
  });

  describe("resolveSharedConfigPath", () => {
    it("expands a leading ~/", () => {
      assert.strictEqual(
        resolveSharedConfigPath("~/team.json", "/home/alice"),
        path.join("/home/alice", "team.json"),
      );
    });
    it("passes absolute paths through unchanged", () => {
      assert.strictEqual(
        resolveSharedConfigPath("/etc/vscrt/shared.json", "/home/alice"),
        "/etc/vscrt/shared.json",
      );
    });
    it("does not expand ~ inside the path", () => {
      assert.strictEqual(
        resolveSharedConfigPath("/foo/~/bar.json", "/home/alice"),
        "/foo/~/bar.json",
      );
    });
  });

  describe("readSharedConfigFile", () => {
    const tmpDir = path.join(os.tmpdir(), `vscrt-shared-${Date.now()}`);
    before(async () => {
      await fs.mkdir(tmpDir, { recursive: true });
    });
    after(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("reads + sanitizes a valid config", async () => {
      const p = path.join(tmpDir, "ok.json");
      await fs.writeFile(
        p,
        JSON.stringify({
          folder: [
            {
              name: "Prod",
              nodes: [
                {
                  name: "web",
                  endpoint: "u@h",
                  password: "@secret:zzz",
                  preferredAuthentication: "password",
                },
              ],
            },
          ],
        }),
      );
      const out = await readSharedConfigFile(p);
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].name, "Prod");
      const node = out[0].nodes?.[0];
      assert.strictEqual(node?.password, undefined);
      assert.strictEqual(node?.preferredAuthentication, "publickey");
    });

    it("invokes onError and returns [] on malformed JSON", async () => {
      const p = path.join(tmpDir, "bad.json");
      await fs.writeFile(p, "{ not-json");
      let caught: unknown = null;
      const out = await readSharedConfigFile(p, (err) => {
        caught = err;
      });
      assert.deepStrictEqual(out, []);
      assert.ok(caught instanceof Error);
    });

    it("invokes onError and returns [] when the file is missing", async () => {
      let caught: unknown = null;
      const out = await readSharedConfigFile(
        path.join(tmpDir, "does-not-exist.json"),
        (err) => {
          caught = err;
        },
      );
      assert.deepStrictEqual(out, []);
      assert.ok(caught);
    });

    it("returns [] for a file without a folder[] array", async () => {
      const p = path.join(tmpDir, "no-folder.json");
      await fs.writeFile(p, JSON.stringify({ folder: "oops" }));
      const out = await readSharedConfigFile(p);
      assert.deepStrictEqual(out, []);
    });
  });
});
