/**
 * CLI tests run via `node --test` (Node 20+ built-in test runner) so we
 * don't pull mocha/vitest into the bundled CLI. ESM-only to match
 * Node's native `--test` resolver without ts-node ceremony.
 *
 * Build + run:
 *   cd cli/
 *   npm run build
 *   npx tsc -p tsconfig.json --outDir out --module esnext --target es2022 --moduleResolution node
 *   node --test src/__tests__/*.test.mjs
 *
 * These tests are informational — CI runs the extension's mocha suite
 * which covers the URL router; the argParser tests here exist so a
 * contributor changing the CLI gets immediate feedback.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs } from "../../out/argParser.js";
import { buildDeepLink } from "../../out/urlBuilder.js";

test("parseArgs: empty argv returns help verb", () => {
  const out = parseArgs([]);
  assert.equal(out.verb, "help");
  assert.deepEqual(out.positional, []);
});

test("parseArgs: unknown verb warns and falls back to help", () => {
  const out = parseArgs(["not-a-verb"]);
  assert.equal(out.verb, "help");
  assert.ok(out.warnings.length > 0);
});

test("parseArgs: --help short-circuits", () => {
  assert.equal(parseArgs(["--help"]).verb, "help");
  assert.equal(parseArgs(["-h"]).verb, "help");
});

test("parseArgs: --version short-circuits", () => {
  assert.equal(parseArgs(["--version"]).verb, "version");
  assert.equal(parseArgs(["-v"]).verb, "version");
});

test("parseArgs: --help after a verb still wins short-circuit", () => {
  // Arguable design call: `vscrt connect --help` is currently *not* a
  // short-circuit (connect runs the normal flow). Document this.
  const out = parseArgs(["connect", "--help"]);
  assert.equal(out.verb, "connect");
  assert.equal(out.flags.help, true);
});

test("parseArgs: connect with positional path", () => {
  const out = parseArgs(["connect", "Prod/Web"]);
  assert.equal(out.verb, "connect");
  assert.deepEqual(out.positional, ["Prod/Web"]);
});

test("parseArgs: --json flag (bare)", () => {
  const out = parseArgs(["connect", "Prod/Web", "--json"]);
  assert.equal(out.flags.json, true);
});

test("parseArgs: --flag=value form", () => {
  const out = parseArgs(["ls", "--filter=prod"]);
  assert.equal(out.flags.filter, "prod");
});

test("parseArgs: --flag value form", () => {
  const out = parseArgs(["ls", "--filter", "prod"]);
  assert.equal(out.flags.filter, "prod");
});

test("parseArgs: multiple flags and positionals", () => {
  const out = parseArgs([
    "connect",
    "Prod/Web",
    "--json",
    "--config",
    "/tmp/c.json",
  ]);
  assert.equal(out.verb, "connect");
  assert.deepEqual(out.positional, ["Prod/Web"]);
  assert.equal(out.flags.json, true);
  assert.equal(out.flags.config, "/tmp/c.json");
});

test("buildDeepLink: encodes the name param", () => {
  const url = buildDeepLink("connect", { name: "Prod/Web" });
  assert.equal(url, "vscode://kynoci.vscrt/connect?name=Prod%2FWeb");
});

test("buildDeepLink: handles spaces and special chars", () => {
  const url = buildDeepLink("connect", { name: "Prod Servers/Web #1" });
  assert.equal(
    url,
    "vscode://kynoci.vscrt/connect?name=Prod%20Servers%2FWeb%20%231",
  );
});

test("buildDeepLink: bare verb with no params", () => {
  const url = buildDeepLink("quickConnect");
  assert.equal(url, "vscode://kynoci.vscrt/quickConnect");
});

test("buildDeepLink: skips undefined params", () => {
  const url = buildDeepLink("connect", { name: undefined });
  assert.equal(url, "vscode://kynoci.vscrt/connect");
});

test("parseArgs: --flag=value with empty value", () => {
  const out = parseArgs(["ls", "--filter="]);
  assert.equal(out.flags.filter, "");
});

test("parseArgs: --flag=value with = inside value", () => {
  const out = parseArgs(["ls", "--config=/tmp/a=b.json"]);
  assert.equal(out.flags.config, "/tmp/a=b.json");
});

test("parseArgs: multiple positionals after verb", () => {
  const out = parseArgs(["connect", "Prod/a", "Prod/b"]);
  assert.equal(out.verb, "connect");
  assert.deepEqual(out.positional, ["Prod/a", "Prod/b"]);
});

test("parseArgs: mixed flag order (flag between positionals)", () => {
  const out = parseArgs(["ls", "--json", "positional"]);
  // positional should still be captured
  assert.equal(out.flags.json, true);
  assert.deepEqual(out.positional, ["positional"]);
});

test("parseArgs: help verb ignores trailing args", () => {
  const out = parseArgs(["help", "anything"]);
  assert.equal(out.verb, "help");
  assert.deepEqual(out.positional, ["anything"]);
});

test("parseArgs: version verb", () => {
  const out = parseArgs(["version"]);
  assert.equal(out.verb, "version");
});

test("parseArgs: --json followed by a positional (known-bool flag)", () => {
  // Before the KNOWN_BOOLEAN_FLAGS fix, this test would have asserted
  // flags.json === "Prod/Web" and positional === []. Post-fix:
  const out = parseArgs(["connect", "--json", "Prod/Web"]);
  assert.equal(out.verb, "connect");
  assert.equal(out.flags.json, true);
  assert.deepEqual(out.positional, ["Prod/Web"]);
});

test("parseArgs: --json appears after a positional (still boolean)", () => {
  const out = parseArgs(["connect", "Prod/Web", "--json"]);
  assert.equal(out.flags.json, true);
  assert.deepEqual(out.positional, ["Prod/Web"]);
});

test("parseArgs: --json=false is accepted as the literal string 'false'", () => {
  // We don't try to coerce truthy strings; this is intentional. Documented
  // here so future refactors don't silently flip the semantics.
  const out = parseArgs(["ls", "--json=false"]);
  assert.equal(out.flags.json, "false");
});

test("parseArgs: unknown flag still consumes a value argument", () => {
  const out = parseArgs(["ls", "--bogus", "value"]);
  assert.equal(out.flags.bogus, "value");
  assert.deepEqual(out.positional, []);
});

// urlPrefix tests --------------------------------------------------------
import { urlPrefix } from "../../out/urlBuilder.js";

test("urlPrefix: matches the buildDeepLink output prefix", () => {
  const p = urlPrefix();
  assert.equal(p, "vscode://kynoci.vscrt/");
  assert.ok(buildDeepLink("connect", { name: "x" }).startsWith(p));
});

test("urlPrefix: stable across invocations", () => {
  assert.equal(urlPrefix(), urlPrefix());
});

test("buildDeepLink: encodes multiple params deterministically", () => {
  const url = buildDeepLink("connect", { name: "Prod/Web", q: "x y" });
  assert.ok(url.includes("name=Prod%2FWeb"));
  assert.ok(url.includes("q=x%20y"));
});

test("buildDeepLink: preserves verb when no params given", () => {
  assert.equal(buildDeepLink("validate"), "vscode://kynoci.vscrt/validate");
});
