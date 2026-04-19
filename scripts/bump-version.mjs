#!/usr/bin/env node
/**
 * Release helper. One command that:
 *   1. Bumps package.json + package-lock.json via `npm version <level>`.
 *      (This also creates a `vX.Y.Z` git tag and a release commit.)
 *   2. Rewrites CHANGELOG.md: renames `## [Unreleased]` to
 *      `## [X.Y.Z] — YYYY-MM-DD` and inserts a fresh empty `[Unreleased]`
 *      above it.
 *   3. Amends the npm version commit so the CHANGELOG edit lands in the
 *      same commit the tag points at — releases are one commit + one tag.
 *
 * Usage:
 *   npm run release:patch
 *   npm run release:minor
 *   npm run release:major
 *
 * Safety:
 *   - Refuses to run if the working tree is dirty.
 *   - Refuses to run if HEAD is not on the main branch (override with --allow-branch).
 *   - Stops before pushing; the operator runs `git push --follow-tags` themselves.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  hasVersion,
  isoDateUtc,
  renameUnreleased,
} from "./changelogUtil.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const changelogPath = join(repoRoot, "CHANGELOG.md");
const packagePath = join(repoRoot, "package.json");

const levelArg = process.argv[2];
const allowBranch = process.argv.includes("--allow-branch");
const allowDirty = process.argv.includes("--allow-dirty");
const mainBranch = "master";

if (!["patch", "minor", "major"].includes(levelArg)) {
  console.error("Usage: bump-version.mjs <patch|minor|major> [--allow-branch] [--allow-dirty]");
  process.exit(2);
}

function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: repoRoot,
    stdio: opts.stdio ?? "pipe",
    encoding: "utf-8",
  }).trim();
}

// --- preconditions ---------------------------------------------------------

if (!allowDirty) {
  const status = run("git status --porcelain");
  if (status) {
    console.error("Working tree is dirty:\n" + status);
    console.error("\nCommit or stash first, or re-run with --allow-dirty.");
    process.exit(1);
  }
}

const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== mainBranch && !allowBranch) {
  console.error(`Refusing to release from branch '${branch}'.`);
  console.error(`Switch to '${mainBranch}' or re-run with --allow-branch.`);
  process.exit(1);
}

// --- bump -----------------------------------------------------------------

// `npm version` creates a commit + tag on the default git config. We'll
// amend that commit with the CHANGELOG edit below so release = one commit.
// --no-git-tag-sign avoids requiring GPG config in CI-like environments.
console.log(`Bumping version (${levelArg})…`);
run(`npm version ${levelArg} --message "release: v%s"`, { stdio: "inherit" });

const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));
const newVersion = pkg.version;
console.log(`package.json now at ${newVersion}`);

// --- changelog ------------------------------------------------------------

const changelog = readFileSync(changelogPath, "utf-8");
if (hasVersion(changelog, newVersion)) {
  console.log(
    `CHANGELOG already has a section for ${newVersion}; skipping rewrite.`,
  );
} else {
  const result = renameUnreleased(changelog, newVersion, isoDateUtc());
  if (!result.rewritten) {
    console.warn(`CHANGELOG not updated: ${result.reason}`);
  } else {
    writeFileSync(changelogPath, result.content, "utf-8");
    console.log(`CHANGELOG rolled forward for ${newVersion}.`);
  }
}

// --- amend + resummarise --------------------------------------------------

run("git add CHANGELOG.md");
// Stage might be clean if the changelog didn't need a rewrite.
const staged = run("git diff --cached --name-only");
if (staged) {
  run("git commit --amend --no-edit", { stdio: "inherit" });
  console.log("Amended version commit with CHANGELOG update.");
}

console.log("\n✅  Ready to push. Run:");
console.log(`   git push --follow-tags origin ${mainBranch}`);
console.log(
  "\n   The release workflow will package the .vsix, cut a GitHub Release,",
);
console.log("   and (if VSCE_PAT is set) publish to the Marketplace.");
