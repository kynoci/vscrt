/**
 * handleOpenLocalPane — resolve a local-pane start directory and
 * send an `openLocalPaneAt` back to the webview (or
 * `localPaneDismissed` if the user cancels).
 *
 * Two entry paths:
 *   - Split-button preset: `preset` is set → resolve the named
 *     destination directly (workspace / downloads / home / custom)
 *     and skip the QuickPick. The main "⇆ Local" toolbar button
 *     opens directly at the workspace; dropdown items jump to the
 *     other presets.
 *   - No preset: pop a QuickPick built from
 *     `collectLocalStartCandidates`. Retained as a fallback when
 *     `preset === "workspace"` but no VS Code workspace is open.
 */
import * as os from "os";
import * as vscode from "vscode";
import {
  type LocalStartCandidate,
  collectLocalStartCandidates,
  resolveDownloadsDir,
} from "../panelHost/localStartFolders";
import type { E2W, W2E } from "../types";

type OpenLocalPanePreset = NonNullable<
  Extract<W2E, { type: "openLocalPane" }>["preset"]
>;

interface Deps {
  /** Injectable so tests can stub the OS file dialog. */
  showOpenDialog?: typeof vscode.window.showOpenDialog;
  /** Injectable for tests. */
  showQuickPick?: typeof vscode.window.showQuickPick;
}

export async function handleOpenLocalPane(
  lastLocalPath: string | undefined,
  post: (msg: E2W) => void,
  persist: (p: string) => Promise<void>,
  injectables: Deps = {},
  preset?: OpenLocalPanePreset,
): Promise<void> {
  const showQuickPick =
    injectables.showQuickPick ?? vscode.window.showQuickPick;
  const showOpenDialog =
    injectables.showOpenDialog ?? vscode.window.showOpenDialog;

  // Phase-9 split-button fast paths — no QuickPick.
  if (preset) {
    const target = await resolvePreset(preset, showOpenDialog);
    if (target === null) {
      post({ type: "localPaneDismissed" });
      return;
    }
    if (target === "FALL_THROUGH") {
      // preset=workspace but no workspace — fall through to the full
      // QuickPick so the user can still pick Downloads / Home / etc.
    } else {
      post({ type: "openLocalPaneAt", path: target });
      void persist(target);
      return;
    }
  }

  const candidates = collectLocalStartCandidates({
    workspace: vscode.workspace.workspaceFolders,
    homeDir: os.homedir(),
    lastPath: lastLocalPath,
  });

  interface Item extends vscode.QuickPickItem {
    candidate: LocalStartCandidate;
  }
  const items: Item[] = candidates.map((c) => ({
    label: `$(${c.icon}) ${c.label}`,
    description: c.description,
    candidate: c,
  }));

  const picked = await showQuickPick(items, {
    title: "vsCRT: Open local pane at…",
    placeHolder: "Pick a starting directory for the local pane",
    matchOnDescription: true,
  });
  if (!picked) {
    post({ type: "localPaneDismissed" });
    return;
  }

  let target = picked.candidate.path;
  if (picked.candidate.id === "custom") {
    const chosen = await showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Open local pane here",
    });
    if (!chosen || chosen.length === 0) {
      post({ type: "localPaneDismissed" });
      return;
    }
    target = chosen[0].fsPath;
  }

  post({ type: "openLocalPaneAt", path: target });
  // Fire-and-forget persist so next open remembers where we were.
  void persist(target);
}

/**
 * Resolve a split-button preset to an absolute directory path.
 * Returns:
 *   - string          → open here
 *   - null            → user cancelled the OS picker (preset=custom)
 *   - "FALL_THROUGH"  → preset=workspace, no workspace open → caller
 *                       should fall back to the full QuickPick
 */
async function resolvePreset(
  preset: OpenLocalPanePreset,
  showOpenDialog: typeof vscode.window.showOpenDialog,
): Promise<string | null | "FALL_THROUGH"> {
  switch (preset) {
    case "workspace": {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        return "FALL_THROUGH";
      }
      return folders[0].uri.fsPath;
    }
    case "downloads":
      return resolveDownloadsDir(os.homedir(), process.platform, process.env);
    case "home":
      return os.homedir();
    case "custom": {
      const chosen = await showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Open local pane here",
      });
      if (!chosen || chosen.length === 0) {
        return null;
      }
      return chosen[0].fsPath;
    }
  }
}
