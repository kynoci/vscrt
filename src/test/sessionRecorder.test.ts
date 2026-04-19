import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  filenameFor,
  listSessionRecordings,
  parseSessionRecordingMode,
  slugifyName,
  writeSessionMetadata,
} from "../remote";

function freshHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("parseSessionRecordingMode", () => {
  it("accepts the three valid modes", () => {
    assert.strictEqual(parseSessionRecordingMode("off"), "off");
    assert.strictEqual(parseSessionRecordingMode("minimal"), "minimal");
    assert.strictEqual(parseSessionRecordingMode("full"), "full");
  });

  it("falls back to 'off' for anything else", () => {
    assert.strictEqual(parseSessionRecordingMode(undefined), "off");
    assert.strictEqual(parseSessionRecordingMode(""), "off");
    assert.strictEqual(parseSessionRecordingMode("partial"), "off");
    assert.strictEqual(parseSessionRecordingMode(42), "off");
  });
});

describe("slugifyName", () => {
  it("replaces non-alphanumerics with dashes", () => {
    assert.strictEqual(slugifyName("Prod Web #1"), "prod-web-1");
  });

  it("trims leading/trailing dashes", () => {
    assert.strictEqual(slugifyName("!!Prod!!"), "prod");
  });

  it("caps at 40 chars", () => {
    const out = slugifyName("a".repeat(60));
    assert.ok(out.length <= 40);
  });

  it("returns empty string for all-whitespace input", () => {
    assert.strictEqual(slugifyName("   "), "");
    assert.strictEqual(slugifyName(""), "");
  });

  it("preserves unicode alphanumerics by stripping them (ASCII-only slug)", () => {
    assert.strictEqual(slugifyName("prod-日本語"), "prod");
  });

  it("collapses consecutive separators", () => {
    assert.strictEqual(slugifyName("a - - b"), "a-b");
    assert.strictEqual(slugifyName("a   b"), "a-b");
  });
});

describe("filenameFor", () => {
  it("uses a colon-free timestamp prefix and `.meta.json` suffix", () => {
    const name = filenameFor({
      timestamp: "2026-04-17T12:34:56.789Z",
      serverName: "Prod Web",
      authMode: "publickey",
      mode: "minimal",
      pid: 123,
    });
    assert.ok(/^2026-04-17T12-34-56Z-prod-web-123\.meta\.json$/.test(name));
  });

  it("strips the milliseconds portion", () => {
    const name = filenameFor({
      timestamp: "2026-04-17T12:34:56.001Z",
      serverName: "x",
      authMode: "publickey",
      mode: "minimal",
      pid: 7,
    });
    assert.ok(!name.includes("001"));
  });

  it("includes the pid to disambiguate same-second sessions", () => {
    const name = filenameFor({
      timestamp: "2026-04-17T12:34:56.789Z",
      serverName: "x",
      authMode: "publickey",
      mode: "minimal",
      pid: 42,
    });
    assert.ok(name.includes("-42."));
  });
});

describe("writeSessionMetadata + listSessionRecordings", () => {
  let home: string;

  beforeEach(() => {
    home = freshHome("vscrt-sessions-");
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("writes a metadata file in minimal mode", async () => {
    const out = await writeSessionMetadata(
      {
        timestamp: new Date().toISOString(),
        serverName: "alpha",
        authMode: "publickey",
        mode: "minimal",
        pid: 42,
      },
      home,
    );
    assert.ok(out);
    assert.ok(fs.existsSync(out));
  });

  it("is a no-op in off mode", async () => {
    const out = await writeSessionMetadata(
      {
        timestamp: new Date().toISOString(),
        serverName: "alpha",
        authMode: "publickey",
        mode: "off",
        pid: 42,
      },
      home,
    );
    assert.strictEqual(out, null);
    assert.strictEqual(fs.existsSync(path.join(home, ".vscrt", "sessions")), false);
  });

  it("lists recordings newest-first", async () => {
    await writeSessionMetadata(
      {
        timestamp: "2026-04-17T10:00:00.000Z",
        serverName: "a",
        authMode: "publickey",
        mode: "minimal",
        pid: 1,
      },
      home,
    );
    await writeSessionMetadata(
      {
        timestamp: "2026-04-17T12:00:00.000Z",
        serverName: "b",
        authMode: "publickey",
        mode: "minimal",
        pid: 2,
      },
      home,
    );
    const entries = await listSessionRecordings(home);
    assert.strictEqual(entries.length, 2);
    assert.ok(entries[0].timestamp > entries[1].timestamp);
  });

  it("returns [] when the sessions dir doesn't exist", async () => {
    const entries = await listSessionRecordings(home);
    assert.deepStrictEqual(entries, []);
  });
});
