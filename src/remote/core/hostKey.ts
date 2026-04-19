/**
 * Host-key verification helpers. Wraps `ssh-keyscan`, `ssh-keygen -F`,
 * `ssh-keygen -lf` and direct known_hosts writes so the connect flow can
 * do trust-on-first-use (TOFU) inside the extension — users see an
 * explicit modal with the SHA-256 fingerprint before a key ever lands in
 * `~/.ssh/known_hosts`.
 *
 * Why not rely on ssh's own `StrictHostKeyChecking=ask`? That prompt
 * appears inside the spawned terminal, after the connection attempt has
 * started. By pre-verifying here we can (a) show the fingerprint in a
 * native VS Code modal, (b) cancel cleanly without a dangling terminal,
 * and (c) emit `StrictHostKeyChecking=yes` on the actual connect — so
 * ssh itself never silently auto-accepts.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type HostKeyPolicy = "auto-accept" | "prompt-on-first" | "strict";

export function parseHostKeyPolicy(value: unknown): HostKeyPolicy {
  if (
    value === "auto-accept" ||
    value === "prompt-on-first" ||
    value === "strict"
  ) {
    return value;
  }
  return "prompt-on-first";
}

/**
 * Strip any leading `user@` and any trailing `:port` from an SSH target
 * string. Returns just the hostname — what `ssh-keyscan` and
 * `ssh-keygen -F` expect.
 */
export function extractHost(target: string): string {
  let h = target;
  const at = h.lastIndexOf("@");
  if (at >= 0) {
    h = h.slice(at + 1);
  }
  return h;
}

/**
 * `ssh-keygen -F` renders the search key as `[host]:port` when port is
 * non-default. Match that exactly so lookups hit IPv6-bracketed entries.
 */
export function formatKnownHostsKey(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export function defaultKnownHostsPath(): string {
  return path.join(os.homedir(), ".ssh", "known_hosts");
}

/**
 * `ssh-keygen -F <key>` exits 0 if the key has a matching line in
 * known_hosts, 1 otherwise. We surface that as a boolean; a missing
 * `ssh-keygen` binary is treated as "don't know" (caller decides).
 */
export async function isHostKnown(
  host: string,
  port: number,
  knownHostsPath: string = defaultKnownHostsPath(),
): Promise<boolean> {
  if (!fs.existsSync(knownHostsPath)) {
    return false;
  }
  const key = formatKnownHostsKey(host, port);
  try {
    await execFileAsync(
      "ssh-keygen",
      ["-F", key, "-f", knownHostsPath],
      { timeout: 5000, encoding: "utf-8" },
    );
    return true;
  } catch {
    return false;
  }
}

export interface ScannedKey {
  /** Raw known_hosts-formatted line, ready to append. */
  line: string;
  /** Key type (ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa, …). */
  keyType: string;
}

/**
 * Run `ssh-keyscan` against the host and return the first usable key
 * line. We ask for ed25519 preferentially, falling back to ecdsa then
 * rsa — matching OpenSSH's default `HostKeyAlgorithms` ordering.
 */
export async function scanHostKey(
  host: string,
  port: number,
  options: { timeoutSeconds?: number } = {},
): Promise<ScannedKey | null> {
  const timeoutS = options.timeoutSeconds ?? 5;
  const args = [
    "-T",
    String(timeoutS),
    "-t",
    "ed25519,ecdsa,rsa",
    "-p",
    String(port),
    host,
  ];
  try {
    const { stdout } = await execFileAsync("ssh-keyscan", args, {
      timeout: (timeoutS + 2) * 1000,
      encoding: "utf-8",
    });
    return pickPreferredKey(stdout);
  } catch {
    return null;
  }
}

/**
 * `ssh-keyscan` prints multiple lines, one per key type. Pick the
 * strongest (ed25519 > ecdsa > rsa). Comment lines (`# host ...`) and
 * blanks are ignored.
 */
export function pickPreferredKey(stdout: string): ScannedKey | null {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) {
    return null;
  }
  const rank = (l: string): number => {
    if (/\bssh-ed25519\b/.test(l)) {
      return 0;
    }
    if (/\becdsa-sha2-nistp\d+\b/.test(l)) {
      return 1;
    }
    if (/\bssh-rsa\b/.test(l)) {
      return 2;
    }
    return 3;
  };
  const sorted = lines.slice().sort((a, b) => rank(a) - rank(b));
  const best = sorted[0];
  const parts = best.split(/\s+/);
  // known_hosts format: <hostspec> <keytype> <base64> [comment]
  const keyType = parts[1] ?? "ssh-unknown";
  return { line: best, keyType };
}

/**
 * Pipe a single known_hosts line through `ssh-keygen -lf -` to extract
 * the SHA-256 fingerprint. Returns e.g. `SHA256:abc…`.
 */
export async function computeFingerprint(line: string): Promise<string | null> {
  try {
    // -l = print fingerprint; -f - = read key from stdin.
    const child = execFile("ssh-keygen", ["-lf", "-"], { timeout: 5000 });
    const stdoutChunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stdin?.write(line + "\n");
    child.stdin?.end();
    const exitCode: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
    });
    if (exitCode !== 0) {
      return null;
    }
    const out = Buffer.concat(stdoutChunks).toString("utf-8");
    const m = out.match(/SHA256:[A-Za-z0-9+/=]+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/**
 * Append a single known_hosts line to the file, creating `~/.ssh` with
 * mode 0700 and the file with mode 0600 if missing. Writes are
 * append-only so existing entries for other hosts are never rewritten.
 */
export async function appendKnownHostsLine(
  line: string,
  knownHostsPath: string = defaultKnownHostsPath(),
): Promise<void> {
  const dir = path.dirname(knownHostsPath);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(knownHostsPath)) {
    await fs.promises.writeFile(knownHostsPath, "", { mode: 0o600 });
  }
  const suffix = line.endsWith("\n") ? line : line + "\n";
  await fs.promises.appendFile(knownHostsPath, suffix, { encoding: "utf-8" });
}

/**
 * Wrap `ssh-keygen -R [host]:port` so a rotated host key can be cleared
 * from the in-extension flow. ssh-keygen itself writes a `.old` backup
 * of the prior file.
 */
export async function removeHostFromKnownHosts(
  host: string,
  port: number,
  knownHostsPath: string = defaultKnownHostsPath(),
): Promise<{ removed: boolean; message: string }> {
  if (!fs.existsSync(knownHostsPath)) {
    return { removed: false, message: "known_hosts file does not exist." };
  }
  const key = formatKnownHostsKey(host, port);
  try {
    const { stdout, stderr } = await execFileAsync(
      "ssh-keygen",
      ["-R", key, "-f", knownHostsPath],
      { timeout: 5000, encoding: "utf-8" },
    );
    const text = (stdout + stderr).trim();
    // ssh-keygen says "not found in <file>" when the host is absent.
    if (/not found/i.test(text)) {
      return { removed: false, message: `No entry for ${key}.` };
    }
    return { removed: true, message: `Removed ${key} from known_hosts.` };
  } catch (err) {
    return {
      removed: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
