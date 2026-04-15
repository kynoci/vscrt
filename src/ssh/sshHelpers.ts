import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { CRTConfigNode } from "../config/vscrtConfig";

export function hasUserAtHost(s: string): boolean {
  return /.+@.+/.test(s);
}

/**
 * Split a trailing ":<port>" suffix off the end of an SSH target string.
 * The port must be purely numeric and in the 1-65535 range to qualify; an
 * IPv6 address without brackets would confuse this, but vsCRT doesn't support
 * that form.
 */
function splitPortSuffix(raw: string): { host: string; port?: number } {
  const m = raw.match(/^(.*):(\d+)$/);
  if (!m) {
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
  const ep = (node.endpoint ?? "").trim();
  let raw: string;
  if (ep && hasUserAtHost(ep)) {
    raw = ep;
  } else {
    const host = (node.hostName ?? ep).trim();
    const user = (node.user ?? "").trim();
    raw = user ? `${user}@${host}` : host;
  }
  const { host, port } = splitPortSuffix(raw);
  return { target: host, port: port ?? 22 };
}

/** Legacy-compatible alias — returns just the SSH target (no port suffix). */
export function buildTarget(node: CRTConfigNode): string {
  return resolveEndpoint(node).target;
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

export function escapeForDoubleQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

export function getSshCommand(): string {
  return process.platform === "win32" ? "ssh.exe" : "ssh";
}

export function getSshpassCommand(): string {
  return process.platform === "win32" ? "sshpass.exe" : "sshpass";
}
export function buildBaseSshArgs(node: CRTConfigNode, port: number): string[] {
  const args: string[] = [`-p ${port}`];

  // Per-node overrides come first so a user's explicit `-o StrictHostKeyChecking=...`
  // wins over our default (OpenSSH uses first-occurrence-wins for -o).
  if (node.extraArgs?.trim()) {
    args.push(node.extraArgs.trim());
  }

  // Trust-on-first-use: auto-accept an unknown host, but refuse if the host is
  // already in known_hosts with a different key (possible MITM).
  args.push("-o StrictHostKeyChecking=accept-new");

  return args;
}

export interface RunInTerminalOptions {
  shellPath?: string;
  location?: "panel" | "editor";
}

export function runInTerminal(
  name: string,
  command: string,
  options: RunInTerminalOptions = {},
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: `vsCRT: ${name}`,
    shellPath: options.shellPath,
    location:
      options.location === "editor"
        ? vscode.TerminalLocation.Editor
        : vscode.TerminalLocation.Panel,
  });

  terminal.show(true);
  terminal.sendText(command, true);
  return terminal;
}
