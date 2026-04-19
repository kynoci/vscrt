import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CONNECTION_LOG_FILENAME,
  CONNECTION_LOG_MAX_BYTES,
  CONNECTION_LOG_ROTATED_SUFFIX,
  appendEntry,
  makeEntry,
  maybeRotate,
  parseConnectionLogMode,
  readLastN,
  shapeEntryForDisk,
} from "../remote";

function freshHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function logPath(home: string): string {
  return path.join(home, ".vscrt", CONNECTION_LOG_FILENAME);
}

describe("parseConnectionLogMode", () => {
  it("accepts valid values", () => {
    assert.strictEqual(parseConnectionLogMode("off"), "off");
    assert.strictEqual(parseConnectionLogMode("minimal"), "minimal");
    assert.strictEqual(parseConnectionLogMode("verbose"), "verbose");
  });

  it("defaults to 'off' for unknown / missing values", () => {
    assert.strictEqual(parseConnectionLogMode(undefined), "off");
    assert.strictEqual(parseConnectionLogMode(""), "off");
    assert.strictEqual(parseConnectionLogMode("bogus"), "off");
    assert.strictEqual(parseConnectionLogMode(42), "off");
  });
});

describe("shapeEntryForDisk", () => {
  const full = makeEntry(
    new Date("2026-04-16T12:00:00Z"),
    "prod-web",
    "publickey",
    "started",
    {
      endpoint: "deploy@prod-web:22",
      elapsedMs: 1234,
      errorMessage: "permission denied",
    },
  );

  it("returns null when logging is off", () => {
    assert.strictEqual(shapeEntryForDisk(full, "off"), null);
  });

  it("strips endpoint + errorMessage in minimal mode", () => {
    const out = shapeEntryForDisk(full, "minimal")!;
    assert.strictEqual(out.serverName, "prod-web");
    assert.strictEqual(out.authMode, "publickey");
    assert.strictEqual(out.outcome, "started");
    assert.strictEqual(out.elapsedMs, 1234);
    assert.strictEqual(out.endpoint, undefined);
    assert.strictEqual(out.errorMessage, undefined);
  });

  it("preserves all fields in verbose mode", () => {
    const out = shapeEntryForDisk(full, "verbose")!;
    assert.strictEqual(out.endpoint, "deploy@prod-web:22");
    assert.strictEqual(out.errorMessage, "permission denied");
  });

  it("passes sessionKind through in minimal mode (non-default only)", () => {
    const sftpEntry = makeEntry(
      new Date(),
      "prod-web",
      "publickey",
      "started",
      { sessionKind: "sftp" },
    );
    const out = shapeEntryForDisk(sftpEntry, "minimal")!;
    assert.strictEqual(out.sessionKind, "sftp");
  });

  it("omits sessionKind from minimal output when value is the default 'ssh'", () => {
    const sshEntry = makeEntry(
      new Date(),
      "prod-web",
      "publickey",
      "started",
      { sessionKind: "ssh" },
    );
    const out = shapeEntryForDisk(sshEntry, "minimal")!;
    assert.strictEqual(out.sessionKind, undefined);
  });

  it("preserves sessionKind in verbose mode", () => {
    const sftpEntry = makeEntry(
      new Date(),
      "prod-web",
      "publickey",
      "started",
      { endpoint: "u@h:22", sessionKind: "sftp" },
    );
    const out = shapeEntryForDisk(sftpEntry, "verbose")!;
    assert.strictEqual(out.sessionKind, "sftp");
  });

  // action / remotePath (sftp file-op rows) --------------------------

  it("passes `action` through in minimal mode (cheap enum, kept for filtering)", () => {
    const entry = makeEntry(new Date(), "s", "sftp-browser", "connected", {
      sessionKind: "sftp",
      action: "upload",
    });
    const out = shapeEntryForDisk(entry, "minimal")!;
    assert.strictEqual(out.action, "upload");
  });

  it("passes `action` through in verbose mode", () => {
    const entry = makeEntry(new Date(), "s", "sftp-browser", "connected", {
      sessionKind: "sftp",
      action: "download",
    });
    const out = shapeEntryForDisk(entry, "verbose")!;
    assert.strictEqual(out.action, "download");
  });

  it("drops `remotePath` in minimal mode (user-controlled — treat as sensitive)", () => {
    const entry = makeEntry(new Date(), "s", "sftp-browser", "connected", {
      sessionKind: "sftp",
      action: "download",
      remotePath: "/home/alice/confidential/keys.txt",
    });
    const out = shapeEntryForDisk(entry, "minimal")!;
    assert.strictEqual(out.remotePath, undefined);
    // action still present — safe enum
    assert.strictEqual(out.action, "download");
  });

  it("preserves `remotePath` in verbose mode", () => {
    const entry = makeEntry(new Date(), "s", "sftp-browser", "connected", {
      sessionKind: "sftp",
      action: "delete",
      remotePath: "/tmp/gone.log",
    });
    const out = shapeEntryForDisk(entry, "verbose")!;
    assert.strictEqual(out.remotePath, "/tmp/gone.log");
  });

  it("makeEntry propagates `action` + `remotePath` into the built entry", () => {
    const entry = makeEntry(
      new Date("2026-04-17T12:00:00Z"),
      "prod-web",
      "sftp-browser",
      "connected",
      {
        sessionKind: "sftp",
        action: "chmod",
        remotePath: "/var/log/app.log",
      },
    );
    assert.strictEqual(entry.sessionKind, "sftp");
    assert.strictEqual(entry.action, "chmod");
    assert.strictEqual(entry.remotePath, "/var/log/app.log");
  });
});

describe("appendEntry + readLastN", () => {
  let home: string;

  beforeEach(() => {
    home = freshHome("vscrt-connlog-");
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("writes one JSONL line per entry and reads them back", async () => {
    await appendEntry(
      home,
      makeEntry(new Date(), "alpha", "publickey", "started"),
      "minimal",
    );
    await appendEntry(
      home,
      makeEntry(new Date(), "beta", "agent", "connected", { elapsedMs: 42 }),
      "minimal",
    );
    const entries = await readLastN(home);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].serverName, "alpha");
    assert.strictEqual(entries[1].serverName, "beta");
    assert.strictEqual(entries[1].elapsedMs, 42);
  });

  it("is a no-op when mode is 'off'", async () => {
    await appendEntry(
      home,
      makeEntry(new Date(), "alpha", "publickey", "started"),
      "off",
    );
    assert.strictEqual(fs.existsSync(logPath(home)), false);
  });

  it("does not persist endpoint/errorMessage in minimal mode", async () => {
    await appendEntry(
      home,
      makeEntry(new Date(), "alpha", "publickey", "failed", {
        endpoint: "deploy@prod-web:22",
        errorMessage: "permission denied",
      }),
      "minimal",
    );
    const raw = fs.readFileSync(logPath(home), "utf-8");
    assert.ok(!raw.includes("deploy@prod-web"));
    assert.ok(!raw.includes("permission denied"));
  });

  it("persists endpoint/errorMessage in verbose mode", async () => {
    await appendEntry(
      home,
      makeEntry(new Date(), "alpha", "publickey", "failed", {
        endpoint: "deploy@prod-web:22",
        errorMessage: "permission denied",
      }),
      "verbose",
    );
    const raw = fs.readFileSync(logPath(home), "utf-8");
    assert.ok(raw.includes("deploy@prod-web"));
    assert.ok(raw.includes("permission denied"));
  });

  it("returns [] when the log file does not exist yet", async () => {
    assert.deepStrictEqual(await readLastN(home), []);
  });

  it("tolerates a corrupted line without crashing", async () => {
    await appendEntry(
      home,
      makeEntry(new Date(), "alpha", "publickey", "started"),
      "minimal",
    );
    fs.appendFileSync(logPath(home), "{ not json\n");
    await appendEntry(
      home,
      makeEntry(new Date(), "beta", "agent", "connected"),
      "minimal",
    );
    const entries = await readLastN(home);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].serverName, "alpha");
    assert.strictEqual(entries[1].serverName, "beta");
  });
});

describe("maybeRotate", () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = freshHome("vscrt-rotate-");
    file = path.join(home, "connections.log");
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("does nothing when the file is under the cap", async () => {
    fs.writeFileSync(file, "small");
    await maybeRotate(file);
    assert.strictEqual(fs.existsSync(file), true);
    assert.strictEqual(
      fs.existsSync(file + CONNECTION_LOG_ROTATED_SUFFIX),
      false,
    );
  });

  it("rotates once the cap is exceeded", async () => {
    fs.writeFileSync(file, Buffer.alloc(CONNECTION_LOG_MAX_BYTES + 1));
    await maybeRotate(file);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(
      fs.existsSync(file + CONNECTION_LOG_ROTATED_SUFFIX),
      true,
    );
  });
});
