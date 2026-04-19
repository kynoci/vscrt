/**
 * handleFollowSymlink — resolve a remote symlink's target via
 * `readlink -f` (with BSD/macOS fallbacks) and navigate the browser
 * to the resolved path.
 */
import { runSshRemote, shellQuoteRemotePath } from "../../../remote";
import type { SshInvocation } from "../types";

export async function handleFollowSymlink(
  inv: SshInvocation,
  remotePath: string,
  runLs: (p: string) => Promise<void>,
  postError: (err: unknown, fallback: string) => void,
): Promise<void> {
  try {
    // Q4: readlink -f is GNU-specific. On BSD/macOS try the native
    // readlink (macOS 10.11+ supports -f), then greadlink (Homebrew),
    // then fall back to the path itself. stderr is silenced so the
    // final `echo` always wins when none of the tools resolve.
    const quoted = shellQuoteRemotePath(remotePath);
    const cmd =
      `readlink -f ${quoted} 2>/dev/null || ` +
      `greadlink -f ${quoted} 2>/dev/null || ` +
      `echo ${quoted}`;
    const resolved = await runSshRemote(inv, cmd);
    await runLs(resolved.trim() || remotePath);
  } catch (err) {
    postError(err, `readlink ${remotePath} failed`);
  }
}
