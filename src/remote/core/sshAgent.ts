/**
 * ssh-agent readiness probe. Cheap: reads `SSH_AUTH_SOCK` first, then
 * runs `ssh-add -l` (~5 ms) to confirm the agent is reachable and has
 * at least one key loaded.
 *
 * Split out of statusProvider.ts so unit tests can drive it without
 * pulling in the full VS Code TreeItem stack.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "../../log";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5000;

export interface SshAgentStatus {
  /** `SSH_AUTH_SOCK` set + non-empty. Cheap check; no subprocess required. */
  socketSet: boolean;
  /** True when `ssh-add -l` returned successfully with ≥1 key. */
  keysLoaded: boolean;
  /** Count of loaded keys (0 when the probe fails or socket isn't set). */
  keyCount: number;
  /** Human-readable note for the tooltip when things aren't ideal. */
  message?: string;
}

export async function detectSshAgent(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SshAgentStatus> {
  const sock = env.SSH_AUTH_SOCK;
  const socketSet = typeof sock === "string" && sock.length > 0;
  if (!socketSet) {
    return {
      socketSet: false,
      keysLoaded: false,
      keyCount: 0,
      message: "SSH_AUTH_SOCK is not set — start ssh-agent before connecting.",
    };
  }
  try {
    const { stdout } = await execFileAsync("ssh-add", ["-l"], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: "utf-8",
    });
    const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
    return {
      socketSet: true,
      keysLoaded: lines.length > 0,
      keyCount: lines.length,
    };
  } catch (err) {
    // `ssh-add -l` exits 1 when the agent has no identities (still
    // reachable), 2 when unreachable. execFileAsync rejects on non-zero
    // exits, so distinguish via stderr or exit code.
    const e = err as { code?: number; stderr?: string } | null;
    if (e?.code === 1) {
      return {
        socketSet: true,
        keysLoaded: false,
        keyCount: 0,
        message: "agent is running but no keys are loaded (run `ssh-add`).",
      };
    }
    log.warn(
      `probe \`ssh-add -l\` failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      socketSet: true,
      keysLoaded: false,
      keyCount: 0,
      message: "agent socket is set but not reachable — check ssh-agent status.",
    };
  }
}
