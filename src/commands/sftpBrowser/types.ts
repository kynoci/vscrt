/**
 * Shared type shapes for the SFTP-browser module tree.
 *
 * Kept type-only (zero runtime code) so every `sftpBrowser/**` module
 * can import from here without pulling in runtime deps or triggering
 * circular imports. `vscode` / `child_process` types are OK —
 * TypeScript strips them from emitted JS.
 */
import type { FileEntry, SftpAction } from "../../remote";

/* ---------------------------------------------------------------------
 *   Remote listing
 * ------------------------------------------------------------------- */

export interface ListResult {
  path: string;
  entries: FileEntry[];
}

/* ---------------------------------------------------------------------
 *   Webview → Extension messages (W2E)
 * ------------------------------------------------------------------- */

/** Messages sent from the webview back to the extension host. */
export type W2E =
  | { type: "ready" }
  | { type: "list"; path: string }
  | { type: "download"; remotePath: string; name: string; sizeBytes?: number }
  | { type: "bulkDownload"; remotePaths: string[] }
  | { type: "upload"; intoPath: string }
  | { type: "dropUpload"; intoPath: string; localPaths: string[] }
  | { type: "localList"; path: string }
  | { type: "delete"; path: string; kind: FileEntry["kind"] }
  | { type: "bulkDelete"; items: { path: string; kind: FileEntry["kind"] }[] }
  | { type: "mkdir"; intoPath: string }
  | { type: "rename"; oldPath: string; newName: string }
  | { type: "chmod"; path: string; currentPerms: string }
  | { type: "preview"; path: string; size: number }
  | { type: "followSymlink"; path: string }
  | { type: "copyPath"; path: string }
  | { type: "copyScpPath"; path: string }
  | { type: "cancel" }
  | { type: "persistPath"; path: string }
  | {
      type: "openLocalPane";
      /**
       * Phase-9 split-button shortcut. When set, the host resolves
       * the target directory without popping the QuickPick:
       *   - "workspace" → first VS Code workspace folder (falls back
       *     to the full QuickPick if no workspace is open)
       *   - "downloads" / "home" → OS-standard path directly
       *   - "custom" → straight to the native folder picker
       * When absent, the old Phase-8 QuickPick is shown.
       */
      preset?: "workspace" | "downloads" | "home" | "custom";
    }
  | { type: "persistLocalPath"; path: string }
  | {
      type: "downloadToLocalDir";
      remotePaths: string[];
      intoLocalPath: string;
    }
  | { type: "localRename"; oldPath: string; newName: string }
  | { type: "localDelete"; path: string; kind: LocalFileEntry["kind"] }
  | {
      type: "bulkLocalDelete";
      items: { path: string; kind: LocalFileEntry["kind"] }[];
    };

/* ---------------------------------------------------------------------
 *   Extension → Webview messages (E2W)
 * ------------------------------------------------------------------- */

/** A single row in the local-pane listing (E1 two-pane view). */
export interface LocalFileEntry {
  name: string;
  kind: "dir" | "file" | "other";
  size: number;
  mtime: string;
  /**
   * POSIX mode string like `drwxr-xr-x`. Present on Linux / macOS,
   * omitted on Windows (where `stat.mode` doesn't carry meaningful
   * user/group/other permission bits).
   */
  perms?: string;
}

// Forward-reference workaround: the W2E union above needs
// `LocalFileEntry["kind"]`, but we also want `LocalFileEntry` to stay
// where it semantically belongs (with the other E2W-related types).
// Plain TypeScript allows forward references for type-only positions.

/** Messages posted from the extension host into the webview. */
export type E2W =
  | { type: "init"; serverName: string; initialPath: string }
  | ({ type: "listing" } & ListResult)
  | { type: "error"; message: string }
  | { type: "info"; message: string }
  | { type: "busy"; busy: boolean }
  | {
      type: "localListing";
      path: string;
      entries: LocalFileEntry[];
      error?: string;
    }
  | { type: "openLocalPaneAt"; path: string }
  | { type: "localPaneDismissed" };

/* ---------------------------------------------------------------------
 *   Audit-log callback
 * ------------------------------------------------------------------- */

/**
 * Fire-and-forget audit-log callback shape. Bound per-panel in
 * `launchBrowser` against the current node so every op just hands in
 * action / success / path — the sessionTelemetry glue is elsewhere.
 */
export type LogOp = (
  action: SftpAction,
  succeeded: boolean,
  remotePath?: string,
  errMsg?: string,
) => void;

// `SshInvocation` now lives in `src/remote/core/session.ts`. Re-export
// it here so the existing callers inside sftpBrowser can keep
// importing from `./types` without churn.
export type { SshInvocation } from "../../remote";
