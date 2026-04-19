/**
 * Zero-dependency argv parser for `vscrt-remote`.
 *
 * Verbs: connect, test, sftp, install-key, ls, diag, version, help.
 * Pure — feeds unit tests deterministically.
 */

export type RemoteCliVerb =
  | "connect"
  | "test"
  | "sftp"
  | "install-key"
  | "ls"
  | "diag"
  | "version"
  | "help";

export interface ParsedRemoteArgs {
  verb: RemoteCliVerb;
  positional: string[];
  flags: Record<string, string | true>;
  warnings: string[];
}

const KNOWN_VERBS: readonly string[] = [
  "connect",
  "test",
  "sftp",
  "install-key",
  "ls",
  "diag",
  "version",
  "help",
];

const KNOWN_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "yes",
  "verbose",
  "password-stdin",
  "json",
]);

export function parseRemoteArgs(argv: readonly string[]): ParsedRemoteArgs {
  const warnings: string[] = [];
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let verb: RemoteCliVerb = "help";

  if (argv.length === 0) {
    return { verb, positional, flags, warnings };
  }

  const first = argv[0];
  if (first === "--help" || first === "-h") {
    return { verb: "help", positional, flags, warnings };
  }
  if (first === "--version" || first === "-v") {
    return { verb: "version", positional, flags, warnings };
  }
  if (KNOWN_VERBS.includes(first)) {
    verb = first as RemoteCliVerb;
  } else {
    warnings.push(`unknown verb: ${first}`);
    return { verb: "help", positional, flags, warnings };
  }

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
