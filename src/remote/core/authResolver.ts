import { CRTConfigNode } from "../../config/vscrtConfigTypes";

export type ResolvedAuthMode =
  | "publickey"
  | "agent"
  | "password-auto"
  | "password-manual";

export interface AuthResolutionContext {
  /** Whether `SSH_AUTH_SOCK` (POSIX) / SSH agent pipe (Windows) is available. */
  agentAvailable: boolean;
}

/**
 * Decide which delivery code-path to take for a node. Agent mode fires
 * when the user asked for publickey auth but didn't pin a specific
 * `identityFile` — in which case `ssh` relies on whichever keys are
 * already loaded in the running ssh-agent.
 *
 * If the user set `identityFile`, it always takes precedence — their
 * explicit pin is a signal that they want that specific key, not
 * whatever happens to be in the agent.
 */
export function resolveAuthMode(
  node: CRTConfigNode,
  ctx: AuthResolutionContext = { agentAvailable: hasSshAuthSock() },
): ResolvedAuthMode {
  const preferred = node.preferredAuthentication?.trim();
  const hasPassword = !!node.password?.trim();
  const hasIdentityFile = !!node.identityFile?.trim();

  if (preferred === "publickey") {
    if (hasIdentityFile) {
      return "publickey";
    }
    if (ctx.agentAvailable) {
      return "agent";
    }
    // No identity file and no agent — fall through to publickey so ssh
    // can still try ~/.ssh/id_* conventional paths. The caller will
    // emit a clearer error than we could.
    return "publickey";
  }

  if (preferred === "password") {
    return hasPassword ? "password-auto" : "password-manual";
  }

  return "password-manual";
}

/**
 * Cheap check for ssh-agent readiness. On POSIX this is `SSH_AUTH_SOCK`;
 * on Windows the agent surfaces as a named pipe and the env var is less
 * universal — we fall back to `SSH_AUTH_SOCK` on both since OpenSSH
 * for Windows and WSL both respect it when set.
 */
export function hasSshAuthSock(env: NodeJS.ProcessEnv = process.env): boolean {
  const sock = env.SSH_AUTH_SOCK;
  return typeof sock === "string" && sock.length > 0;
}

/**
 * Auth-mode resolver specialized for **non-interactive** flows — Test
 * Connection, SFTP browser, any caller that doesn't have a terminal
 * to show a password prompt in.
 *
 * `resolveAuthMode` returns `"password-manual"` whenever the node has
 * no `preferredAuthentication` set — even if a password IS stored.
 * The regular connect flow survives that because ssh prompts inside
 * the spawned terminal and the user types. Non-interactive flows
 * can't prompt, so they'd fail immediately with either:
 *   - the caller bailing on `"password-manual"` ("needs a stored
 *     password, publickey, or ssh-agent"), or
 *   - ssh falling through to a no-credentials attempt and exiting
 *     non-zero ("Command failed …").
 *
 * This helper promotes to `"password-auto"` whenever a password is
 * stored and no `identityFile` is pinned — i.e. the clear signal the
 * user meant password auth. Callers that DO have a pinned key keep
 * the normal resolution, because the pinned key is the more specific
 * signal.
 */
export function resolveNonInteractiveAuthMode(
  node: { password?: string; identityFile?: string; preferredAuthentication?: string },
  ctx?: { agentAvailable: boolean },
): ResolvedAuthMode {
  const base = ctx
    ? resolveAuthMode(node as import("../../config/vscrtConfigTypes").CRTConfigNode, ctx)
    : resolveAuthMode(node as import("../../config/vscrtConfigTypes").CRTConfigNode);
  if (
    base === "password-manual" &&
    !!node.password?.trim() &&
    !node.identityFile?.trim()
  ) {
    return "password-auto";
  }
  return base;
}
