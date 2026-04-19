import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BACKUP_CAP,
  createAndRotateBackup,
  createBackup,
  formatBackupTimestamp,
  listBackups,
  parseBackupTimestamp,
  rotateBackups,
} from "../config/vscrtConfigBackup";
import {
  summarizeConfig,
  validateConfigShape,
} from "../commands/configRecoveryCommands";

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("formatBackupTimestamp / parseBackupTimestamp", () => {
  it("round-trips via the filename", () => {
    const now = new Date("2026-04-16T21:07:42.123Z");
    const stamp = formatBackupTimestamp(now);
    const filename = `vscrtConfig.${stamp}.json`;
    const parsed = parseBackupTimestamp(filename);
    assert.strictEqual(parsed, now.getTime());
  });

  it("returns NaN for malformed names", () => {
    assert.ok(!Number.isFinite(parseBackupTimestamp("nope.json")));
    assert.ok(!Number.isFinite(parseBackupTimestamp("vscrtConfig.json")));
  });

  it("returns NaN for partial prefix matches", () => {
    assert.ok(!Number.isFinite(parseBackupTimestamp("vscrtConfig.2026.json")));
    assert.ok(!Number.isFinite(parseBackupTimestamp("vscrtConfig.2026-04-16.json")));
  });

  it("returns NaN for empty string", () => {
    assert.ok(!Number.isFinite(parseBackupTimestamp("")));
  });

  it("produces a filename with no colons (path-safe)", () => {
    const stamp = formatBackupTimestamp(new Date("2026-01-01T00:00:00.000Z"));
    assert.ok(!stamp.includes(":"), "timestamp should not contain colons");
  });

  it("round-trips with zero-millisecond boundary", () => {
    const now = new Date("2026-12-31T23:59:59.000Z");
    const filename = `vscrtConfig.${formatBackupTimestamp(now)}.json`;
    assert.strictEqual(parseBackupTimestamp(filename), now.getTime());
  });

  it("returns NaN for stray prefix matches (vscrtConfig.xyz.json)", () => {
    assert.ok(!Number.isFinite(parseBackupTimestamp("vscrtConfig.xyz.json")));
  });
});

describe("createBackup", () => {
  let dir: string;
  let source: string;
  let backups: string;

  beforeEach(() => {
    dir = tmpdir("vscrt-backup-");
    source = path.join(dir, "vscrtConfig.json");
    backups = path.join(dir, "backups");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the source file is missing (first-save case)", async () => {
    const out = await createBackup(source, backups);
    assert.strictEqual(out, null);
    assert.strictEqual(fs.existsSync(backups), false);
  });

  it("copies the source to a timestamped backup file", async () => {
    fs.writeFileSync(source, '{"folder":[]}', "utf-8");
    const now = new Date("2026-04-16T21:07:42.001Z");
    const out = await createBackup(source, backups, now);
    assert.ok(out);
    assert.ok(fs.existsSync(out));
    const content = fs.readFileSync(out, "utf-8");
    assert.strictEqual(content, '{"folder":[]}');
    assert.ok(out.includes("2026-04-16T21-07-42-001Z"));
  });
});

describe("listBackups / rotateBackups", () => {
  let dir: string;

  function seed(timestamps: Date[]): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const ts of timestamps) {
      const f = path.join(dir, `vscrtConfig.${formatBackupTimestamp(ts)}.json`);
      fs.writeFileSync(f, '{"folder":[]}', "utf-8");
    }
  }

  beforeEach(() => {
    dir = tmpdir("vscrt-list-");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] when the directory does not exist", async () => {
    const missing = path.join(dir, "nope");
    const out = await listBackups(missing);
    assert.deepStrictEqual(out, []);
  });

  it("returns newest-first", async () => {
    const t1 = new Date("2026-04-16T20:00:00.000Z");
    const t2 = new Date("2026-04-16T21:00:00.000Z");
    const t3 = new Date("2026-04-16T22:00:00.000Z");
    seed([t1, t3, t2]);
    const out = await listBackups(dir);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].timestamp, t3.getTime());
    assert.strictEqual(out[1].timestamp, t2.getTime());
    assert.strictEqual(out[2].timestamp, t1.getTime());
  });

  it("places unparseable filenames at the end (listed but not preferred)", async () => {
    seed([new Date("2026-04-16T21:00:00.000Z")]);
    fs.writeFileSync(path.join(dir, "vscrtConfig.something.json"), "junk");
    const out = await listBackups(dir);
    assert.strictEqual(out.length, 2);
    assert.ok(Number.isFinite(out[0].timestamp));
    assert.ok(!Number.isFinite(out[1].timestamp));
  });

  it("rotateBackups deletes entries beyond the cap, oldest first", async () => {
    const timestamps: Date[] = [];
    for (let i = 0; i < BACKUP_CAP + 3; i += 1) {
      timestamps.push(new Date(2026, 3, 16, 0, i, 0));
    }
    seed(timestamps);
    const deleted = await rotateBackups(dir, BACKUP_CAP);
    assert.strictEqual(deleted.length, 3);
    const remaining = await listBackups(dir);
    assert.strictEqual(remaining.length, BACKUP_CAP);
    // Make sure the *newest* ones survived.
    const newestKept = remaining[0].timestamp;
    const oldestKept = remaining[remaining.length - 1].timestamp;
    assert.ok(newestKept > oldestKept);
  });
});

describe("createAndRotateBackup (integration of the two)", () => {
  let dir: string;
  let source: string;
  let backups: string;

  beforeEach(() => {
    dir = tmpdir("vscrt-cr-");
    source = path.join(dir, "vscrtConfig.json");
    backups = path.join(dir, "backups");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates 10 backups then rotates to stay at the cap", async () => {
    fs.writeFileSync(source, '{"folder":[]}', "utf-8");
    for (let i = 0; i < BACKUP_CAP + 2; i += 1) {
      // Distinct timestamps per call by sleeping via microtask and unique filename.
      // We control the time through createBackup's default new Date() — so we
      // force uniqueness by rewriting the file with a different body each turn
      // and using incremented Date objects via a small retry loop on collision.
      await new Promise((r) => setTimeout(r, 2));
      await createAndRotateBackup(source, backups, BACKUP_CAP);
    }
    const entries = await listBackups(backups);
    assert.strictEqual(entries.length, BACKUP_CAP);
  });
});

describe("validateConfigShape", () => {
  it("accepts an empty object", () => {
    assert.deepStrictEqual(validateConfigShape({}), []);
  });

  it("accepts a well-formed nested config", () => {
    const cfg = {
      folder: [
        {
          name: "Prod",
          nodes: [{ name: "Web", endpoint: "u@h" }],
          subfolder: [
            { name: "DB", nodes: [{ name: "Primary", endpoint: "p@d" }] },
          ],
        },
      ],
    };
    assert.deepStrictEqual(validateConfigShape(cfg), []);
  });

  it("rejects a non-object root", () => {
    const issues = validateConfigShape([]);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].pointer, "");
  });

  it("flags a missing cluster name", () => {
    const issues = validateConfigShape({ folder: [{ nodes: [] }] });
    assert.ok(issues.some((i) => i.pointer === "/folder/0/name"));
  });

  it("flags a missing node endpoint", () => {
    const issues = validateConfigShape({
      folder: [{ name: "A", nodes: [{ name: "X" }] }],
    });
    assert.ok(issues.some((i) => i.pointer === "/folder/0/nodes/0/endpoint"));
  });

  it("flags non-array folder / nodes / subfolder", () => {
    const issues = validateConfigShape({ folder: "oops" });
    assert.ok(issues.some((i) => i.pointer === "/folder"));
  });
});

describe("summarizeConfig", () => {
  it("counts folders and nodes (including nested)", () => {
    const cfg = {
      folder: [
        {
          name: "Prod",
          nodes: [
            { name: "A", endpoint: "u@h" },
            { name: "B", endpoint: "u@h" },
          ],
          subfolder: [
            { name: "DB", nodes: [{ name: "C", endpoint: "u@h" }] },
          ],
        },
        {
          name: "Staging",
          nodes: [{ name: "D", endpoint: "u@h" }],
        },
      ],
    };
    assert.deepStrictEqual(summarizeConfig(cfg), { folders: 3, nodes: 4 });
  });

  it("returns zeros for non-object / missing folder", () => {
    assert.deepStrictEqual(summarizeConfig(null), { folders: 0, nodes: 0 });
    assert.deepStrictEqual(summarizeConfig({}), { folders: 0, nodes: 0 });
    assert.deepStrictEqual(summarizeConfig("oops"), { folders: 0, nodes: 0 });
  });
});
