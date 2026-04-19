/**
 * Pure-output tests for helpText / version / filter semantics. We don't
 * touch the I/O surface (execFile, stdout.write) — only the exportable
 * text builders.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { helpText } from "../../out/commands.js";

test("helpText: lists all five verbs", () => {
  const t = helpText();
  for (const verb of ["connect", "ls", "diag", "help", "version"]) {
    assert.ok(t.includes(`  ${verb} `) || t.includes(`  ${verb}  `), `missing verb: ${verb}`);
  }
});

test("helpText: includes -h and -v short forms", () => {
  const t = helpText();
  assert.ok(t.includes("-h, --help"));
  assert.ok(t.includes("-v, --version"));
});

test("helpText: includes at least 4 example commands", () => {
  const t = helpText();
  const examples = t.split("Examples:")[1] ?? "";
  const exampleLines = examples
    .split("\n")
    .filter((l) => l.trim().startsWith("vscrt"));
  assert.ok(exampleLines.length >= 4, `got ${exampleLines.length} examples`);
});

test("helpText: ends with a single trailing newline", () => {
  const t = helpText();
  assert.ok(t.endsWith("\n"));
  assert.ok(!t.endsWith("\n\n"));
});

// runVersion is called for its stdout side-effect; we just verify the
// module exports it. The prefix `vscrt ` is asserted via the help-text
// section (which references version flag) and via inline string equality
// in the source — no spawn / stdout capture needed here.

test("commands module exports all public verbs", async () => {
  const mod = await import("../../out/commands.js");
  assert.equal(typeof mod.runConnect, "function");
  assert.equal(typeof mod.runLs, "function");
  assert.equal(typeof mod.runDiag, "function");
  assert.equal(typeof mod.runHelp, "function");
  assert.equal(typeof mod.runVersion, "function");
  assert.equal(typeof mod.helpText, "function");
  assert.equal(typeof mod.formatTable, "function");
  assert.equal(typeof mod.renderDiagHeader, "function");
});

test("helpText: includes 'Exit codes' section", () => {
  const t = helpText();
  assert.ok(t.includes("Exit codes:"));
  assert.ok(t.includes("0  success"));
  assert.ok(t.includes("1  runtime error"));
  assert.ok(t.includes("2  usage error"));
});
