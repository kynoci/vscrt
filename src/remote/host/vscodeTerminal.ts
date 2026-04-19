/**
 * VS Code terminal helpers — everything that needs `vscode.Terminal`
 * or `vscode.window.createTerminal` lives here, next to
 * `VscodeHostAdapter`. The pure argv/password-delivery logic stays
 * in `../core/passwordDelivery.ts` and `../core/helpers.ts`.
 */

import * as fs from "fs";
import * as net from "net";
import * as vscode from "vscode";
import { log } from "../../log";
import {
  ShellKind,
  classifyShellKind,
  cleanupAllNowSync as coreCleanupAllNowSync,
  untrackFile,
  untrackServer,
} from "../core/passwordDelivery";

export interface RunInTerminalOptions {
  shellPath?: string;
  location?: "panel" | "editor";
  /** Env vars injected into the spawned shell. */
  env?: Record<string, string>;
}

export function runInTerminal(
  name: string,
  command: string,
  options: RunInTerminalOptions = {},
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: `vsCRT: ${name}`,
    shellPath: options.shellPath,
    env: options.env,
    location:
      options.location === "editor"
        ? vscode.TerminalLocation.Editor
        : vscode.TerminalLocation.Panel,
  });

  terminal.show(true);
  terminal.sendText(command, true);
  return terminal;
}

/**
 * Resolve the user's preferred default shell from the
 * `terminal.integrated.*` settings. Used by `detectShellKind` when no
 * explicit shell path is provided.
 */
function resolveDefaultShellPath(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("terminal.integrated");
  const platformKey =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "osx"
        : "linux";
  const profileName = cfg.get<string>(`defaultProfile.${platformKey}`);
  const profiles =
    cfg.get<Record<string, { path?: string | string[]; source?: string }>>(
      `profiles.${platformKey}`,
    ) ?? {};
  if (profileName && profiles[profileName]) {
    const p = profiles[profileName].path;
    if (Array.isArray(p) && p.length > 0) {
      return p[0];
    }
    if (typeof p === "string" && p) {
      return p;
    }
    if (profiles[profileName].source === "PowerShell") {
      return "powershell.exe";
    }
  }
  if (process.platform === "win32") {
    return "powershell.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
}

/**
 * Overloaded wrapper around `classifyShellKind`: when no shell path is
 * given we peek at the user's `terminal.integrated.*` settings so the
 * argv builder picks the right shell for an implicit-terminal launch.
 * Callers that already know the shell path pass it directly and never
 * touch the VS Code config.
 */
export function detectShellKind(shellPath?: string): ShellKind {
  const resolved = shellPath ?? resolveDefaultShellPath();
  if (!resolved) {
    return "unknown";
  }
  return classifyShellKind(resolved);
}

// ─── per-terminal resource cleanup ──────────────────────────────────
interface TerminalResources {
  files: string[];
  servers: net.Server[];
}
const terminalResources = new Map<vscode.Terminal, TerminalResources>();

export function associateTerminal(
  term: vscode.Terminal,
  res: { file?: string; server?: net.Server },
): void {
  const slot = terminalResources.get(term) ?? { files: [], servers: [] };
  if (res.file) {
    slot.files.push(res.file);
  }
  if (res.server) {
    slot.servers.push(res.server);
  }
  terminalResources.set(term, slot);
}

export function cleanupTerminal(term: vscode.Terminal): void {
  const slot = terminalResources.get(term);
  if (!slot) {
    return;
  }
  for (const f of slot.files) {
    fs.promises.unlink(f).catch((err: unknown) => {
      log.debug(`cleanup: failed to unlink ${f}: ${err}`);
    });
    untrackFile(f);
  }
  for (const s of slot.servers) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
    untrackServer(s);
  }
  terminalResources.delete(term);
}

/**
 * Wraps the core's sync cleanup so we also drop the per-terminal
 * resource map. Called from the extension's `deactivate()` path.
 */
export function cleanupAllNowSync(): void {
  coreCleanupAllNowSync();
  terminalResources.clear();
}
