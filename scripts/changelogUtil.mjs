/**
 * Pure helpers for manipulating CHANGELOG.md. Used by both
 * bump-version.mjs (rewrites [Unreleased] → dated version heading) and
 * extract-changelog.mjs (pulls the body for a given version into the
 * GitHub Release notes).
 *
 * Every function takes and returns strings — no I/O, no process.exit —
 * so the mocha suite can drive them directly.
 */

const HEADING_RE = /^## \[([^\]]+)\](?:\s+—\s+(\S+))?\s*$/;

/**
 * Pull the body that follows a specific `## [<version>]` heading until the
 * next `## [` heading (or end of file). Returns an empty string when the
 * heading isn't found so the caller can decide how to surface that.
 */
export function extractVersionBody(changelog, version) {
  const lines = changelog.split("\n");
  let capturing = false;
  const out = [];
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (m[1] === version) {
        capturing = true;
        continue;
      }
      if (capturing) {
        break;
      }
    }
    if (capturing) {
      out.push(line);
    }
  }
  // Trim leading + trailing blanks without collapsing internal blank lines.
  while (out.length > 0 && out[0].trim() === "") {
    out.shift();
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") {
    out.pop();
  }
  return out.join("\n");
}

/**
 * Rewrite a changelog in-place: rename the `## [Unreleased]` heading to
 * `## [<version>] — <date>` and insert a fresh empty `[Unreleased]`
 * section above it. Safe to call when an [Unreleased] heading doesn't
 * exist (returns the input unchanged, with a reason).
 *
 *   const { content, rewritten, reason } = renameUnreleased(text, "0.9.4", "2026-04-16");
 *   if (!rewritten) console.warn(reason);
 */
export function renameUnreleased(changelog, version, isoDate) {
  const lines = changelog.split("\n");
  let unreleasedIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1] === "Unreleased") {
      unreleasedIdx = i;
      break;
    }
  }
  if (unreleasedIdx < 0) {
    return {
      content: changelog,
      rewritten: false,
      reason: "no '## [Unreleased]' heading found",
    };
  }

  // If a heading for the new version already exists, skip — the changelog
  // has already been rolled forward (likely by a prior run).
  if (hasVersion(changelog, version)) {
    return {
      content: changelog,
      rewritten: false,
      reason: `'## [${version}]' already exists; changelog already rolled forward`,
    };
  }

  const rewritten = lines.slice();
  rewritten[unreleasedIdx] = `## [${version}] — ${isoDate}`;
  // Insert new empty [Unreleased] two lines above the dated heading so
  // reviewers see a clean break. The heading is followed by one blank line
  // then a placeholder note so "no entries yet" reads deliberately.
  const fresh = [
    "## [Unreleased]",
    "",
    "_No changes yet._",
    "",
  ];
  rewritten.splice(unreleasedIdx, 0, ...fresh);
  return {
    content: rewritten.join("\n"),
    rewritten: true,
  };
}

export function hasVersion(changelog, version) {
  for (const line of changelog.split("\n")) {
    const m = line.match(HEADING_RE);
    if (m && m[1] === version) {
      return true;
    }
  }
  return false;
}

/** Today's date in `YYYY-MM-DD` (UTC), for deterministic headings. */
export function isoDateUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Semver-ish validation. Allows 0.9.4, 1.0.0, 2.0.0-rc.1. Rejects v-prefix. */
export function isSemverLike(v) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v);
}
