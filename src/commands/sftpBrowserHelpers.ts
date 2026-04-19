/**
 * Pure helpers used by the SFTP-browser module. Zero vscode-api
 * imports so the unit suite can exercise them without a webview host.
 *
 * `sshArgsToSftpArgs` used to live here; it's now in
 * `src/remote/core/helpers.ts` and the ops import it from the remote
 * barrel alongside the session runners.
 */

/** Remote-path parent — "/a/b/c" → "/a/b"; "/a" → "/"; "~/a" → "~". */
export function parentDir(p: string): string {
  if (p === "/" || p === "~") {
    return p;
  }
  const idx = p.lastIndexOf("/");
  if (idx <= 0) {
    return p.startsWith("/") ? "/" : "~";
  }
  return p.slice(0, idx);
}

/** Join a remote dir + name with a single separator. */
export function posixJoin(dir: string, name: string): string {
  if (dir.endsWith("/")) {
    return dir + name;
  }
  return `${dir}/${name}`;
}

/**
 * Map a remote filename extension to a VS Code language id so the
 * preview opens with syntax highlighting. Conservative — unknown
 * extensions default to plaintext.
 */
export function guessLanguageId(remotePath: string): string {
  const dot = remotePath.lastIndexOf(".");
  if (dot < 0 || dot === remotePath.length - 1) {
    return "plaintext";
  }
  const ext = remotePath.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
      return "shellscript";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "toml":
      return "toml";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "xml":
      return "xml";
    case "conf":
    case "cfg":
    case "ini":
      return "ini";
    case "log":
      return "log";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "hpp":
    case "cc":
    case "cxx":
      return "cpp";
    case "sql":
      return "sql";
    case "dockerfile":
      return "dockerfile";
    case "php":
      return "php";
    case "rb":
      return "ruby";
    case "java":
      return "java";
    default:
      return "plaintext";
  }
}

/**
 * Heuristic binary detection on the first N bytes of a file's
 * content. Returns true when the buffer contains a NUL byte or has
 * more than 30% non-printable / non-whitespace bytes — matches the
 * behaviour of `git diff`'s binary detector closely enough for the
 * preview gate to make sensible calls.
 */
export function looksBinary(sample: Uint8Array): boolean {
  if (sample.length === 0) {
    return false;
  }
  let nonText = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 0) {
      return true;
    }
    // Printable ASCII (0x20-0x7E) + tab, newline, CR, form-feed, vertical tab.
    const isText =
      (b >= 0x20 && b <= 0x7e) ||
      b === 0x09 ||
      b === 0x0a ||
      b === 0x0d ||
      b === 0x0b ||
      b === 0x0c ||
      // UTF-8 continuation / multi-byte leaders (treat as text).
      b >= 0x80;
    if (!isText) {
      nonText += 1;
    }
  }
  return nonText / sample.length > 0.3;
}

/**
 * Build `user@host:path` scp-compatible remote-path strings. Used
 * by "Copy as scp path" to put a shell-ready address on the clipboard.
 */
export function toScpPath(target: string, remotePath: string): string {
  // target is already "user@host" (we don't carry port in here —
  // scp's -P option handles port; the caller composes that).
  return `${target}:${remotePath}`;
}

/**
 * Tagged summary for a bulk operation (delete / download). Used by
 * the handlers to pick between an info toast and an error toast, and
 * by tests to pin the four outcome cases.
 */
export interface BulkSummary {
  kind: "ok" | "partial" | "failed" | "none";
  message: string;
  successes: number;
  failures: number;
}

/**
 * Summarize a bulk op's result into a human-readable message +
 * severity tag. Pure — no I/O. The caller decides whether to route
 * `kind === "failed"` / `"partial"` to `showErrorMessage` or a
 * status-bar error pulse.
 *
 *   - `none`    → no items, nothing happened.
 *   - `ok`      → every item succeeded.
 *   - `failed`  → every item failed.
 *   - `partial` → mixed; message includes both counts.
 */
export function summarizeBulkResult(
  successes: number,
  failures: number,
  noun: string = "entry",
): BulkSummary {
  const plural = (n: number, s: string): string =>
    `${n} ${s}${n === 1 ? "" : noun === s ? "ies" : "s"}`;
  if (successes === 0 && failures === 0) {
    return { kind: "none", message: "No items.", successes, failures };
  }
  if (failures === 0) {
    return {
      kind: "ok",
      message: `Completed on ${plural(successes, noun)}.`,
      successes,
      failures,
    };
  }
  if (successes === 0) {
    return {
      kind: "failed",
      message: `All ${plural(failures, noun)} failed (see connection log).`,
      successes,
      failures,
    };
  }
  return {
    kind: "partial",
    message:
      `${plural(successes, noun)} succeeded, ${failures} failed ` +
      "(see connection log).",
    successes,
    failures,
  };
}
