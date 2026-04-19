/**
 * Smoke test for runConnect's early-return path. We can exercise the
 * "missing <path>" branch without touching `code`/fs — `runConnect`
 * returns 2 before reaching those.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runConnect } from "../../out/commands.js";

test("runConnect: returns 2 when no target is provided", async () => {
  const code = await runConnect({
    verb: "connect",
    positional: [],
    flags: {},
    warnings: [],
  });
  assert.equal(code, 2);
});

test("runConnect with --json: prints URL without touching code binary", async () => {
  // Capture stdout
  const orig = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (buf) => {
    captured += String(buf);
    return true;
  };
  try {
    const code = await runConnect({
      verb: "connect",
      positional: ["Prod/Web"],
      flags: { json: true },
      warnings: [],
    });
    assert.equal(code, 0);
    assert.ok(captured.includes("vscode://kynoci.vscrt/connect"));
    assert.ok(captured.includes("Prod%2FWeb"));
  } finally {
    process.stdout.write = orig;
  }
});

test("runSftp --json: prints the sftp deep-link URL", async () => {
  const { runSftp } = await import("../../out/commands.js");
  const orig = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (buf) => {
    captured += String(buf);
    return true;
  };
  try {
    const code = await runSftp({
      verb: "sftp",
      positional: ["Prod/Web"],
      flags: { json: true },
      warnings: [],
    });
    assert.equal(code, 0);
    assert.ok(captured.includes("vscode://kynoci.vscrt/sftp"));
    assert.ok(captured.includes("name=Prod%2FWeb"));
  } finally {
    process.stdout.write = orig;
  }
});

test("runSftp --browser --json: produces the sftpBrowser URL", async () => {
  const { runSftp } = await import("../../out/commands.js");
  const orig = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (buf) => {
    captured += String(buf);
    return true;
  };
  try {
    const code = await runSftp({
      verb: "sftp",
      positional: ["Staging/Web"],
      flags: { json: true, browser: true },
      warnings: [],
    });
    assert.equal(code, 0);
    assert.ok(captured.includes("vscode://kynoci.vscrt/sftpBrowser"));
  } finally {
    process.stdout.write = orig;
  }
});

test("runSftp without a path: omits the name param (picker flow)", async () => {
  const { runSftp } = await import("../../out/commands.js");
  const orig = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (buf) => {
    captured += String(buf);
    return true;
  };
  try {
    const code = await runSftp({
      verb: "sftp",
      positional: [],
      flags: { json: true },
      warnings: [],
    });
    assert.equal(code, 0);
    assert.ok(captured.includes("vscode://kynoci.vscrt/sftp"));
    assert.ok(!captured.includes("name="));
  } finally {
    process.stdout.write = orig;
  }
});
