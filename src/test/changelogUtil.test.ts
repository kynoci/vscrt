import * as assert from "assert";
import * as path from "path";

// The changelog helper lives in scripts/changelogUtil.mjs so the release
// pipeline can consume it without a TS build step. We load it here via a
// dynamic ESM import — mocha + Node support it, we just need to remember
// the types are `unknown` from TS's perspective.
interface ChangelogUtil {
  extractVersionBody: (changelog: string, version: string) => string;
  renameUnreleased: (
    changelog: string,
    version: string,
    isoDate: string,
  ) => { content: string; rewritten: boolean; reason?: string };
  hasVersion: (changelog: string, version: string) => boolean;
  isSemverLike: (v: string) => boolean;
}

// Compiled layout: out/test/*.js → repo root is two levels up.
const SCRIPT_URL =
  "file://" +
  path.resolve(__dirname, "..", "..", "scripts", "changelogUtil.mjs");

let util: ChangelogUtil;

describe("scripts/changelogUtil.mjs", () => {
  before(async () => {
    util = (await import(SCRIPT_URL)) as ChangelogUtil;
  });

  describe("hasVersion", () => {
    it("finds an exact match", () => {
      const cl = "# Changelog\n\n## [0.9.3]\n\nnotes\n";
      assert.strictEqual(util.hasVersion(cl, "0.9.3"), true);
    });

    it("rejects a version that isn't present", () => {
      const cl = "# Changelog\n\n## [0.9.3]\n";
      assert.strictEqual(util.hasVersion(cl, "0.9.4"), false);
    });

    it("distinguishes '[Unreleased]' from a numeric version", () => {
      const cl = "## [Unreleased]\n## [0.9.3]\n";
      assert.strictEqual(util.hasVersion(cl, "Unreleased"), true);
      assert.strictEqual(util.hasVersion(cl, "0.9.3"), true);
    });
  });

  describe("extractVersionBody", () => {
    const sample = [
      "# Changelog",
      "",
      "Preamble that should not appear in any release body.",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "- pending item",
      "",
      "## [0.9.4] — 2026-04-16",
      "",
      "### Added",
      "- new shiny feature",
      "",
      "### Fixed",
      "- an actual bug",
      "",
      "## [0.9.3] — 2026-04-01",
      "",
      "Initial hardening pass.",
      "",
    ].join("\n");

    it("extracts a specific version's body, trimmed", () => {
      const body = util.extractVersionBody(sample, "0.9.4");
      assert.strictEqual(
        body,
        [
          "### Added",
          "- new shiny feature",
          "",
          "### Fixed",
          "- an actual bug",
        ].join("\n"),
      );
    });

    it("extracts [Unreleased] body the same way", () => {
      const body = util.extractVersionBody(sample, "Unreleased");
      assert.ok(body.includes("### Added"));
      assert.ok(body.includes("pending item"));
      assert.ok(!body.includes("0.9.4"));
    });

    it("extracts the last section up to end of file", () => {
      const body = util.extractVersionBody(sample, "0.9.3");
      assert.strictEqual(body, "Initial hardening pass.");
    });

    it("returns empty string for a missing version", () => {
      assert.strictEqual(util.extractVersionBody(sample, "9.9.9"), "");
    });
  });

  describe("renameUnreleased", () => {
    it("rewrites [Unreleased] to a dated version heading and inserts a fresh section", () => {
      const input = [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "- shipped thing",
        "",
      ].join("\n");
      const { content, rewritten } = util.renameUnreleased(
        input,
        "0.9.4",
        "2026-04-16",
      );
      assert.strictEqual(rewritten, true);
      assert.ok(content.includes("## [Unreleased]"));
      assert.ok(content.includes("_No changes yet._"));
      assert.ok(content.includes("## [0.9.4] — 2026-04-16"));
      // The new [Unreleased] section must come BEFORE the dated section.
      const unreleasedAt = content.indexOf("## [Unreleased]");
      const datedAt = content.indexOf("## [0.9.4]");
      assert.ok(unreleasedAt < datedAt);
    });

    it("is a no-op when no [Unreleased] heading is present", () => {
      const input = "# Changelog\n\n## [0.9.3]\n";
      const { content, rewritten, reason } = util.renameUnreleased(
        input,
        "0.9.4",
        "2026-04-16",
      );
      assert.strictEqual(rewritten, false);
      assert.strictEqual(content, input);
      assert.match(reason ?? "", /no '## \[Unreleased\]'/);
    });

    it("is a no-op when the target version already exists (already rolled forward)", () => {
      const input = [
        "## [Unreleased]",
        "",
        "## [0.9.4] — 2026-04-16",
        "",
      ].join("\n");
      const { rewritten, reason } = util.renameUnreleased(
        input,
        "0.9.4",
        "2026-04-16",
      );
      assert.strictEqual(rewritten, false);
      assert.match(reason ?? "", /already exists/);
    });
  });

  describe("isSemverLike", () => {
    it("accepts basic SemVer", () => {
      assert.strictEqual(util.isSemverLike("0.9.4"), true);
      assert.strictEqual(util.isSemverLike("1.0.0"), true);
      assert.strictEqual(util.isSemverLike("12.34.56"), true);
    });

    it("accepts pre-release and build suffixes", () => {
      assert.strictEqual(util.isSemverLike("1.0.0-rc.1"), true);
      assert.strictEqual(util.isSemverLike("1.0.0+build.123"), true);
    });

    it("rejects a v-prefix, partial versions, and non-numeric", () => {
      assert.strictEqual(util.isSemverLike("v1.0.0"), false);
      assert.strictEqual(util.isSemverLike("1.0"), false);
      assert.strictEqual(util.isSemverLike("latest"), false);
      assert.strictEqual(util.isSemverLike(""), false);
    });
  });
});
