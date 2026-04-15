import * as vscode from "vscode";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { randomBytes, randomUUID } from "crypto";
import { promisify } from "util";

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

interface TerminalResources {
  files: string[];
  servers: net.Server[];
}
const terminalResources = new Map<vscode.Terminal, TerminalResources>();

export type ShellKind = "powershell" | "wsl" | "bash" | "cmd" | "unknown";

export function detectShellKind(shellPath?: string): ShellKind {
  const resolved = shellPath ?? resolveDefaultShellPath();
  if (!resolved) {
    return "unknown";
  }
  const base = path.basename(resolved).toLowerCase();
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
      console.warn(
        "[vsCRT] icacls failed; default NTFS ACL will be used instead:",
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

export function toWslPath(winPath: string): string {
  const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) {
    return winPath;
  }
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

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
    fs.promises.unlink(f).catch(() => {
      /* already gone */
    });
    trackedFiles.delete(f);
  }
  for (const s of slot.servers) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
    trackedServers.delete(s);
  }
  terminalResources.delete(term);
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
  terminalResources.clear();
}

function psSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
