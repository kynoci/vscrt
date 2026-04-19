/**
 * Non-interactive SSH reachability probe — host-agnostic version.
 *
 * Same argv/flag surface as the previous `src/ssh/sshTest.ts`; the
 * only change is that settings and secret resolution go through a
 * `HostAdapter` instead of directly through `vscode.workspace` and
 * `CRTSecretService`. The CLI (`vscrt-remote test`) reuses this
 * module verbatim with a `NodeHostAdapter`.
 */

import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { CRTConfigNode } from "../../config/vscrtConfigTypes";
import { PassphraseCancelled } from "../../config/vscrtPassphraseErrors";
import { log } from "../../log";
import {
  ResolvedAuthMode,
  resolveNonInteractiveAuthMode,
} from "../core/authResolver";
import {
  expandTilde,
  getSshCommand,
  getSshpassCommand,
  resolveEndpoint,
} from "../core/helpers";
import { writeSecurePasswordFile } from "../core/passwordDelivery";
import { HostAdapter } from "../host/hostAdapter";

const execFileAsync = promisify(execFile);

export function resolveProbeAuthMode(
  node: CRTConfigNode,
  ctx?: { agentAvailable: boolean },
): ResolvedAuthMode {
  return resolveNonInteractiveAuthMode(node, ctx);
}

export type TestOutcome =
  | "connected"
  | "auth-failed"
  | "timeout"
  | "no-credentials"
  | "cancelled"
  | "error";

export interface TestResult {
  outcome: TestOutcome;
  message: string;
  exitCode?: number;
  durationMs: number;
}

export interface TestOptions {
  /** TCP + SSH timeout passed to ssh's `-o ConnectTimeout`. Default 5. */
  timeoutSeconds?: number;
}

export async function testConnection(
  node: CRTConfigNode,
  host: HostAdapter,
  options: TestOptions = {},
): Promise<TestResult> {
  const start = Date.now();
  const timeoutS = options.timeoutSeconds ?? 5;
  const { target, port } = resolveEndpoint(node);
  const sshCmd = getSshCommand();

  const mode = resolveProbeAuthMode(node);

  const policy = host.getHostKeyPolicy();
  const strictHostKey = policy === "strict" ? "yes" : "accept-new";

  const nonInteractiveBase = [
    "-o",
    `ConnectTimeout=${timeoutS}`,
    "-o",
    `StrictHostKeyChecking=${strictHostKey}`,
    "-p",
    String(port),
  ];
  const jump = node.jumpHost?.trim();
  if (jump) {
    nonInteractiveBase.push("-o", `ProxyJump=${jump}`);
  }
  const extraArgs =
    node.extraArgs?.trim().split(/\s+/).filter(Boolean) ?? [];

  let pwdFile: string | undefined;
  try {
    if (mode === "password-auto") {
      let plaintext: string | undefined;
      try {
        plaintext = await host.unsealPassword(node.password);
      } catch (err) {
        if (err instanceof PassphraseCancelled) {
          return outcome("cancelled", "Passphrase prompt dismissed.", start);
        }
        return outcome(
          "error",
          `Could not read password: ${errMessage(err)}`,
          start,
        );
      }
      if (!plaintext) {
        return outcome(
          "no-credentials",
          "No password stored. Use Change Password to set one.",
          start,
        );
      }
      pwdFile = await writeSecurePasswordFile(plaintext);
      const sshpassCmd = getSshpassCommand();
      const args = [
        "-f",
        pwdFile,
        sshCmd,
        ...nonInteractiveBase,
        ...extraArgs,
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=1",
        target,
        "exit",
      ];
      log.info(
        `testConnection (password-auto) for "${node.name}":`,
        sshpassCmd,
        JSON.stringify(args),
      );
      // `await` is load-bearing: without it the surrounding try/finally
      // unlinks the tempfile *before* sshpass has opened it, causing a
      // race where slow sshpass startup loses and ssh surfaces
      // `SSHPASS: Failed to open password file`.
      return await runAndClassify(sshpassCmd, args, start, timeoutS, node.name);
    }

    if (mode === "publickey") {
      if (!node.identityFile?.trim()) {
        return outcome(
          "no-credentials",
          "identityFile is missing. Set the private key path first.",
          start,
        );
      }
      const keyPath = expandTilde(node.identityFile);
      const args = [
        "-o",
        "BatchMode=yes",
        ...nonInteractiveBase,
        ...extraArgs,
        "-i",
        keyPath,
        "-o",
        "PreferredAuthentications=publickey",
        target,
        "exit",
      ];
      log.info(
        `testConnection (publickey) for "${node.name}":`,
        sshCmd,
        JSON.stringify(args),
      );
      return await runAndClassify(sshCmd, args, start, timeoutS, node.name);
    }

    if (mode === "agent") {
      const args = [
        "-o",
        "BatchMode=yes",
        ...nonInteractiveBase,
        ...extraArgs,
        "-o",
        "PreferredAuthentications=publickey",
        target,
        "exit",
      ];
      log.info(
        `testConnection (agent) for "${node.name}":`,
        sshCmd,
        JSON.stringify(args),
      );
      return await runAndClassify(sshCmd, args, start, timeoutS, node.name);
    }

    // password-manual — BatchMode=yes makes ssh refuse to prompt.
    const args = [
      "-o",
      "BatchMode=yes",
      ...nonInteractiveBase,
      ...extraArgs,
      target,
      "exit",
    ];
    log.info(
      `testConnection (manual) for "${node.name}":`,
      sshCmd,
      JSON.stringify(args),
    );
    return await runAndClassify(sshCmd, args, start, timeoutS, node.name);
  } finally {
    if (pwdFile) {
      fs.promises.unlink(pwdFile).catch((err: unknown) => {
        log.debug(`cleanup: failed to unlink test pwd file: ${err}`);
      });
    }
  }
}

/**
 * `ConnectTimeout` only bounds the TCP handshake — auth has no built-in
 * timeout. Scale the wall-clock kill with ConnectTimeout and floor at 30 s.
 */
export function computeKillTimeoutMs(connectTimeoutS: number): number {
  const scaled = connectTimeoutS * 4;
  const minimum = 30;
  return Math.max(scaled, minimum) * 1000;
}

async function runAndClassify(
  cmd: string,
  args: string[],
  start: number,
  timeoutS: number,
  nodeName?: string,
): Promise<TestResult> {
  const killMs = computeKillTimeoutMs(timeoutS);
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: killMs,
      encoding: "utf-8",
    });
    const durationMs = Date.now() - start;
    log.info(
      `testConnection: "${nodeName ?? "?"}" connected in ${durationMs} ms` +
        (stdout.trim() ? ` · stdout: ${stdout.trim().slice(0, 200)}` : "") +
        (stderr.trim() ? ` · stderr: ${stderr.trim().slice(0, 200)}` : ""),
    );
    return {
      outcome: "connected",
      message: "Connected and authenticated.",
      exitCode: 0,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const result = classifyError(err, durationMs);
    const e = (err ?? {}) as {
      code?: string | number;
      signal?: string | null;
      killed?: boolean;
      stderr?: string;
      stdout?: string;
    };
    log.info(
      `testConnection: "${nodeName ?? "?"}" outcome=${result.outcome} ` +
        `durationMs=${durationMs} killBudgetMs=${killMs} ` +
        `exitCode=${e.code ?? "?"} signal=${e.signal ?? "—"} ` +
        `killed=${e.killed ?? false}`,
    );
    if (typeof e.stderr === "string" && e.stderr.trim()) {
      log.info(`testConnection: stderr ⤵\n${e.stderr.trim()}`);
    }
    if (typeof e.stdout === "string" && e.stdout.trim()) {
      log.info(`testConnection: stdout ⤵\n${e.stdout.trim()}`);
    }
    log.info(`testConnection: classified message: ${result.message}`);
    return result;
  }
}

function outcome(
  outcome: TestOutcome,
  message: string,
  start: number,
): TestResult {
  return { outcome, message, durationMs: Date.now() - start };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ExecFileError {
  code?: string | number;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  killed?: boolean;
}

export function classifyError(err: unknown, durationMs: number): TestResult {
  const e = (err ?? {}) as ExecFileError;
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  const firstLine = stderr.split("\n")[0] || "";
  const exitCode = typeof e.code === "number" ? e.code : undefined;

  if (typeof e.code === "string") {
    if (e.code === "ENOENT") {
      return {
        outcome: "error",
        message: "ssh (or sshpass) is not on PATH.",
        durationMs,
      };
    }
    return {
      outcome: "error",
      message: `Failed to start: ${e.code}`,
      durationMs,
    };
  }

  if (e.killed || e.signal === "SIGTERM" || e.signal === "SIGKILL") {
    return {
      outcome: "timeout",
      message:
        "Session took longer than the test budget to establish. " +
        "Auth may be slow on this host (PAM / DNS / ProxyJump chain). " +
        "Connect itself has no timeout and may still succeed.",
      exitCode,
      durationMs,
    };
  }

  const lower = stderr.toLowerCase();
  if (
    lower.includes("load key") &&
    (lower.includes("bad passphrase") ||
      lower.includes("error in libcrypto") ||
      lower.includes("incorrect passphrase"))
  ) {
    return {
      outcome: "auth-failed",
      message:
        "Private key requires a passphrase. Add it to ssh-agent first " +
        "(ssh-add <key>), or use Connect which can prompt interactively.",
      exitCode,
      durationMs,
    };
  }
  if (
    lower.includes("no such identity") ||
    lower.includes("no such file or directory")
  ) {
    return {
      outcome: "error",
      message:
        firstLine ||
        "identityFile points to a missing file. Check the path in the server form.",
      exitCode,
      durationMs,
    };
  }
  if (lower.includes("permission denied")) {
    const isPubkeyOnlyFail =
      /permission denied\s*\(publickey\)/i.test(stderr) &&
      !lower.includes("password");
    if (isPubkeyOnlyFail) {
      return {
        outcome: "auth-failed",
        message:
          "Permission denied (publickey). If the key needs a passphrase, " +
          "add it to ssh-agent first (ssh-add <key>). Test runs " +
          "non-interactively, so Connect may still succeed where Test fails.",
        exitCode,
        durationMs,
      };
    }
    return {
      outcome: "auth-failed",
      message: firstLine || "Permission denied.",
      exitCode,
      durationMs,
    };
  }
  if (
    lower.includes("connection timed out") ||
    lower.includes("operation timed out")
  ) {
    return {
      outcome: "timeout",
      message: firstLine || "Connection timed out.",
      exitCode,
      durationMs,
    };
  }
  if (lower.includes("connection refused")) {
    return {
      outcome: "error",
      message: firstLine || "Connection refused.",
      exitCode,
      durationMs,
    };
  }
  if (lower.includes("host key verification failed")) {
    return {
      outcome: "error",
      message: firstLine || "Host key changed — verify before reconnecting.",
      exitCode,
      durationMs,
    };
  }
  if (lower.includes("no route to host")) {
    return {
      outcome: "error",
      message: firstLine || "No route to host.",
      exitCode,
      durationMs,
    };
  }

  return {
    outcome: "error",
    message: firstLine || `Exit ${exitCode ?? "?"}`,
    exitCode,
    durationMs,
  };
}
