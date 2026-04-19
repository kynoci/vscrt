import * as assert from "assert";
import * as path from "path";
import {
  BACKUPS_SUBFOLDER,
  CONFIG_FILENAME,
  CONNECTION_LOG_FILENAME,
  SESSIONS_SUBFOLDER,
  VSCRT_HOME_NAME,
  vscrtBackupsDir,
  vscrtConfigFilePath,
  vscrtConnectionLogPath,
  vscrtHomeDir,
  vscrtSessionsDir,
} from "../fsPaths";

describe("fsPaths", () => {
  const fakeHome = "/home/alice";
  const sep = path.sep;

  it("exposes stable constant names", () => {
    assert.strictEqual(VSCRT_HOME_NAME, ".vscrt");
    assert.strictEqual(CONFIG_FILENAME, "vscrtConfig.json");
    assert.strictEqual(BACKUPS_SUBFOLDER, "backups");
    assert.strictEqual(SESSIONS_SUBFOLDER, "sessions");
    assert.strictEqual(CONNECTION_LOG_FILENAME, "connections.log");
  });

  it("vscrtHomeDir joins HOME with .vscrt", () => {
    assert.strictEqual(vscrtHomeDir(fakeHome), `/home/alice${sep}.vscrt`);
  });

  it("vscrtConfigFilePath returns the main config path", () => {
    const p = vscrtConfigFilePath(fakeHome);
    assert.ok(p.endsWith(`${sep}.vscrt${sep}vscrtConfig.json`));
  });

  it("vscrtBackupsDir returns the backups directory", () => {
    const p = vscrtBackupsDir(fakeHome);
    assert.ok(p.endsWith(`${sep}.vscrt${sep}backups`));
  });

  it("vscrtSessionsDir returns the sessions directory", () => {
    const p = vscrtSessionsDir(fakeHome);
    assert.ok(p.endsWith(`${sep}.vscrt${sep}sessions`));
  });

  it("vscrtConnectionLogPath returns the connection log file path", () => {
    const p = vscrtConnectionLogPath(fakeHome);
    assert.ok(p.endsWith(`${sep}.vscrt${sep}connections.log`));
  });

  it("each path is rooted under vscrtHomeDir", () => {
    const home = vscrtHomeDir(fakeHome);
    assert.ok(vscrtConfigFilePath(fakeHome).startsWith(home));
    assert.ok(vscrtBackupsDir(fakeHome).startsWith(home));
    assert.ok(vscrtSessionsDir(fakeHome).startsWith(home));
    assert.ok(vscrtConnectionLogPath(fakeHome).startsWith(home));
  });

  it("accepts different HOME values independently", () => {
    const a = vscrtHomeDir("/home/a");
    const b = vscrtHomeDir("/home/b");
    assert.notStrictEqual(a, b);
    assert.ok(a.includes("/home/a"));
    assert.ok(b.includes("/home/b"));
  });

  it("default-parameter paths fall back to os.homedir()", () => {
    // Smoke: calling without a home still returns a string.
    const p = vscrtConfigFilePath();
    assert.ok(typeof p === "string");
    assert.ok(p.endsWith("vscrtConfig.json"));
  });
});
