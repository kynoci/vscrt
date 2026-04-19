/**
 * Runs `ssh-copy-id` to deploy a public key to a remote host using a
 * one-time password for authentication. Mirrors the temp-file sshpass
 * pattern used by the normal connect flow so the OTP never hits argv.
 */

import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { CRTConfigNode } from "../../config/vscrtConfigTypes";
import { log } from "../../log";
import {
  expandTilde,
  getSshpassCommand,
  resolveEndpoint,
} from "./helpers";
import { writeSecurePasswordFile } from "./passwordDelivery";

const execFileAsync = promisify(execFile);

export interface InstallKeyResult {
  success: boolean;
  message: string;
}

export async function installPublicKey(
  node: CRTConfigNode,
  oneTimePassword: string,
  options: { timeoutSeconds?: number } = {},
): Promise<InstallKeyResult> {
  if (!node.identityFile?.trim()) {
    return {
      success: false,
      message: "identityFile is not set on this node.",
    };
  }
  const privateKeyPath = expandTilde(node.identityFile);
  const publicKeyPath = `${privateKeyPath}.pub`;
  if (!fs.existsSync(publicKeyPath)) {
    return {
      success: false,
      message: `Public key not found at ${publicKeyPath}. Generate a keypair first.`,
    };
  }

  const { target, port } = resolveEndpoint(node);
  const timeoutMs = (options.timeoutSeconds ?? 30) * 1000;

  let pwdFile: string | undefined;
  try {
    pwdFile = await writeSecurePasswordFile(oneTimePassword);
    const sshpassCmd = getSshpassCommand();
    const args = [
      "-f",
      pwdFile,
      "ssh-copy-id",
      "-i",
      publicKeyPath,
      "-o",
      "PreferredAuthentications=password",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      String(port),
      target,
    ];
    log.debug("installPublicKey:", sshpassCmd, args.join(" "));
    const { stdout } = await execFileAsync(sshpassCmd, args, {
      timeout: timeoutMs,
      encoding: "utf-8",
    });
    return {
      success: true,
      message: (stdout || "Public key installed.").trim(),
    };
  } catch (err) {
    return {
      success: false,
      message: classifyInstallError(err),
    };
  } finally {
    if (pwdFile) {
      fs.promises.unlink(pwdFile).catch((err: unknown) => {
        log.debug(`cleanup: failed to unlink key-install pwd file: ${err}`);
      });
    }
  }
}

interface ExecError {
  code?: string | number;
  stderr?: string;
  killed?: boolean;
}

/** Exported for unit testing the error mapping. */
export function classifyInstallError(err: unknown): string {
  const e = (err ?? {}) as ExecError;
  if (typeof e.code === "string") {
    if (e.code === "ENOENT") {
      return "sshpass or ssh-copy-id is not on PATH.";
    }
    return `Failed to start: ${e.code}`;
  }
  if (e.killed) {
    return "Timed out while installing the key.";
  }
  const stderr = (typeof e.stderr === "string" ? e.stderr : "")
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  if (stderr) {
    const lower = stderr.toLowerCase();
    if (lower.includes("permission denied")) {
      return `Authentication failed (${stderr}).`;
    }
    return stderr;
  }
  return `ssh-copy-id exited ${typeof e.code === "number" ? e.code : "?"}`;
}
