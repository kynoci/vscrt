/**
 * Interactive SFTP session — host-agnostic version.
 *
 * Same architecture as `connect.ts`: resolve auth mode, run the TOFU
 * dance if needed, build the argv, hand off to the `HostAdapter` to
 * spawn a shell session. The only differences are:
 *
 *   - `sftp` binary instead of `ssh`
 *   - Port flag is uppercase `-P` (via `sshArgsToSftpArgs`)
 *   - No host-key policy bypass at argv level — the shared
 *     `resolveHostKeyCheck` in `actions/connect.ts` emits the same
 *     modal / readline flow so both shells behave the same way.
 */

import * as fs from "fs";
import { CRTConfigNode } from "../../config/vscrtConfigTypes";
import { PassphraseCancelled } from "../../config/vscrtPassphraseErrors";
import { formatError } from "../../errorUtils";
import { log } from "../../log";
import {
  recordConnectStart,
  recordSessionMetadata,
} from "../telemetry/sessionTelemetry";
import {
  buildBaseSshArgs,
  expandTilde,
  getSftpCommand,
  getSshpassCommand,
  resolveEndpoint,
  sshArgsToSftpArgs,
} from "../core/helpers";
import { resolveAuthMode } from "../core/authResolver";
import {
  psSingleQuote,
  shSingleQuote,
  writeSecurePasswordFile,
} from "../core/passwordDelivery";
import { HostAdapter, TerminalLocation } from "../host/hostAdapter";
import { resolveHostKeyCheck } from "./connect";

const WINDOWS_SHELL = "powershell.exe";
const UNIX_SHELL = "/bin/bash";

export interface SftpOptions {
  location?: TerminalLocation;
}

export interface BuildSftpShellCommandOptions {
  platform: NodeJS.Platform;
  sftpCmd: string;
  sshArgs: string[];
  target: string;
  /** Set only for password-auto: tempfile path passed to `sshpass -f`. */
  pwdFile?: string;
  /** `sshpass.exe` / `sshpass` — required when `pwdFile` is set. */
  sshpassCmd?: string;
  /** Set only for publickey with a pinned identityFile. */
  identityFile?: string;
}

/**
 * Pure — build the full shell command string we send to the spawned
 * terminal. Does single-quote wrapping via `shSingleQuote` (POSIX) or
 * `psSingleQuote` (PowerShell) for every path that user input can
 * influence. `sshArgs` is joined verbatim — the caller must have
 * validated those via the schema-level patterns (`JUMP_HOST_RE`,
 * `PORT_FORWARD_RE`).
 */
export function buildSftpShellCommand(
  opts: BuildSftpShellCommandOptions,
): string {
  const isWindows = opts.platform === "win32";
  const quote = isWindows ? psSingleQuote : shSingleQuote;
  const argv: string[] = [];
  if (opts.pwdFile) {
    if (!opts.sshpassCmd) {
      throw new Error(
        "buildSftpShellCommand: sshpassCmd is required when pwdFile is set",
      );
    }
    argv.push(quote(opts.sshpassCmd), "-f", quote(opts.pwdFile));
  }
  argv.push(quote(opts.sftpCmd));
  argv.push(...sshArgsToSftpArgs(opts.sshArgs));
  if (opts.identityFile) {
    argv.push("-i", quote(opts.identityFile));
  }
  argv.push(quote(opts.target));
  const joined = argv.join(" ");
  return isWindows ? `& { & ${joined} }` : joined;
}

export async function sftp(
  node: CRTConfigNode,
  host: HostAdapter,
  opts: SftpOptions = {},
): Promise<void> {
  const location = opts.location ?? "panel";
  const { target, port } = resolveEndpoint(node);
  const mode = resolveAuthMode(node);
  const sftpCmd = getSftpCommand();
  const isWindows = process.platform === "win32";

  log.info(
    `sftp: "${node.name}" → ${target}:${port} (mode=${mode}, location=${location})`,
  );

  const hostKeyCheck = await log.timed(
    `hostKeyCheck for ${target}:${port}`,
    () => resolveHostKeyCheck(node, target, port, host),
    { slowMs: 500 },
  );
  if (hostKeyCheck === null) {
    log.info(`sftp: "${node.name}" aborted at host-key step.`);
    return;
  }

  const sshArgs = buildBaseSshArgs(node, port, { hostKeyCheck });

  void recordConnectStart(node, target, port, mode, host, "sftp");
  void recordSessionMetadata(node, target, port, mode, host, "sftp");

  if (mode === "password-auto") {
    const sshpassCmd = getSshpassCommand();

    let plaintext: string | undefined;
    try {
      plaintext = await host.unsealPassword(node.password);
    } catch (err) {
      if (err instanceof PassphraseCancelled) {
        return;
      }
      host.error(
        `vsCRT: could not read password for "${node.name}": ${formatError(err)}`,
      );
      return;
    }
    if (!plaintext) {
      host.error(
        `vsCRT: no password stored for "${node.name}". Use "Change Password" to set one.`,
      );
      return;
    }

    const pwdFile = await writeSecurePasswordFile(plaintext);
    const cmd = buildSftpShellCommand({
      platform: process.platform,
      sftpCmd,
      sshArgs,
      target,
      pwdFile,
      sshpassCmd,
    });
    const handle = host.openTerminal({
      name: `${node.name} (SFTP)`,
      shellPath: isWindows ? WINDOWS_SHELL : UNIX_SHELL,
      command: cmd,
      env: node.env,
      location,
    });
    handle.associateResources({ file: pwdFile });
    return;
  }

  if (mode === "publickey" || mode === "agent") {
    let identityFile: string | undefined;
    if (mode === "publickey" && node.identityFile?.trim()) {
      identityFile = expandTilde(node.identityFile);
      if (!fs.existsSync(identityFile)) {
        host.error(`vsCRT: identityFile does not exist: ${identityFile}`);
        return;
      }
    }
    const cmd = buildSftpShellCommand({
      platform: process.platform,
      sftpCmd,
      sshArgs,
      target,
      identityFile,
    });
    host.openTerminal({
      name: `${node.name} (SFTP)`,
      shellPath: isWindows ? WINDOWS_SHELL : UNIX_SHELL,
      command: cmd,
      env: node.env,
      location,
    });
    return;
  }

  // password-manual — sftp prompts in-terminal, same as ssh's manual flow.
  const cmd = buildSftpShellCommand({
    platform: process.platform,
    sftpCmd,
    sshArgs,
    target,
  });
  host.openTerminal({
    name: `${node.name} (SFTP)`,
    shellPath: isWindows ? WINDOWS_SHELL : UNIX_SHELL,
    command: cmd,
    env: node.env,
    location,
  });
}
