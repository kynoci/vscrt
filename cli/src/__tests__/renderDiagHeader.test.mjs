import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDiagHeader } from "../../out/commands.js";

test("renderDiagHeader: includes the ISO timestamp", () => {
  const out = renderDiagHeader({
    timestamp: new Date("2026-04-17T09:00:00Z"),
    nodeVersion: "v22.0.0",
    platform: "linux",
    arch: "x64",
    osRelease: "6.17.0",
    cpuCount: 8,
    home: "/home/alice",
  });
  assert.ok(out.some((l) => l.includes("2026-04-17T09:00:00")));
});

test("renderDiagHeader: starts with the '# vscrt diagnostics' title", () => {
  const out = renderDiagHeader({
    timestamp: new Date(),
    nodeVersion: "v22",
    platform: "linux",
    arch: "arm64",
    osRelease: "6.0",
    cpuCount: 4,
    home: "/home/a",
  });
  assert.equal(out[0], "# vscrt diagnostics");
});

test("renderDiagHeader: includes each environment field", () => {
  const out = renderDiagHeader({
    timestamp: new Date(),
    nodeVersion: "v22.5.1",
    platform: "darwin",
    arch: "arm64",
    osRelease: "24.1.0",
    cpuCount: 12,
    home: "/Users/bob",
  });
  const joined = out.join("\n");
  assert.ok(joined.includes("v22.5.1"));
  assert.ok(joined.includes("darwin"));
  assert.ok(joined.includes("arm64"));
  assert.ok(joined.includes("24.1.0"));
  assert.ok(joined.includes("CPUs: 12"));
  assert.ok(joined.includes("/Users/bob"));
});

test("renderDiagHeader: ends with the '## Config' heading", () => {
  const out = renderDiagHeader({
    timestamp: new Date(),
    nodeVersion: "v22",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.22621",
    cpuCount: 16,
    home: "C:\\Users\\c",
  });
  assert.equal(out[out.length - 1], "## Config");
});

test("renderDiagHeader: output array has exactly 11 lines", () => {
  const out = renderDiagHeader({
    timestamp: new Date("2026-04-17T10:00:00Z"),
    nodeVersion: "v22.0.0",
    platform: "linux",
    arch: "x64",
    osRelease: "6.17.0",
    cpuCount: 8,
    home: "/home/a",
  });
  assert.equal(out.length, 11);
});

test("renderDiagHeader: host with backslashes survives without escaping", () => {
  const out = renderDiagHeader({
    timestamp: new Date(),
    nodeVersion: "v22",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0",
    cpuCount: 8,
    home: "C:\\Users\\alice",
  });
  const joined = out.join("\n");
  assert.ok(joined.includes("C:\\Users\\alice"));
});
