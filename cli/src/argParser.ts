/**
 * Small argv parser — no external deps (keeps the bundled binary tiny).
 * Supports positional args, `--flag`, `--key=value`, `--key value`.
 * Pure: feeds unit tests deterministically.
 */

export type CliVerb = "connect" | "sftp" | "ls" | "diag" | "help" | "version";

export interface ParsedArgs {
  verb: CliVerb;
  positional: string[];
  flags: Record<string, string | true>;
  /** Non-fatal warnings (e.g. unknown flag). */
  warnings: string[];
}

const KNOWN_VERBS: readonly string[] = ["connect", "sftp", "ls", "diag", "help", "version"];

/**
 * Flags that never take a value. Without this list the parser would
 * consume the next non-`--` token as the flag's value — i.e.
 * `vscrt connect --json Prod/Web` would set `flags.json = "Prod/Web"`
 * and leave `positional` empty. Known booleans are set to `true`
 * regardless of the next token.
 */
const KNOWN_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["json", "browser"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const warnings: string[] = [];
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let verb: CliVerb = "help";

  if (argv.length === 0) {
    return { verb, positional, flags, warnings };
  }

  // First arg is the verb. `--help` / `--version` short-circuits.
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    return { verb: "help", positional, flags, warnings };
  }
  if (first === "--version" || first === "-v") {
    return { verb: "version", positional, flags, warnings };
  }
  if (KNOWN_VERBS.includes(first)) {
    verb = first as CliVerb;
  } else {
    warnings.push(`unknown verb: ${first}`);
    return { verb: "help", positional, flags, warnings };
  }

  // Walk the rest.
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        const key = token.slice(2, eq);
        flags[key] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        if (KNOWN_BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
          continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }

  return { verb, positional, flags, warnings };
}
