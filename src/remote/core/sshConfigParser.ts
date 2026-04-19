/**
 * Minimal ~/.ssh/config parser. Extracts Host blocks and the five keywords
 * that map cleanly onto our CRTConfigNode schema: HostName, User, Port,
 * IdentityFile, ProxyJump.
 *
 * What we DON'T handle (intentionally, for MVP):
 *   - `Match` blocks — skipped wholesale. Users with complex conditional
 *     configs can hand-import by editing vscrtConfig.json directly.
 *   - `Include` directives — skipped. A recursive import could pull in
 *     shared system config the user didn't intend.
 *   - Quoted values — the OpenSSH parser strips quotes; we leave them in.
 *   - Wildcard Host patterns (`Host *`, `Host prod-*`, `Host !foo`) — any
 *     alias containing `*`, `?`, or `!` is dropped. The first non-wildcard
 *     alias on a multi-alias Host line is used as the entry name.
 *   - Multiple IdentityFile entries — only the first is kept.
 *
 * The parser is pure — no I/O, no VS Code imports — so it's trivially
 * testable with string fixtures.
 */

export interface SshHostEntry {
  /** First non-wildcard alias from the Host line — used as the node name. */
  name: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  /** Maps to CRTConfigNode.addKeysToAgent — "yes" / "no" / "ask" / "confirm". */
  addKeysToAgent?: string;
  /** Maps to CRTConfigNode.agentForwarding — true when the config said "yes". */
  forwardAgent?: boolean;
  /** From ConnectTimeout. Preserved as seconds so buildBaseSshArgs can re-emit. */
  connectTimeoutSeconds?: number;
  /** From ServerAliveInterval. */
  serverAliveIntervalSeconds?: number;
  /** From IdentitiesOnly yes/no. */
  identitiesOnly?: boolean;
  /**
   * All unhandled directives, preserved verbatim so the round-trip
   * import → export doesn't silently drop enterprise config. Keys are
   * lower-cased for canonicalisation; values are trimmed.
   */
  extraDirectives?: Record<string, string>;
}

export function isWildcard(alias: string): boolean {
  return /[*?!]/.test(alias);
}

type MutableEntry = Partial<SshHostEntry>;

/**
 * Keywords we map onto native CRTConfigNode fields. Anything outside
 * this set is preserved in `extraDirectives` instead of being silently
 * dropped.
 */
const HANDLED_KEYWORDS = new Set([
  "hostname",
  "user",
  "port",
  "identityfile",
  "proxyjump",
  "addkeystoagent",
  "forwardagent",
  "connecttimeout",
  "serveraliveinterval",
  "identitiesonly",
]);

export function parseSshConfig(text: string): SshHostEntry[] {
  const defaults: MutableEntry = {};
  const entries: SshHostEntry[] = [];
  let current: MutableEntry | null = null;
  // `Match` blocks inherit SSH's first-match-wins semantics we don't
  // model, so we just skip through to the next Host directive.
  let insideMatchBlock = false;

  const commit = (): void => {
    if (current && current.name) {
      applyDefaults(current, defaults);
      entries.push(current as SshHostEntry);
    }
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip `#` comments (to EOL) and surrounding whitespace.
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }

    const { keyword, value } = splitKeywordValue(line);
    if (!keyword) {
      continue;
    }
    const kw = keyword.toLowerCase();

    if (kw === "host") {
      commit();
      insideMatchBlock = false;
      const aliases = value.split(/\s+/).filter(Boolean);
      const primary = aliases.find((a) => !isWildcard(a));
      current = primary ? { name: primary } : null;
      continue;
    }

    if (kw === "match" || kw === "include") {
      // `Match` opens a new host-scoped block that we skip entirely.
      // `Include` is a file-level directive; either way, ignore any
      // following keywords until the next Host.
      commit();
      insideMatchBlock = kw === "match";
      continue;
    }

    if (insideMatchBlock) {
      continue;
    }

    if (!HANDLED_KEYWORDS.has(kw)) {
      // Preserve anything we don't natively model so round-trip export
      // can emit it. Skips when we have no current entry (the defaults
      // block gets `extraDirectives` too but rarely does; we copy them
      // into each entry via applyDefaults).
      const preserveTarget: MutableEntry = current ?? defaults;
      if (!preserveTarget.extraDirectives) {
        preserveTarget.extraDirectives = {};
      }
      if (preserveTarget.extraDirectives[kw] === undefined) {
        preserveTarget.extraDirectives[kw] = value;
      }
      continue;
    }

    const target: MutableEntry = current ?? defaults;

    switch (kw) {
      case "hostname":
        if (!target.hostName) {
          target.hostName = value;
        }
        break;
      case "user":
        if (!target.user) {
          target.user = value;
        }
        break;
      case "port": {
        const p = parseInt(value, 10);
        if (Number.isFinite(p) && p >= 1 && p <= 65535 && target.port === undefined) {
          target.port = p;
        }
        break;
      }
      case "identityfile":
        if (!target.identityFile) {
          target.identityFile = value;
        }
        break;
      case "proxyjump":
        if (!target.proxyJump) {
          target.proxyJump = value;
        }
        break;
      case "addkeystoagent": {
        const v = value.toLowerCase();
        if (
          !target.addKeysToAgent &&
          (v === "yes" || v === "no" || v === "ask" || v === "confirm")
        ) {
          target.addKeysToAgent = v;
        }
        break;
      }
      case "forwardagent": {
        const v = value.toLowerCase();
        if (target.forwardAgent === undefined && (v === "yes" || v === "no")) {
          target.forwardAgent = v === "yes";
        }
        break;
      }
      case "connecttimeout": {
        const n = parseInt(value, 10);
        if (
          Number.isFinite(n) &&
          n >= 1 &&
          n <= 3600 &&
          target.connectTimeoutSeconds === undefined
        ) {
          target.connectTimeoutSeconds = n;
        }
        break;
      }
      case "serveraliveinterval": {
        const n = parseInt(value, 10);
        if (
          Number.isFinite(n) &&
          n >= 0 &&
          n <= 3600 &&
          target.serverAliveIntervalSeconds === undefined
        ) {
          target.serverAliveIntervalSeconds = n;
        }
        break;
      }
      case "identitiesonly": {
        const v = value.toLowerCase();
        if (target.identitiesOnly === undefined && (v === "yes" || v === "no")) {
          target.identitiesOnly = v === "yes";
        }
        break;
      }
    }
  }

  commit();
  return entries;
}

function splitKeywordValue(line: string): { keyword: string; value: string } {
  // OpenSSH accepts `Keyword value` and `Keyword=value`. Split on the first
  // whitespace or `=`, then trim the value. Leading `=` around the split is
  // possible (`Keyword = value`) — handled by the trim.
  const match = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
  if (!match) {
    return { keyword: line, value: "" };
  }
  return { keyword: match[1], value: match[2].trim() };
}

function applyDefaults(entry: MutableEntry, defaults: MutableEntry): void {
  for (const k of [
    "hostName",
    "user",
    "port",
    "identityFile",
    "proxyJump",
    "addKeysToAgent",
    "forwardAgent",
    "connectTimeoutSeconds",
    "serverAliveIntervalSeconds",
    "identitiesOnly",
  ] as const) {
    if (entry[k] === undefined && defaults[k] !== undefined) {
      (entry as Record<string, unknown>)[k] = defaults[k];
    }
  }
  // Merge extra directives: entry wins over defaults on collisions.
  if (defaults.extraDirectives) {
    const merged: Record<string, string> = { ...defaults.extraDirectives };
    if (entry.extraDirectives) {
      Object.assign(merged, entry.extraDirectives);
    }
    if (Object.keys(merged).length > 0) {
      entry.extraDirectives = merged;
    }
  }
}

