/**
 * Pure parser for `ls -la` output. Used by the SFTP Browser preview to
 * display remote directory contents without spawning an interactive
 * sftp subprocess.
 *
 * We run the remote command via `ssh <baseArgs> <target> 'ls -la <dir>'`
 * and feed the resulting stdout to `parseLsLong`. The parser is
 * deliberately conservative: anything it can't classify is dropped
 * rather than rendered as a mangled row.
 *
 * Supported input: GNU `ls` and BSD `ls` long-form output. Example:
 *
 *   total 32
 *   drwxr-xr-x 3 user group 4096 Apr 17 10:00 docs
 *   -rw-r--r-- 1 user group  220 Apr 17 10:00 .bashrc
 *   lrwxrwxrwx 1 user group   11 Apr 17 10:00 link -> /etc/hosts
 *
 * Not supported: Windows `dir` output (vsCRT targets unix hosts over
 * ssh), `ls` output with `-Z` (SELinux context) column, or streaming
 * inotify-style formats.
 */

export type FileEntryKind = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
  /** File name (does not include " -> target" for symlinks). */
  name: string;
  /** Classification derived from the permission-string's first char. */
  kind: FileEntryKind;
  /** Size in bytes as the remote `ls` reported it. */
  size: number;
  /** Full permission string (e.g. `drwxr-xr-x`). */
  perms: string;
  /**
   * Last-modified string as emitted by `ls`. Shape varies by remote
   * locale + `--time-style`: `"Apr 17 10:00"`, `"Apr 17 2025"`, or
   * `"2026-04-17 10:00"`. We don't parse to a Date — callers use it
   * for display.
   */
  mtime?: string;
  /**
   * Symlink target when `kind === "symlink"`; undefined otherwise.
   * Pulled from the ` -> <target>` suffix.
   */
  linkTarget?: string;
}

const PERM_RE = /^[-dlbcps][-rwxstST]{9}[+.@]?$/;

function classify(perms: string): FileEntryKind {
  switch (perms.charAt(0)) {
    case "d":
      return "dir";
    case "l":
      return "symlink";
    case "-":
      return "file";
    default:
      return "other";
  }
}

/**
 * Parse the stdout of `ls -la`. Returns one FileEntry per file row;
 * `total N` headers and blank lines are ignored. Entries whose
 * permission string doesn't match the expected shape are dropped.
 */
export function parseLsLong(stdout: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) {
      continue;
    }
    if (line.startsWith("total ")) {
      continue;
    }
    const tokens = line.split(/\s+/);
    // Need at least: perms links owner group size date[1-2 tokens] name.
    // Lower bound is 8 (long-iso: 7 header + name); 9+ for GNU default.
    if (tokens.length < 8) {
      continue;
    }
    const perms = tokens[0];
    if (!PERM_RE.test(perms)) {
      continue;
    }
    const sizeRaw = tokens[4];
    const size = /^\d+$/.test(sizeRaw) ? parseInt(sizeRaw, 10) : 0;
    // Date-format detection:
    //   long-iso (2 tokens, "YYYY-MM-DD HH:MM")   → name begins at idx 7
    //   GNU default (3 tokens, "MMM DD HH:MM"|"MMM DD YYYY") → idx 8
    // `--time-style=full-iso` (5 tokens) isn't supported here; callers
    // that need it can update the runner flag + parser together.
    const isLongIso = /^\d{4}-\d{2}-\d{2}$/.test(tokens[5] ?? "");
    const dateTokens = isLongIso ? 2 : 3;
    const nameStart = 5 + dateTokens;
    if (tokens.length < nameStart + 1) {
      continue;
    }
    const mtime = tokens.slice(5, nameStart).join(" ");
    const rest = tokens.slice(nameStart).join(" ");
    if (!rest) {
      continue;
    }
    const kind = classify(perms);
    if (kind === "symlink") {
      const arrowAt = rest.indexOf(" -> ");
      if (arrowAt >= 0) {
        out.push({
          name: rest.slice(0, arrowAt),
          kind,
          size,
          perms,
          mtime,
          linkTarget: rest.slice(arrowAt + 4),
        });
        continue;
      }
    }
    out.push({ name: rest, kind, size, perms, mtime });
  }
  return out;
}

/**
 * Normalize a remote path: collapse "../" / "./" segments, strip empty
 * segments, and prefix "/" unless the path starts with "~" (home).
 *
 * Note: we don't resolve `~/…` to an absolute path — the remote shell
 * will do that when we pass it to `ls`. This is purely a client-side
 * display/normalization helper.
 */
export function normalizeRemotePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "~";
  }
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return collapseSegments(trimmed);
  }
  if (!trimmed.startsWith("/")) {
    // Treat relative paths as anchored to home for UI sanity — mirror
    // what a fresh shell would do.
    return collapseSegments("~/" + trimmed);
  }
  return collapseSegments(trimmed);
}

function collapseSegments(raw: string): string {
  const keepLeadingTilde = raw.startsWith("~");
  const prefix = keepLeadingTilde ? "~" : "";
  const body = keepLeadingTilde ? raw.slice(1) : raw;
  const parts = body.split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") {
      continue;
    }
    if (p === "..") {
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    stack.push(p);
  }
  if (keepLeadingTilde) {
    return stack.length > 0 ? `${prefix}/${stack.join("/")}` : prefix;
  }
  return "/" + stack.join("/");
}

/**
 * Shell-safe quoting for a remote path embedded in an `ssh … '<cmd>'`
 * argument. We pass the user-provided path to `ls` / `sftp` through
 * the remote shell, which re-parses it — so we have to defang shell
 * metacharacters without breaking tilde expansion.
 *
 * A naïve `'...'` wrap turns `~` into a literal path (the POSIX shell
 * expands `~` ONLY when unquoted and at the start of a word), which
 * is why the SFTP Browser used to land on `ls: cannot access '~':
 * No such file or directory` every time — `~` was getting single-
 * quoted and the remote shell never expanded it.
 *
 * Rules:
 *   - bare `~`   → emit as `~` (unquoted, so $HOME resolution fires).
 *   - `~/rest`   → emit `~/` unquoted, then single-quote just `rest`.
 *   - anything else → full single-quote wrap, escaping embedded `'`.
 */
export function shellQuoteRemotePath(path: string): string {
  if (path === "~") {
    return "~";
  }
  if (path.startsWith("~/")) {
    const rest = path.slice(2);
    if (rest === "") {
      return "~/";
    }
    return "~/" + "'" + rest.replace(/'/g, "'\\''") + "'";
  }
  return "'" + path.replace(/'/g, "'\\''") + "'";
}
