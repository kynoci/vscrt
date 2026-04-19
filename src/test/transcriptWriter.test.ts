import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gunzipSync } from "zlib";
import {
  filenameForTranscript,
  openTranscript,
} from "../remote";

describe("filenameForTranscript", () => {
  it("builds a sortable filename with slug + pid + gz suffix", () => {
    const name = filenameForTranscript(
      "Prod Web #1",
      1234,
      new Date("2026-04-17T12:34:56Z"),
    );
    assert.match(
      name,
      /^2026-04-17T12-34-56Z-prod-web-1-1234\.log\.gz$/,
    );
  });

  it("sanitises special characters", () => {
    const name = filenameForTranscript("!!!bad*name!!!", 1, new Date(0));
    assert.match(name, /-bad-name-1\.log\.gz$/);
  });
});

describe("openTranscript", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-tx-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("writes gzipped output that gunzips back to the original", async () => {
    const w = await openTranscript({ serverName: "alpha", pid: 42, home });
    w.append("hello ");
    w.append(Buffer.from("world\n"));
    w.append("second line\n");
    await w.close();

    assert.ok(fs.existsSync(w.filePath));
    const gz = fs.readFileSync(w.filePath);
    const plain = gunzipSync(gz).toString("utf-8");
    assert.strictEqual(plain, "hello world\nsecond line\n");
  });

  it("is safe to close twice", async () => {
    const w = await openTranscript({ serverName: "beta", pid: 1, home });
    w.append("x");
    await w.close();
    await w.close(); // second call must not throw
  });

  it("places the file under ~/.vscrt/sessions/", async () => {
    const w = await openTranscript({ serverName: "gamma", pid: 99, home });
    await w.close();
    const expectedDir = path.join(home, ".vscrt", "sessions");
    assert.ok(w.filePath.startsWith(expectedDir));
  });
});
