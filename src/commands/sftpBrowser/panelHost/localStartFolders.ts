/**
 * Local-pane start-folder candidates.
 *
 * When the user clicks the toolbar ⇆ Local button from the hidden
 * state, vsCRT pops a QuickPick built from this helper: "Workspace
 * folder", "Downloads", "Home", "Last location", and a "Choose
 * folder…" escape hatch.
 *
 * Kept pure — no `vscode` / `fs` / `os` imports — so tests can stub
 * the workspace list + homedir + platform without reaching into real
 * globals. Only the env/platform lookup for Linux's
 * `$XDG_DOWNLOAD_DIR` is parameterised.
 */
import * as path from "path";

export type LocalStartCandidateId =
  | "workspace"
  | "downloads"
  | "home"
  | "custom"
  | "last";

export interface LocalStartCandidate {
  id: LocalStartCandidateId;
  label: string;
  description: string;
  path: string;
  /** Codicon name without the `codicon-` prefix. */
  icon: string;
}

/** Minimal workspace-folder shape — avoids importing vscode types. */
export interface WorkspaceFolderLike {
  name: string;
  uri: { fsPath: string };
}

export interface CollectOptions {
  workspace?: readonly WorkspaceFolderLike[];
  homeDir: string;
  lastPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the per-platform "Downloads" path. Returns the absolute
 * path; the caller is responsible for skipping it if the user has no
 * such directory.
 *
 * - Linux / BSD: respect `$XDG_DOWNLOAD_DIR` when set, else
 *   `~/Downloads`.
 * - Windows / macOS / everywhere else: `~/Downloads`. On Windows a
 *   future round could call `SHGetKnownFolderPath(FOLDERID_Downloads)`
 *   for redirection support — deferred.
 */
export function resolveDownloadsDir(
  homeDir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    const xdg = env.XDG_DOWNLOAD_DIR;
    if (typeof xdg === "string" && xdg.trim()) {
      return xdg;
    }
  }
  return path.join(homeDir, "Downloads");
}

/**
 * Build the ordered candidate list for the QuickPick. Order is
 * chosen for UX: workspace folders first (most contextually
 * relevant), then Downloads, then Home, then Last (only if
 * non-empty), and a "Choose folder…" escape at the end.
 */
export function collectLocalStartCandidates(
  opts: CollectOptions,
): LocalStartCandidate[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const out: LocalStartCandidate[] = [];

  // Workspace folders — one row per root. Most users have 0 or 1;
  // multi-root workspaces get a row each.
  for (const ws of opts.workspace ?? []) {
    if (!ws || typeof ws.uri?.fsPath !== "string") {
      continue;
    }
    out.push({
      id: "workspace",
      label: `Workspace — ${ws.name}`,
      description: ws.uri.fsPath,
      path: ws.uri.fsPath,
      icon: "file-directory",
    });
  }

  out.push({
    id: "downloads",
    label: "Downloads",
    description: resolveDownloadsDir(opts.homeDir, platform, env),
    path: resolveDownloadsDir(opts.homeDir, platform, env),
    icon: "cloud-download",
  });

  out.push({
    id: "home",
    label: "Home",
    description: opts.homeDir,
    path: opts.homeDir,
    icon: "home",
  });

  if (opts.lastPath && opts.lastPath.trim()) {
    out.push({
      id: "last",
      label: "Last location",
      description: opts.lastPath,
      path: opts.lastPath,
      icon: "history",
    });
  }

  out.push({
    id: "custom",
    label: "Choose folder…",
    description: "Pick any directory via the OS file dialog",
    path: "",
    icon: "folder-opened",
  });

  return out;
}
