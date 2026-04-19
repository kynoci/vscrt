/**
 * Long-lived remote session plumbing — the `SshInvocation` type plus
 * `buildSshInvocation` and `ChildTracker`. Complementary to the
 * one-shot action surface (`connect` / `sftp` / `test`) in
 * `../actions/`: an `SshInvocation` packages one remote profile into
 * the exact argv + auth setup so a caller can fire many short
 * `ssh`/`sftp` children over time (the pattern the SFTP Browser uses).
 *
 * Host-agnostic. `buildSshInvocation` takes a plain `unsealPassword`
 * callback instead of a VS Code `SecretService` — so the CLI and the
 * extension both feed it their own `HostAdapter.unsealPassword`.
 */

import * as fs from "fs";
import type { ChildProcess } from "child_process";
import { CRTConfigNode } from "../../config/vscrtConfigTypes";
import { ResolvedAuthMode } from "./authResolver";
import {
  HostKeyCheckMode,
  buildBaseSshArgs,
  expandTilde,
  getSshCommand,
  getSshpassCommand,
} from "./helpers";
import { writeSecurePasswordFile } from "./passwordDelivery";

// ─── Child-process tracker ──────────────────────────────────────────
/**
 * Per-session child-process registry. Runners register every spawned
 * child here so the UI's Cancel button can `SIGTERM` them as a group.
 * Each `track(child)` returns an untrack function the runner must call
 * on close/error; cancel is cooperative — we don't rely on children
 * emitting further events after we signal them.
 */
export class ChildTracker {
  private active = new Set<ChildProcess>();

  track(proc: ChildProcess): () => void {
    this.active.add(proc);
    return () => {
      this.active.delete(proc);
    };
  }

  /** Returns the count of children that were alive and got signalled. */
  cancelAll(): number {
    let n = 0;
    for (const p of this.active) {
      try {
        p.kill("SIGTERM");
        n += 1;
      } catch {
        // Already exited / racing with normal close — not worth surfacing.
      }
    }
    this.active.clear();
    return n;
  }

  /** For tests. Avoid reaching into this from production code. */
  get size(): number {
    return this.active.size;
  }
}

// ─── SshInvocation ──────────────────────────────────────────────────
/**
 * Packaged argv + auth setup for spawning ssh / sftp children against
 * one remote node. Built once per session (panel open, CLI batch,
 * etc.) by `buildSshInvocation` and passed to every runner.
 */
export interface SshInvocation {
  /** Only populated in password-auto mode: `[-f, <pwdfile>]`. */
  passwordArgs: string[];
  /** `sshpass` or `sshpass.exe` (only set when passwordArgs is non-empty). */
  command: string;
  /** ssh / ssh.exe command name, for building argv. */
  sshCommand: string;
  /** ssh flags (`-p 22`, `-o StrictHostKeyChecking=yes`, `-i <key>`, …). */
  sshArgs: string[];
  target: string;
  cleanup: () => void;
  /**
   * Child-process tracker bound to this session. Runners register
   * every spawned child here so a Cancel action can kill the group.
   */
  tracker?: ChildTracker;
}

// ─── buildSshInvocation ─────────────────────────────────────────────

/**
 * Resolve a stored-password field into plaintext. Matches
 * `HostAdapter.unsealPassword` so the VS Code adapter and the CLI's
 * `NodeHostAdapter` both plug in natively.
 */
export type UnsealPassword = (
  stored: string | undefined,
) => Promise<string | undefined>;

export interface BuildInvocationOptions {
  node: CRTConfigNode;
  target: string;
  port: number;
  authMode: ResolvedAuthMode;
  hostKeyCheck: HostKeyCheckMode;
  /**
   * Resolves `node.password` into plaintext for password-auto mode.
   * Wire to `HostAdapter.unsealPassword` (or any equivalent).
   * Ignored by non-password auth modes.
   */
  unsealPassword: UnsealPassword;
}

export async function buildSshInvocation(
  opts: BuildInvocationOptions,
): Promise<SshInvocation> {
  const { node, target, port, authMode, hostKeyCheck, unsealPassword } = opts;
  const rawSshArgs = buildBaseSshArgs(node, port, { hostKeyCheck });
  const sshArgs = rawSshArgs.flatMap((a) => a.split(" "));
  const sshCommand = getSshCommand();

  if (authMode === "publickey" && node.identityFile?.trim()) {
    const keyPath = expandTilde(node.identityFile);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`identityFile does not exist: ${keyPath}`);
    }
    sshArgs.push("-i", keyPath);
  }

  if (authMode === "password-auto") {
    const plaintext = await unsealPassword(node.password);
    if (!plaintext) {
      throw new Error(
        `No stored password for "${node.name}". Set one via Change Password, or switch to publickey.`,
      );
    }
    const pwdFile = await writeSecurePasswordFile(plaintext);
    // sshpass + password auth needs four option pins to work reliably
    // across both `ssh <cmd>` and `sftp -b -` invocations:
    //   - BatchMode=no                        — CRITICAL. OpenSSH's
    //       `sftp -b` hardcodes `-oBatchMode=yes` into the internal
    //       ssh subprocess, which disables ALL password prompts.
    //       sshpass has nothing to feed, auth fails silently with
    //       "Permission denied (publickey,password)". ssh uses
    //       first-occurrence-wins for -o, so pinning BatchMode=no
    //       BEFORE the sftp-added `-oBatchMode=yes` overrides it.
    //       (Plain `ssh <cmd>` doesn't need this — BatchMode=no is
    //       the default when -b isn't in play.)
    //   - PreferredAuthentications=password   — force password first,
    //       otherwise ssh tries pubkey/agent and sshpass's one-shot
    //       feed lands on the wrong prompt.
    //   - PubkeyAuthentication=no             — belt-and-braces, kills
    //       pubkey entirely so the pty only ever sees a password prompt.
    //   - NumberOfPasswordPrompts=1           — match sshpass's single
    //       password feed; extra prompts would hang the session.
    sshArgs.push(
      "-o",
      "BatchMode=no",
      "-o",
      "PreferredAuthentications=password",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
    return {
      passwordArgs: ["-f", pwdFile],
      command: getSshpassCommand(),
      sshCommand,
      sshArgs,
      target,
      cleanup: () => {
        try {
          fs.unlinkSync(pwdFile);
        } catch {
          // best-effort
        }
      },
    };
  }

  return {
    passwordArgs: [],
    command: sshCommand,
    sshCommand,
    sshArgs,
    target,
    cleanup: () => undefined,
  };
}
