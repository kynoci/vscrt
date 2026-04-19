import * as assert from "assert";
import {
  formatBytes,
  formatDurationClock,
  formatTransferProgress,
} from "../commands/sftpBrowser/progress/formatters";

describe("formatBytes", () => {
  it("uses bytes below 1 KB", () => {
    assert.strictEqual(formatBytes(0), "0 B");
    assert.strictEqual(formatBytes(512), "512 B");
    assert.strictEqual(formatBytes(1023), "1023 B");
  });
  it("promotes to KB, MB, GB, TB", () => {
    assert.strictEqual(formatBytes(1024), "1.0 KB");
    assert.strictEqual(formatBytes(1024 * 1024), "1.0 MB");
    assert.strictEqual(formatBytes(1024 ** 3), "1.0 GB");
    assert.strictEqual(formatBytes(1024 ** 4), "1.0 TB");
  });
  it("drops the decimal once the value reaches 10 in a unit", () => {
    assert.strictEqual(formatBytes(10 * 1024), "10 KB");
    assert.strictEqual(formatBytes(99 * 1024 * 1024), "99 MB");
  });
  it("returns empty for NaN / negative", () => {
    assert.strictEqual(formatBytes(NaN), "");
    assert.strictEqual(formatBytes(-1), "");
  });
});

describe("formatDurationClock", () => {
  it("formats sub-hour as MM:SS", () => {
    assert.strictEqual(formatDurationClock(0), "00:00");
    assert.strictEqual(formatDurationClock(5), "00:05");
    assert.strictEqual(formatDurationClock(65), "01:05");
    assert.strictEqual(formatDurationClock(59 * 60 + 59), "59:59");
  });
  it("includes the hour once past 60 min", () => {
    assert.strictEqual(formatDurationClock(3600), "1:00:00");
    assert.strictEqual(formatDurationClock(3661), "1:01:01");
  });
  it("returns an em-dash for non-finite / negative inputs", () => {
    assert.strictEqual(formatDurationClock(NaN), "—");
    assert.strictEqual(formatDurationClock(-5), "—");
  });
});

describe("formatTransferProgress", () => {
  it("shows only elapsed when no bytes have transferred", () => {
    assert.match(formatTransferProgress(0, 1_000_000, 3), /elapsed/);
    assert.match(formatTransferProgress(0, 1_000_000, 3), /00:03/);
  });

  it("shows bytes + rate when bytes flow but total is unknown", () => {
    // 1 MB in 2 seconds → 512 KB/s
    const s = formatTransferProgress(1_048_576, 0, 2);
    assert.match(s, /1\.0 MB/);
    assert.match(s, /KB\/s|MB\/s/);
    assert.ok(!/ETA/.test(s), "unknown total should not show ETA");
  });

  it("shows bytes + percent + rate + ETA when total is known", () => {
    // 512 KB of 1 MB (binary units) → exactly 50%, ETA ~1s at 512 KB/s.
    const s = formatTransferProgress(512 * 1024, 1024 * 1024, 1);
    assert.match(s, /512 KB \/ 1\.0 MB/);
    assert.match(s, /\(50%\)/);
    assert.match(s, /KB\/s/);
    assert.match(s, /ETA/);
  });

  it("caps percent at 100 once bytes overruns total", () => {
    // Happens on the last tick of a fast transfer where the local file
    // grew past the remote-reported size (directory entries can lag).
    const s = formatTransferProgress(2_000_000, 1_000_000, 1);
    assert.match(s, /\(100%\)/);
  });
});
