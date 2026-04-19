/**
 * CLI (`vscrt-remote`) implementation of HostAdapter.
 *
 * Differences from `VscodeHostAdapter`:
 *   - Prompts: `readline` on stderr instead of VS Code modals.
 *   - Settings: a plain `CliSettings` struct fed by CLI flags (and
 *     sensible defaults). No `vscode.workspace.getConfiguration`.
 *   - Secrets: resolves plaintext, `enc:v3`/`enc:v4` via an injected
 *     unsealer; `@secret:<uuid>` blobs are not readable from a plain
 *     Node process, so the caller is expected to supply plaintext via
 *     `--password-stdin` or accept the runtime error.
 *   - Terminals: `child_process.spawn` with `stdio: "inherit"` — no
 *     VS Code terminal panel, no per-terminal cleanup subscription
 *     (the spawned child's own lifecycle handles it).
 */

import * as readline from "readline";
import { spawn } from "child_process";
import {
  ConfirmOptions,
  ConnectionLogMode,
  HostAdapter,
  HostKeyPolicy,
  OpenTerminalOptions,
  SessionRecordingMode,
  TerminalHandle,
} from "./hostAdapter";

export interface CliSettings {
  hostKeyPolicy?: HostKeyPolicy;
  connectionLogMode?: ConnectionLogMode;
  sessionRecordingMode?: SessionRecordingMode;
  /** When true, `confirm()` auto-answers "yes" (non-interactive runs). */
  assumeYes?: boolean;
}

/**
 * Callback that resolves a stored password into plaintext.
 *   - `@secret:<uuid>`   — unsupported in a plain Node CLI (the
 *                          keychain backend is VS Code's). Callers
 *                          must supply plaintext via other means.
 *   - `enc:v3`/`enc:v4`  — decrypt via `CRTPassphraseService` driven
 *                          by a readline passphrase prompt.
 *   - plaintext / empty  — return as-is.
 */
export type CliUnsealer = (stored: string | undefined) => Promise<string | undefined>;

export class NodeHostAdapter implements HostAdapter {
  private lastHandle?: ChildTerminalHandle;

  constructor(
    private readonly settings: CliSettings = {},
    private readonly unsealer?: CliUnsealer,
  ) {}

  /**
   * Wait for the most-recently-spawned shell/ssh child to exit and
   * return its exit code. Returns `null` when no terminal has been
   * opened yet. CLI entry points call this after `connect()` to
   * block until the user logs out, then propagate the exit code.
   */
  async waitForLastTerminal(): Promise<number | null> {
    if (!this.lastHandle) {
      return null;
    }
    return this.lastHandle.waitForExit();
  }

  async confirm(opts: ConfirmOptions): Promise<boolean> {
    if (this.settings.assumeYes) {
      process.stderr.write(`${opts.title}\n${opts.detail}\n[--yes] trusting.\n`);
      return true;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      process.stderr.write(`${opts.title}\n${opts.detail}\n`);
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${opts.trustLabel}? [y/N] `, (a) => resolve(a));
      });
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  }

  error(msg: string): void {
    process.stderr.write(`error: ${msg}\n`);
  }

  warn(msg: string): void {
    process.stderr.write(`warn:  ${msg}\n`);
  }

  info(msg: string): void {
    process.stderr.write(`info:  ${msg}\n`);
  }

  getHostKeyPolicy(): HostKeyPolicy {
    return this.settings.hostKeyPolicy ?? "auto-accept";
  }

  getConnectionLogMode(): ConnectionLogMode {
    return this.settings.connectionLogMode ?? "off";
  }

  getSessionRecordingMode(): SessionRecordingMode {
    return this.settings.sessionRecordingMode ?? "off";
  }

  async unsealPassword(stored: string | undefined): Promise<string | undefined> {
    if (!stored) {
      return undefined;
    }
    if (!this.unsealer) {
      if (stored.startsWith("@secret:")) {
        throw new Error(
          "Password is stored in VS Code SecretStorage, which isn't readable from the CLI. " +
            "Re-run with --password-stdin or migrate the profile to passphrase storage.",
        );
      }
      return stored;
    }
    return this.unsealer(stored);
  }

  openTerminal(opts: OpenTerminalOptions): TerminalHandle {
    const isPowerShell = /\bpwsh(\.exe)?$|\bpowershell(\.exe)?$/i.test(
      opts.shellPath,
    );
    const shellArgs = isPowerShell
      ? ["-NoProfile", "-Command", opts.command]
      : ["-c", opts.command];
    const child = spawn(opts.shellPath, shellArgs, {
      stdio: "inherit",
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    const handle = new ChildTerminalHandle(child);
    this.lastHandle = handle;
    return handle;
  }
}

class ChildTerminalHandle implements TerminalHandle {
  private readonly closeCallbacks: Array<() => void> = [];

  constructor(private readonly child: import("child_process").ChildProcess) {
    child.on("exit", () => {
      for (const cb of this.closeCallbacks.splice(0)) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    });
  }

  associateResources(_res: { file?: string; server?: import("net").Server }): void {
    // The CLI's cleanup story is simpler — the spawned child inherits
    // the cleanup responsibility via the shell commands themselves
    // (trap EXIT / try-finally Remove-Item), and on the parent side
    // the orphan sweep handles anything that slipped past. We don't
    // need a per-terminal map here.
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  dispose(): void {
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  /** Promise that resolves with the child's exit code. */
  waitForExit(): Promise<number | null> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) {
        resolve(this.child.exitCode);
        return;
      }
      this.child.on("exit", (code) => resolve(code));
    });
  }
}
