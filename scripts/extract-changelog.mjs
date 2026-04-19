#!/usr/bin/env node
/**
 * Print the body of a specific `## [<version>]` section from CHANGELOG.md
 * to stdout. Wired up from .github/workflows/release.yml as the source
 * of the GitHub Release notes body.
 *
 *   node scripts/extract-changelog.mjs 0.9.4 > release-notes.md
 *
 * Exits 0 with a placeholder body when the version isn't found — the
 * release still cuts; the notes just say "no CHANGELOG entry found" so
 * the human can fix up the Release afterwards instead of the whole job
 * failing at the last step.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractVersionBody } from "./changelogUtil.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const changelogPath = join(here, "..", "CHANGELOG.md");

const version = process.argv[2];
if (!version) {
  console.error("Usage: extract-changelog.mjs <version>");
  process.exit(2);
}

const text = readFileSync(changelogPath, "utf-8");
const body = extractVersionBody(text, version);

if (body) {
  process.stdout.write(body + "\n");
} else {
  process.stdout.write(
    `_No CHANGELOG entry was found for version ${version}. Edit this Release on GitHub to add notes._\n`,
  );
}
