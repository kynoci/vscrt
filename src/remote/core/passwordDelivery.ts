/**
 * Password delivery for ssh/sshpass — pure (no `vscode` imports).
 *
 * Covers the three secure delivery modes:
 *   - Named pipe (Windows) with one-time hex token auth + 60 s TTL
 *   - Loopback TCP + `/dev/tcp` (Unix) with token auth + 60 s TTL
 *   - Temp file `0o600` (+ `icacls` on Windows) with `sshpass -f`
 * Plus the argv last-resort builder, shell-safe quoters, and orphan
 * tempfile sweep.
 *
 * VS Code–specific terminal tracking (`associateTerminal`,
 * `cleanupTerminal`) lives in src/ssh/sshPasswordDelivery.ts and
 * calls into `untrackFile` / `untrackServer` below.
 */

import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { randomBytes, randomUUID } from "crypto";
import { promisify } from "util";
import { log } from "../../log";

const execFileAsync = promisify(execFile);

const PWD_FILE_PREFIX = "vsCRT-";
const PWD_FILE_SUFFIX = ".pwd";
const PIPE_PREFIX = "vsCRT-";

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const PIPE_TTL_MS = 60_000;
const PIPE_SOCKET_TIMEOUT_MS = 10_000;
const PIPE_CONNECT_TIMEOUT_MS = 5_000;

const trackedFiles = new Set<string>();
const trackedServers = new Set<net.Server>();

export type ShellKind = "powershell" | "wsl" | "bash" | "cmd" | "unknown";

/**
 * Classify a shell by its executable basename. Pure — the `detectShellKind`
 * wrapper in src/ssh/sshPasswordDelivery.ts layers on a vscode-configured
 * fallback when `shellPath` is not supplied.
 */
export function classifyShellKind(shellPath: string | undefined): ShellKind {
  if (!shellPath) {
    return "unknown";
  }
  const base = path.basename(shellPath).toLowerCase();
  if (
    base === "pwsh" ||
    base === "pwsh.exe" ||
    base === "powershell" ||
    base === "powershell.exe"
  ) {
    return "powershell";
  }
  if (base === "wsl" || base === "wsl.exe") {
    return "wsl";
  }
  if (
    base === "bash" ||
    base === "bash.exe" ||
    base === "sh" ||
    base === "zsh" ||
    base === "fish"
  ) {
    return "bash";
  }
  if (base === "cmd" || base === "cmd.exe") {
    return "cmd";
  }
  return "unknown";
}

export async function writeSecurePasswordFile(password: string): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `${PWD_FILE_PREFIX}${randomUUID()}${PWD_FILE_SUFFIX}`,
  );
  await fs.promises.writeFile(file, password, { encoding: "utf8", mode: 0o600 });

  if (process.platform === "win32") {
    try {
      await execFileAsync("icacls", [
        file,
        "/inheritance:r",
        "/grant:r",
        `${os.userInfo().username}:(R,W,D)`,
      ]);
    } catch (err) {
      log.warn(
        "icacls failed; default NTFS ACL will be used instead:",
        err,
      );
    }
  }
  trackedFiles.add(file);
  return file;
}

export interface BuildPowerShellTempfileArgs {
  sshpassCmd: string;
  pwdFile: string;
  sshCmd: string;
  sshArgs: string[];
  target: string;
}

export function buildPowerShellSshpassCommand(
  a: BuildPowerShellTempfileArgs,
): string {
  const pwd = psSingleQuote(a.pwdFile);
  const sp = psSingleQuote(a.sshpassCmd);
  const ssh = psSingleQuote(a.sshCmd);
  const tgt = psSingleQuote(a.target);
  const argsJoined = a.sshArgs.join(" ");
  return [
    "& { ",
    "Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction SilentlyContinue; ",
    `try { & ${sp} -f ${pwd} ${ssh} ${argsJoined} ${tgt} } `,
    `finally { Remove-Item -Force -ErrorAction SilentlyContinue ${pwd} } `,
    "}",
  ].join("");
}

export interface PipeServerHandle {
  pipeName: string;
  token: string;
  server: net.Server;
}

export interface LoopbackServerHandle {
  host: string;
  port: number;
  token: string;
  server: net.Server;
}

function attachPasswordSocketHandler(
  server: net.Server,
  password: string,
  token: string,
): void {
  server.on("connection", (socket) => {
    let buffer = "";
    let delivered = false;
    const killTimer = setTimeout(
      () => socket.destroy(),
      PIPE_SOCKET_TIMEOUT_MS,
    );

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (delivered) {
        return;
      }
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl === -1) {
        return;
      }
      const candidate = buffer.slice(0, nl).trim();
      if (candidate !== token) {
        socket.destroy();
        return;
      }
      delivered = true;
      socket.write(password + "\n", () => {
        socket.end();
        clearTimeout(killTimer);
        try {
          server.close();
        } catch {
          /* ignore */
        }
      });
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => clearTimeout(killTimer));
  });
}

function startServerLifetime(server: net.Server): void {
  const ttlTimer = setTimeout(() => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }, PIPE_TTL_MS);
  server.on("close", () => {
    clearTimeout(ttlTimer);
    trackedServers.delete(server);
  });
  trackedServers.add(server);
}

function listenOnce(server: net.Server, target: string | net.ListenOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => {
      server.removeListener("listening", onOk);
      reject(e);
    };
    const onOk = (): void => {
      server.removeListener("error", onErr);
      resolve();
    };
    server.once("error", onErr);
    server.once("listening", onOk);
    if (typeof target === "string") {
      server.listen(target);
    } else {
      server.listen(target);
    }
  });
}

export async function servePasswordViaPipe(
  password: string,
): Promise<PipeServerHandle> {
  if (process.platform !== "win32") {
    throw new Error("Named pipe password delivery is Windows-only.");
  }
  const pipeName = `${PIPE_PREFIX}${randomUUID()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const token = randomBytes(24).toString("hex");

  const server = net.createServer();
  attachPasswordSocketHandler(server, password, token);
  await listenOnce(server, pipePath);
  startServerLifetime(server);
  return { pipeName, token, server };
}

export async function servePasswordViaLoopback(
  password: string,
): Promise<LoopbackServerHandle> {
  const token = randomBytes(24).toString("hex");
  const server = net.createServer();
  attachPasswordSocketHandler(server, password, token);
  await listenOnce(server, { host: "127.0.0.1", port: 0 });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    throw new Error("Failed to bind loopback password server");
  }
  startServerLifetime(server);
  return { host: "127.0.0.1", port: addr.port, token, server };
}

export interface BuildPowerShellPipeArgs {
  pipeName: string;
  token: string;
  sshpassCmd: string;
  sshCmd: string;
  sshArgs: string[];
  target: string;
}

export function buildPowerShellPipeCommand(a: BuildPowerShellPipeArgs): string {
  const pn = psSingleQuote(a.pipeName);
  const tk = psSingleQuote(a.token);
  const sp = psSingleQuote(a.sshpassCmd);
  const ssh = psSingleQuote(a.sshCmd);
  const tgt = psSingleQuote(a.target);
  const argsJoined = a.sshArgs.join(" ");
  const connectMs = String(PIPE_CONNECT_TIMEOUT_MS);

  return [
    "& { ",
    "Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction SilentlyContinue; ",
    `$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', ${pn}, [System.IO.Pipes.PipeDirection]::InOut); `,
    `$pipe.Connect(${connectMs}); `,
    "$reader = New-Object System.IO.StreamReader($pipe); ",
    "$writer = New-Object System.IO.StreamWriter($pipe); $writer.AutoFlush = $true; ",
    `$writer.WriteLine(${tk}); `,
    "$pw = $reader.ReadLine(); ",
    "$pipe.Dispose(); ",
    "$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'vsCRT-' + [System.Guid]::NewGuid().ToString() + '.pwd'); ",
    "[System.IO.File]::WriteAllText($tmp, $pw); ",
    "$pw = $null; ",
    "try { & icacls $tmp /inheritance:r /grant:r \"$env:USERNAME:(R,W,D)\" *> $null } catch { } ",
    `try { & ${sp} -f $tmp ${ssh} ${argsJoined} ${tgt} } `,
    "finally { Remove-Item -Force -ErrorAction SilentlyContinue $tmp } ",
    "}",
  ].join("");
}

export interface BuildArgvSshpassArgs {
  sshpassCmd: string;
  password: string;
  sshCmd: string;
  sshArgs: string[];
  target: string;
}

/**
 * Last-resort argv password delivery for bash: `sshpass -p <pw> ssh …`. The
 * password is single-quoted so shell metacharacters ($, ", `, \, ;, |, etc.)
 * are passed literally. The tempfile and pipe paths are preferred over this
 * because argv-visible passwords leak via `ps`.
 *
 * sshArgs is joined raw — it's user config (node.extraArgs) intended to hold
 * native ssh flags like `-o KexAlgorithms=…`, so we can't quote it.
 */
export function buildBashArgvSshpassCommand(a: BuildArgvSshpassArgs): string {
  const sp = shSingleQuote(a.sshpassCmd);
  const pw = shSingleQuote(a.password);
  const ssh = shSingleQuote(a.sshCmd);
  const tgt = shSingleQuote(a.target);
  const argsJoined = a.sshArgs.join(" ");
  return [
    "HISTFILE=/dev/null; ",
    `${sp} -p ${pw} ${ssh} ${argsJoined} ${tgt}`,
  ].join("");
}

/** PowerShell counterpart to buildBashArgvSshpassCommand. */
export function buildPowerShellArgvSshpassCommand(
  a: BuildArgvSshpassArgs,
): string {
  const sp = psSingleQuote(a.sshpassCmd);
  const pw = psSingleQuote(a.password);
  const ssh = psSingleQuote(a.sshCmd);
  const tgt = psSingleQuote(a.target);
  const argsJoined = a.sshArgs.join(" ");
  return [
    "& { ",
    "Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction SilentlyContinue; ",
    `& ${sp} -p ${pw} ${ssh} ${argsJoined} ${tgt} `,
    "}",
  ].join("");
}

export interface BuildBashTempfileArgs {
  sshpassCmd: string;
  pwdFile: string;
  sshCmd: string;
  sshArgs: string[];
  target: string;
}

export function buildBashSshpassCommand(a: BuildBashTempfileArgs): string {
  const pwd = shSingleQuote(a.pwdFile);
  const sp = shSingleQuote(a.sshpassCmd);
  const ssh = shSingleQuote(a.sshCmd);
  const tgt = shSingleQuote(a.target);
  const argsJoined = a.sshArgs.join(" ");
  // Subshell scopes the EXIT trap to the sshpass invocation. In an interactive
  // bash, a top-level `trap … EXIT` would only fire when the shell itself exits.
  return [
    "HISTFILE=/dev/null; ",
    `( trap "rm -f ${pwd}" EXIT INT TERM; `,
    `${sp} -f ${pwd} ${ssh} ${argsJoined} ${tgt} )`,
  ].join("");
}

export interface BuildBashPipeArgs {
  host: string;
  port: number;
  token: string;
  sshpassCmd: string;
  sshCmd: string;
  sshArgs: string[];
  target: string;
}

/**
 * Bash one-liner that reads the password from a loopback TCP server via
 * bash's built-in /dev/tcp, authenticates with a one-time token, and pipes
 * the password to sshpass through a process-substitution fd.  The password
 * never touches disk.  Requires /bin/bash (process substitution + /dev/tcp).
 */
export function buildBashPipeCommand(a: BuildBashPipeArgs): string {
  const tk = shSingleQuote(a.token);
  const sp = shSingleQuote(a.sshpassCmd);
  const ssh = shSingleQuote(a.sshCmd);
  const tgt = shSingleQuote(a.target);
  const host = shSingleQuote(a.host);
  const port = String(a.port);
  const argsJoined = a.sshArgs.join(" ");
  const fetchPw = [
    `exec 3<>/dev/tcp/$(printf %s ${host})/${port}`,
    `printf '%s\\n' ${tk} >&3`,
    "IFS= read -r __vscrt_pw <&3",
    'printf %s "$__vscrt_pw"',
    "exec 3<&-",
  ].join("; ");
  return [
    "HISTFILE=/dev/null; ",
    `${sp} -f <(${fetchPw}) ${ssh} ${argsJoined} ${tgt}`,
  ].join("");
}

/**
 * Drop a file from the tracking set after the host has already unlinked it.
 * The shim's `cleanupTerminal` uses this so the tempfile map and the
 * module-global `trackedFiles` stay in sync.
 */
export function untrackFile(file: string): void {
  trackedFiles.delete(file);
}

/** Drop a server from tracking after it has been closed. */
export function untrackServer(server: net.Server): void {
  trackedServers.delete(server);
}

export async function cleanupOrphanFiles(
  maxAgeMs: number = ORPHAN_AGE_MS,
): Promise<void> {
  const dir = os.tmpdir();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(PWD_FILE_PREFIX) || !entry.endsWith(PWD_FILE_SUFFIX)) {
      continue;
    }
    const full = path.join(dir, entry);
    try {
      const st = await fs.promises.stat(full);
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(full);
      }
    } catch {
      /* best-effort */
    }
  }
}

export function cleanupAllNowSync(): void {
  for (const f of [...trackedFiles]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
    trackedFiles.delete(f);
  }
  for (const s of [...trackedServers]) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
    trackedServers.delete(s);
  }
}

/**
 * PowerShell single-quote escape. Single quotes are literal in PowerShell
 * (no $ expansion, no escape processing); an embedded single quote is encoded
 * as two consecutive single quotes.
 */
export function psSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * POSIX-shell single-quote escape (bash/sh/zsh). Single quotes are literal;
 * an embedded single quote is encoded by closing the string, inserting an
 * escaped `\'`, and reopening.
 */
export function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
