/**
 * Session runners — short-lived ssh / sftp children spawned against
 * an `SshInvocation` built by `session.ts`. Four flavours:
 *
 *   runSshRemote         — `ssh <host> <cmd>` with stdout captured to
 *                          a string. Used for single-command probes
 *                          (test -d, ls -d, mkdir -p, readlink).
 *   runSftpBatch         — `sftp -b - <host>` with lines piped on
 *                          stdin. The SFTP Browser's primary mutation
 *                          channel (mkdir / rm / rename / put / get).
 *   runSshDownloadToFile — `ssh <host> cat <remote>` piped to a local
 *                          file stream. sshpass-compatible download
 *                          path because sftp's inner ssh subprocess
 *                          doesn't share a PTY with sshpass.
 *   listRemoteDirectory  — `ssh <host> LC_ALL=C ls -la <dir>` → parse.
 *
 * Every runner accepts an optional `ChildTracker` (defaults to the
 * invocation's tracker) so callers can group-cancel in-flight children
 * via the SFTP Browser's Cancel button or the CLI's signal-handling.
 */

import * as fs from "fs";
import { execFile, spawn } from "child_process";
import { log } from "../../log";
import type { ChildTracker, SshInvocation } from "./session";
import { sshArgsToSftpArgs } from "./helpers";
import {
  FileEntry,
  parseLsLong,
  shellQuoteRemotePath,
} from "./lsOutputParser";

const SFTP_BIN = process.platform === "win32" ? "sftp.exe" : "sftp";

// ─── runSshRemote ───────────────────────────────────────────────────
/**
 * Run `ssh <target> <remoteCmd>` and resolve with stdout (string).
 * Rejects with a clean `"remote command failed: <first stderr line>"`
 * error instead of Node's opaque `"Command failed: …"` boilerplate.
 * Full argv + stderr land in the Output Log for diagnostics.
 */
export function runSshRemote(
  inv: SshInvocation,
  remoteCmd: string,
  tracker: ChildTracker | undefined = inv.tracker,
): Promise<string> {
  const command = inv.passwordArgs.length ? inv.command : inv.sshCommand;
  const argv = inv.passwordArgs.length
    ? [...inv.passwordArgs, inv.sshCommand, ...inv.sshArgs, inv.target, remoteCmd]
    : [...inv.sshArgs, inv.target, remoteCmd];
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      argv,
      {
        timeout: 30_000,
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        untrack?.();
        if (err) {
          const stderrTrim =
            typeof stderr === "string" ? stderr.trim() : "";
          log.warn(
            `runSshRemote failed for "${inv.target}": cmd=${command} ` +
              `argv=${JSON.stringify(argv)} ` +
              `stderr=${JSON.stringify(stderrTrim)}`,
          );
          const firstLine = stderrTrim.split("\n")[0] || "";
          const wrapped = new Error(
            firstLine
              ? `remote command failed: ${firstLine}`
              : `remote command failed (exit ${
                  (err as { code?: number | string }).code ?? "?"
                })`,
          );
          reject(wrapped);
        } else {
          resolve(typeof stdout === "string" ? stdout : String(stdout));
        }
      },
    );
    const untrack = tracker?.track(child);
  });
}

// ─── runSftpBatch ───────────────────────────────────────────────────
/**
 * Run a multi-line sftp script by piping it on stdin to `sftp -b -`.
 * Non-zero exit rejects with the captured stderr so upstream error
 * paths can surface the remote refusal verbatim. Cancellation via
 * `ChildTracker` emits `SIGTERM` and the close-handler surfaces that
 * as a `"Cancelled"` rejection (distinguishable from a real failure).
 */
export function runSftpBatch(
  inv: SshInvocation,
  lines: string[],
  tracker: ChildTracker | undefined = inv.tracker,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = inv.passwordArgs.length ? inv.command : SFTP_BIN;
    // sftp takes -P (uppercase) for the port; sshArgs was built via
    // the ssh convention (-p). Translate at the sftp boundary so ssh
    // call sites keep working unchanged.
    const sftpArgs = sshArgsToSftpArgs(inv.sshArgs);
    const argv = inv.passwordArgs.length
      ? [...inv.passwordArgs, SFTP_BIN, "-b", "-", ...sftpArgs, inv.target]
      : ["-b", "-", ...sftpArgs, inv.target];
    log.info(
      `runSftpBatch: cmd=${command} argv=${JSON.stringify(argv)} ` +
        `lines=${JSON.stringify(lines)}`,
    );
    const proc = spawn(command, argv, { stdio: ["pipe", "pipe", "pipe"] });
    const untrack = tracker?.track(proc);
    const stderrBufs: Buffer[] = [];
    proc.stderr.on("data", (b: Buffer) => stderrBufs.push(b));
    proc.on("error", (err) => {
      untrack?.();
      reject(err);
    });
    proc.on("close", (code, signal) => {
      untrack?.();
      const stderrFull = Buffer.concat(stderrBufs).toString("utf-8").trim();
      if (code === 0) {
        if (stderrFull) {
          log.info(`runSftpBatch ok; stderr (non-empty): ${stderrFull}`);
        }
        resolve();
      } else if (signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new Error("Cancelled"));
      } else {
        log.warn(
          `runSftpBatch failed code=${code} stderr=${JSON.stringify(stderrFull)}`,
        );
        reject(new Error(stderrFull || `sftp batch exited with code ${code}`));
      }
    });
    proc.stdin.write(lines.join("\n") + "\n");
    proc.stdin.end();
  });
}

// ─── runSshDownloadToFile ───────────────────────────────────────────
/**
 * `ssh user@host 'cat REMOTE' > LOCAL` — sshpass-compatible download.
 *
 * `sftp -b -` spawns `ssh` internally using pipes (not a PTY). sshpass
 * can only intercept password prompts on a PTY, so sftp's inner ssh
 * password prompt goes unanswered and auth fails with
 * "Permission denied (publickey,password)". This runner mirrors
 * `runSshRemote`'s argv but pipes stdout to a local file stream.
 * Trade-offs vs `sftp get`: no metadata preservation, no resume, one
 * file per ssh session — the SFTP Browser's drag-download path
 * accepts these in exchange for password-auto compatibility.
 */
export function runSshDownloadToFile(
  inv: SshInvocation,
  remotePath: string,
  localPath: string,
  tracker: ChildTracker | undefined = inv.tracker,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = inv.passwordArgs.length ? inv.command : inv.sshCommand;
    const remoteCmd = `cat -- ${shellQuoteRemotePath(remotePath)}`;
    const argv = inv.passwordArgs.length
      ? [
          ...inv.passwordArgs,
          inv.sshCommand,
          ...inv.sshArgs,
          inv.target,
          remoteCmd,
        ]
      : [...inv.sshArgs, inv.target, remoteCmd];

    const writeStream = fs.createWriteStream(localPath);
    let writeError: Error | null = null;
    writeStream.on("error", (err) => {
      writeError = err;
    });

    const proc = spawn(command, argv, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const untrack = tracker?.track(proc);
    proc.stdout.pipe(writeStream);

    const stderrBufs: Buffer[] = [];
    proc.stderr.on("data", (b: Buffer) => stderrBufs.push(b));

    proc.on("error", (err) => {
      untrack?.();
      writeStream.destroy();
      reject(err);
    });

    proc.on("close", (code, signal) => {
      untrack?.();
      writeStream.end(() => {
        if (writeError) {
          reject(writeError);
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          reject(new Error("Cancelled"));
          return;
        }
        const err = Buffer.concat(stderrBufs).toString("utf-8").trim();
        reject(new Error(err || `ssh cat exited with code ${code}`));
      });
    });
  });
}

// ─── runSshUploadFromFile ───────────────────────────────────────────
/**
 * `ssh user@host 'cat > REMOTE' < LOCAL` — sshpass-compatible upload.
 *
 * Symmetric to `runSshDownloadToFile`: avoids `sftp -b -`, which
 * hardcodes `BatchMode=yes` on sftp's internal ssh child in a way
 * that `-oBatchMode=no` can't override, starving sshpass of the
 * password feed and surfacing as "Permission denied
 * (publickey,password)" even when the exact same invocation's
 * `runSshRemote` succeeds. Using `ssh` directly keeps the PTY that
 * sshpass needs intact.
 *
 * Trade-offs vs `sftp put`: no mtime / perms preservation, no resume,
 * one file per ssh session. The SFTP Browser's upload path accepts
 * these in exchange for password-auto compatibility. Callers using
 * publickey / agent auth can still prefer `sftp put` via
 * `runSftpBatch` — `sftp -b -` works fine without sshpass in the mix.
 */
export function runSshUploadFromFile(
  inv: SshInvocation,
  localPath: string,
  remotePath: string,
  tracker: ChildTracker | undefined = inv.tracker,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = inv.passwordArgs.length ? inv.command : inv.sshCommand;
    // `cat >` + shell-quoted path — identical quoting rules as sftp put
    // since both land in the remote user's shell.
    const remoteCmd = `cat > ${shellQuoteRemotePath(remotePath)}`;
    const argv = inv.passwordArgs.length
      ? [
          ...inv.passwordArgs,
          inv.sshCommand,
          ...inv.sshArgs,
          inv.target,
          remoteCmd,
        ]
      : [...inv.sshArgs, inv.target, remoteCmd];

    let readError: Error | null = null;
    const readStream = fs.createReadStream(localPath);
    readStream.on("error", (err) => {
      readError = err;
    });

    const proc = spawn(command, argv, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const untrack = tracker?.track(proc);
    readStream.pipe(proc.stdin);

    const stderrBufs: Buffer[] = [];
    proc.stderr.on("data", (b: Buffer) => stderrBufs.push(b));

    proc.on("error", (err) => {
      untrack?.();
      readStream.destroy();
      reject(err);
    });

    proc.on("close", (code, signal) => {
      untrack?.();
      if (readError) {
        reject(readError);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new Error("Cancelled"));
        return;
      }
      const err = Buffer.concat(stderrBufs).toString("utf-8").trim();
      reject(new Error(err || `ssh upload exited with code ${code}`));
    });
  });
}

// ─── listRemoteDirectory ────────────────────────────────────────────
/**
 * List a remote directory by running `LC_ALL=C ls -la` over ssh and
 * parsing the stdout via `parseLsLong`. `LC_ALL=C` keeps month names
 * in English + predictable column order; `shellQuoteRemotePath`
 * handles tilde expansion safely.
 */
export async function listRemoteDirectory(
  inv: SshInvocation,
  remotePath: string,
  tracker?: ChildTracker,
): Promise<FileEntry[]> {
  const stdout = await runSshRemote(
    inv,
    `LC_ALL=C ls -la ${shellQuoteRemotePath(remotePath)}`,
    tracker,
  );
  return parseLsLong(stdout);
}
