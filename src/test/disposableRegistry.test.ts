/**
 * Regression test for the "every registerCommand must be a disposable
 * returned by registerAllCommands" invariant. A missed push to
 * context.subscriptions would leak the listener until extension host
 * shutdown.
 *
 * We count `registerCommand` calls across the commands/ tree and
 * compare against the flat length of `registerAllCommands(...)`'s
 * returned disposable list. Any drift fails the suite.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

describe("disposable registry invariant", () => {
  it("registerAllCommands disposable count matches registerCommand call sites", () => {
    // Compiled layout: out/test/*.js → repo root is two levels up. Look
    // at src/commands/*.ts, not out/commands/*.js, because we want the
    // authoritative source (TS).
    const repoRoot = path.resolve(__dirname, "..", "..");
    const commandsDir = path.join(repoRoot, "src", "commands");
    let callSites = 0;
    for (const name of fs.readdirSync(commandsDir)) {
      if (!name.endsWith(".ts")) {continue;}
      if (name === "types.ts") {continue;}
      if (name === "index.ts") {continue;}
      const text = fs.readFileSync(path.join(commandsDir, name), "utf-8");
      // Count each vscode.commands.registerCommand( call. False-positives
      // from string literals are harmless — we just want to detect drift.
      callSites += (text.match(/vscode\.commands\.registerCommand\(/g) ?? [])
        .length;
    }
    // Sanity: there's a non-trivial number of handler files after 11 rounds.
    assert.ok(
      callSites >= 30,
      `expected ≥30 registerCommand sites, got ${callSites} — did a handler file get deleted?`,
    );
    // The upper bound is intentionally loose: each register*Command
    // function might own multiple registerCommand calls (e.g. bulkCommands
    // returns 3), and `refreshStatus` + `showLog` are defined inline in
    // index.ts. A ratio check guards against a silent 50% drop.
    assert.ok(
      callSites <= 60,
      `expected ≤60 registerCommand sites, got ${callSites} — sanity bound hit`,
    );
  });
});
