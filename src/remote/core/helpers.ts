/**
 * SSH helpers — pure (no `vscode` imports). Endpoint parsing, arg
 * construction, shell-safe validation, tilde expansion, ssh/sshpass
 * binary names. The VS Code-bound `runInTerminal` stays in the
 * extension shim at `src/ssh/sshHelpers.ts`.
 */

import * as os from "os";
import * as path from "path";
import { CRTConfigNode } from "../../config/vscrtConfigTypes";
import { log } from "../../log";

export function hasUserAtHost(s: string): boolean {
  return /.+@.+/.test(s);
}

/**
 * Trim an optional string, returning `undefined` when the result is empty.
 * Useful for normalizing user input where "" and "  " should collapse to
 * "no value set" rather than an empty-string truthiness trap.
 */
export function trimToUndefined(s: string | undefined | null): string | undefined {
  if (s === undefined || s === null) {
    return undefined;
  }
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Split a trailing ":<port>" suffix off the end of an SSH target string.
 * The port must be purely numeric and in the 1-65535 range to qualify.
 *
 * Bracketed IPv6 targets (`[::1]:22`, `user@[2001:db8::1]:2222`) are
 * detected via a dedicated pattern so the internal colons don't
 * confuse the simpler host:port split.
 */
function splitPortSuffix(raw: string): { host: string; port?: number } {
  const ipv6WithPort = raw.match(/^(.*\[[^\]]+\]):(\d+)$/);
  if (ipv6WithPort) {
    const port = parseInt(ipv6WithPort[2], 10);
    if (Number.isFinite(port) && port >= 1 && port <= 65535) {
      return { host: ipv6WithPort[1], port };
    }
    return { host: raw };
  }
  if (/\[[^\]]+\]$/.test(raw)) {
    return { host: raw };
  }
  const m = raw.match(/^(.*):(\d+)$/);
  if (!m) {
    return { host: raw };
  }
  if (m[1].includes(":")) {
    return { host: raw };
  }
  const port = parseInt(m[2], 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { host: raw };
  }
  return { host: m[1], port };
}

/**
 * Resolve a node's endpoint into an SSH target (user@host) and a port. The
 * port is taken from a trailing ":<port>" suffix on the endpoint; if absent,
 * it defaults to 22.
 */
export function resolveEndpoint(node: CRTConfigNode): {
  target: string;
  port: number;
} {
  const ep = trimToUndefined(node.endpoint);
  let raw: string;
  if (ep && hasUserAtHost(ep)) {
    raw = ep;
  } else {
    const host = trimToUndefined(node.hostName) ?? ep ?? "";
    const user = trimToUndefined(node.user);
    raw = user ? `${user}@${host}` : host;
  }
  const { host, port } = splitPortSuffix(raw);
  return { target: host, port: port ?? 22 };
}

/**
 * Display-friendly `user@host:port` target, omitting the port when it's 22
 * (the SSH default). Used by tooltip/toast messages where terseness matters.
 */
export function buildDisplayTarget(node: CRTConfigNode): string {
  const { target, port } = resolveEndpoint(node);
  return port === 22 ? target : `${target}:${port}`;
}

// Expand "~" reliably (esp. Windows where ssh.exe won't do it)
export function expandTilde(p: string): string {
  const s = p.trim();
  if (!s) {
    return s;
  }
  if (s === "~") {
    return os.homedir();
  }
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.join(os.homedir(), s.slice(2));
  }
  return s;
}

export function getSshCommand(): string {
  return process.platform === "win32" ? "ssh.exe" : "ssh";
}

export function getSshpassCommand(): string {
  return process.platform === "win32" ? "sshpass.exe" : "sshpass";
}

export function getSftpCommand(): string {
  return process.platform === "win32" ? "sftp.exe" : "sftp";
}

/**
 * Translate ssh-style port args to sftp-style.
 *
 * `buildBaseSshArgs` emits `-p <port>` because that's the ssh(1) flag;
 * sftp(1) uses uppercase `-P` for port (lowercase `-p` means
 * "preserve file attributes"), so running `sftp -p 22 …` either fails
 * outright or silently picks up the wrong flag.
 *
 * Accepts both the joined form (`"-p 22"` as a single array element)
 * and the split form (`"-p"` followed by `"22"`).
 */
export function sshArgsToSftpArgs(sshArgs: string[]): string[] {
  const out: string[] = [];
  for (const a of sshArgs) {
    const joined = /^-p(\s+)(\d+)$/.exec(a);
    if (joined) {
      out.push(`-P${joined[1]}${joined[2]}`);
      continue;
    }
    if (a === "-p") {
      out.push("-P");
      continue;
    }
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shell-safe patterns — duplicated from the JSON schema so server-side code
// also rejects unsafe values even when the config was written programmatically.
// ---------------------------------------------------------------------------
const JUMP_HOST_RE = /^[A-Za-z0-9._@:,\[\]-]+$/;
const PORT_FORWARD_RE = /^-[LRD] [0-9A-Za-z:.\[\]/_-]+$/;

/** Returns `true` when the jumpHost value contains only shell-safe characters. */
export function isValidJumpHost(value: string): boolean {
  return JUMP_HOST_RE.test(value);
}

/** Returns `true` when a portForward entry matches the expected `-L|-R|-D <spec>` form. */
export function isValidPortForward(value: string): boolean {
  return PORT_FORWARD_RE.test(value);
}

/**
 * Very conservative SSH target classification for UX messages.
 *   - `ip4`: four dot-separated decimal octets, 0-255 each
 *   - `ip6`: bracketed IPv6 (e.g. `[2001:db8::1]`) or raw (contains `::`
 *     or >=2 colons without `@` host prefix stripped)
 *   - `hostname`: RFC-952-ish, letters/digits/`.-`, no consecutive `--`.
 *   - `invalid`: anything else (empty, bad chars, etc.)
 *
 * Used by UI only; the actual ssh invocation doesn't trust this.
 */
export type SshTargetKind = "ip4" | "ip6" | "hostname" | "invalid";

const IP4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function classifySshTarget(raw: string): SshTargetKind {
  const t = raw.trim();
  if (!t) {
    return "invalid";
  }
  const atIdx = t.lastIndexOf("@");
  const host = atIdx >= 0 ? t.slice(atIdx + 1) : t;
  if (!host) {
    return "invalid";
  }
  const hostNoPort = host.replace(/:(\d{1,5})$/, "");
  const bracketedV6 = hostNoPort.match(/^\[([^\]]+)\]$/);
  if (bracketedV6) {
    if (bracketedV6[1].includes(":")) {
      return "ip6";
    }
    return "invalid";
  }
  if (/^[0-9A-Fa-f:]+$/.test(hostNoPort) && hostNoPort.includes(":")) {
    return "ip6";
  }
  const v4 = hostNoPort.match(IP4_RE);
  if (v4) {
    for (let i = 1; i <= 4; i += 1) {
      const o = parseInt(v4[i], 10);
      if (o < 0 || o > 255) {
        return "invalid";
      }
    }
    return "ip4";
  }
  if (HOSTNAME_RE.test(hostNoPort) && hostNoPort.length <= 253) {
    return "hostname";
  }
  return "invalid";
}

/**
 * How ssh should treat an unknown host key. The connect path decides which
 * mode applies based on the user's `vsCRT.hostKeyPolicy` setting and whether
 * we were able to pre-verify outside ssh.
 *
 *   "accept-new" — OpenSSH's trust-on-first-use: silently adds unknown keys.
 *                  Current behavior; used when policy is auto-accept.
 *   "strict"     — refuse any unknown key. Used when we pre-verified (so the
 *                  key is already in known_hosts) or the user picked strict.
 *   "ask"        — OpenSSH prompts interactively in the spawned terminal.
 *                  Used when we can't pre-verify (e.g. ProxyJump chain).
 */
export type HostKeyCheckMode = "accept-new" | "strict" | "ask";

export interface BuildBaseSshArgsOptions {
  hostKeyCheck?: HostKeyCheckMode;
}

export function buildBaseSshArgs(
  node: CRTConfigNode,
  port: number,
  options: BuildBaseSshArgsOptions = {},
): string[] {
  const args: string[] = [`-p ${port}`];

  if (node.extraArgs?.trim()) {
    args.push(node.extraArgs.trim());
  }

  const jump = node.jumpHost?.trim();
  if (jump) {
    if (isValidJumpHost(jump)) {
      args.push(`-o ProxyJump=${jump}`);
    } else {
      log.warn(`Skipping unsafe jumpHost value for "${node.name}": "${jump}"`);
    }
  }

  if (Array.isArray(node.portForwards)) {
    for (const fwd of node.portForwards) {
      const trimmed = fwd.trim();
      if (trimmed) {
        if (isValidPortForward(trimmed)) {
          args.push(trimmed);
        } else {
          log.warn(`Skipping unsafe portForward for "${node.name}": "${trimmed}"`);
        }
      }
    }
  }

  if (node.agentForwarding === true) {
    args.push("-A");
  }
  if (
    node.addKeysToAgent === "yes" ||
    node.addKeysToAgent === "no" ||
    node.addKeysToAgent === "ask" ||
    node.addKeysToAgent === "confirm"
  ) {
    args.push(`-o AddKeysToAgent=${node.addKeysToAgent}`);
  }

  if (
    typeof node.connectTimeoutSeconds === "number" &&
    node.connectTimeoutSeconds >= 1
  ) {
    args.push(`-o ConnectTimeout=${node.connectTimeoutSeconds}`);
  }
  if (
    typeof node.serverAliveIntervalSeconds === "number" &&
    node.serverAliveIntervalSeconds >= 0
  ) {
    args.push(`-o ServerAliveInterval=${node.serverAliveIntervalSeconds}`);
  }
  if (typeof node.identitiesOnly === "boolean") {
    args.push(`-o IdentitiesOnly=${node.identitiesOnly ? "yes" : "no"}`);
  }

  if (node.extraSshDirectives) {
    for (const [key, value] of Object.entries(node.extraSshDirectives)) {
      if (!/^[A-Za-z0-9]+$/.test(key)) {
        continue;
      }
      if (/[`$();|&<>\\\x00-\x1f\x7f]/.test(value)) {
        continue;
      }
      args.push(`-o ${key}=${value}`);
    }
  }

  const mode = options.hostKeyCheck ?? "accept-new";
  const flag =
    mode === "strict"
      ? "yes"
      : mode === "ask"
        ? "ask"
        : "accept-new";
  args.push(`-o StrictHostKeyChecking=${flag}`);

  return args;
}
