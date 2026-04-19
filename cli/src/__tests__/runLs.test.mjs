import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runLs } from "../../out/commands.js";

function captureOutput(fn) {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = (buf) => {
    out += String(buf);
    return true;
  };
  process.stderr.write = (buf) => {
    err += String(buf);
    return true;
  };
  try {
    const code = fn();
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("runLs: missing config returns 1 with a 'no config at' stderr message", () => {
  const tmp = "/nonexistent/definitely-missing-" + Date.now() + ".json";
  const { code, err } = captureOutput(() =>
    runLs({
      verb: "ls",
      positional: [],
      flags: { config: tmp },
      warnings: [],
    }),
  );
  assert.equal(code, 1);
  assert.ok(err.includes("no config at"));
});

test("runLs: empty config prints '(no servers'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-runls-"));
  const p = path.join(dir, "vscrtConfig.json");
  fs.writeFileSync(p, "{}");
  try {
    const { code, out } = captureOutput(() =>
      runLs({
        verb: "ls",
        positional: [],
        flags: { config: p },
        warnings: [],
      }),
    );
    assert.equal(code, 0);
    assert.ok(out.includes("(no servers"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runLs: --json empty config prints `[]`", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-runls-"));
  const p = path.join(dir, "vscrtConfig.json");
  fs.writeFileSync(p, "{}");
  try {
    const { code, out } = captureOutput(() =>
      runLs({
        verb: "ls",
        positional: [],
        flags: { config: p, json: true },
        warnings: [],
      }),
    );
    assert.equal(code, 0);
    assert.equal(out.trim(), "[]");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runLs: malformed JSON returns 1 and stderr mentions the path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-runls-"));
  const p = path.join(dir, "vscrtConfig.json");
  fs.writeFileSync(p, "{ broken");
  try {
    const { code, err } = captureOutput(() =>
      runLs({
        verb: "ls",
        positional: [],
        flags: { config: p },
        warnings: [],
      }),
    );
    assert.equal(code, 1);
    assert.ok(err.includes("vscrt ls"));
    assert.ok(err.includes(p));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runLs: --filter no-match prints 'no servers match filter: ...'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-runls-"));
  const p = path.join(dir, "vscrtConfig.json");
  fs.writeFileSync(
    p,
    JSON.stringify({ folder: [{ name: "Prod", nodes: [{ name: "Web", endpoint: "x" }] }] }),
  );
  try {
    const { code, out } = captureOutput(() =>
      runLs({
        verb: "ls",
        positional: [],
        flags: { config: p, filter: "xyz-nowhere" },
        warnings: [],
      }),
    );
    assert.equal(code, 0);
    assert.ok(out.includes("no servers match filter"));
    assert.ok(out.includes("xyz-nowhere"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runLs: --filter performs case-insensitive match", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-runls-"));
  const p = path.join(dir, "vscrtConfig.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      folder: [
        {
          name: "Prod",
          nodes: [{ name: "Web", endpoint: "u@host" }],
        },
      ],
    }),
  );
  try {
    const { code, out } = captureOutput(() =>
      runLs({
        verb: "ls",
        positional: [],
        flags: { config: p, filter: "PROD" },
        warnings: [],
      }),
    );
    assert.equal(code, 0);
    assert.ok(out.includes("Prod/Web"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
