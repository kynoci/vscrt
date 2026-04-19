/**
 * Message-bus dispatch table.
 *
 * Typed map from `W2E["type"]` to its dispatcher. The `satisfies`
 * constraint at the bottom makes the TypeScript compiler reject a
 * new `W2E` case that forgets to wire a handler — same class of bug
 * as the recent `openSftpBrowser` ctxmenu entry missing from
 * `COMMAND_IDS`.
 *
 * Each dispatcher accepts the full `OpContext` plus the narrowed
 * message; this lets individual handlers ignore fields they don't
 * need without caller-side plumbing.
 */
import * as vscode from "vscode";
import { handleBulkDelete } from "./ops/bulkDelete";
import { handleBulkDownload } from "./ops/bulkDownload";
import { handleChmod } from "./ops/chmod";
import { handleDelete } from "./ops/delete";
import { handleDownload } from "./ops/download";
import { handleDownloadToLocalDir } from "./ops/downloadToLocalDir";
import { handleDropUpload } from "./ops/dropUpload";
import { handleFollowSymlink } from "./ops/followSymlink";
import { handleBulkLocalDelete } from "./ops/bulkLocalDelete";
import { handleLocalDelete } from "./ops/localDelete";
import { handleLocalList } from "./ops/localList";
import { handleLocalRename } from "./ops/localRename";
import { handleMkdir } from "./ops/mkdir";
import { handleOpenLocalPane } from "./ops/openLocalPane";
import { handlePreview } from "./ops/preview";
import { handleRename } from "./ops/rename";
import { handleUpload } from "./ops/upload";
import { toScpPath } from "../sftpBrowserHelpers";
import type { CommandDeps } from "../types";
import type { E2W, LogOp, SshInvocation, W2E } from "./types";
import type { CRTConfigNode } from "../../config/vscrtConfig";

/**
 * Everything an op-dispatcher might need, passed as a single object
 * so each handler can destructure the bits it cares about.
 * `readLastPath` / `writeLastPath` live here for the `ready` /
 * `persistPath` cases; `runLs` for every navigation-triggering op;
 * `cancelAll` for the Cancel button.
 */
export interface OpContext {
  invocation: SshInvocation;
  post: (msg: E2W) => void;
  postInfo: (msg: string) => void;
  postError: (err: unknown, fallback: string) => void;
  postBusy: (busy: boolean) => void;
  runLs: (p: string) => Promise<void>;
  logOp: LogOp;
  cancelAll: () => number;
  deps: CommandDeps;
  node: CRTConfigNode;
  target: string;
  readLastPath: () => string | undefined;
  writeLastPath: (p: string) => Promise<void>;
  readLastLocalPath: () => string | undefined;
  writeLastLocalPath: (p: string) => Promise<void>;
}

/** Per-message dispatcher. */
type Dispatcher<M> = (ctx: OpContext, msg: M) => Promise<void>;

/** Map of every W2E case to its dispatcher. `satisfies` enforces
 *  exhaustiveness — add a new W2E variant without wiring a
 *  dispatcher here and the build fails. */
export const dispatchers = {
  ready: async (ctx, _msg) => {
    const initialPath = ctx.readLastPath() ?? "~";
    ctx.post({
      type: "init",
      serverName: ctx.node.name,
      initialPath,
    });
    await ctx.runLs(initialPath);

    // Auto-open the local pane when the environment makes it obvious
    // which directory to show: a VS Code workspace is open, or the user
    // previously pointed the local pane somewhere and we persisted it.
    // Never pops a QuickPick during auto-open — the user can still
    // click the "⇆ Local" button to get the full picker.
    const lastLocal = ctx.readLastLocalPath();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const autoPath = lastLocal ?? workspace;
    if (autoPath) {
      ctx.post({ type: "openLocalPaneAt", path: autoPath });
      if (!lastLocal) {
        await ctx.writeLastLocalPath(autoPath);
      }
    }
  },
  list: async (ctx, msg) => {
    await ctx.runLs(msg.path);
  },
  localList: async (ctx, msg) => {
    await handleLocalList(msg.path, ctx.post);
  },
  download: async (ctx, msg) => {
    await handleDownload(
      ctx.invocation,
      msg.remotePath,
      msg.name,
      msg.sizeBytes ?? 0,
      ctx.postInfo,
      ctx.postError,
      ctx.logOp,
    );
  },
  bulkDownload: async (ctx, msg) => {
    await handleBulkDownload(
      ctx.invocation,
      msg.remotePaths,
      ctx.postInfo,
      ctx.postError,
      ctx.logOp,
    );
  },
  upload: async (ctx, msg) => {
    await handleUpload(
      ctx.invocation,
      msg.intoPath,
      ctx.postInfo,
      ctx.postError,
      ctx.runLs,
      ctx.logOp,
    );
  },
  dropUpload: async (ctx, msg) => {
    await handleDropUpload(
      ctx.invocation,
      msg.intoPath,
      msg.localPaths,
      ctx.postInfo,
      ctx.postError,
      ctx.runLs,
      ctx.logOp,
    );
  },
  delete: async (ctx, msg) => {
    await handleDelete(
      ctx.invocation,
      msg.path,
      msg.kind,
      ctx.postInfo,
      ctx.postError,
      ctx.runLs,
      ctx.logOp,
    );
  },
  bulkDelete: async (ctx, msg) => {
    await handleBulkDelete(
      ctx.invocation,
      msg.items,
      ctx.postInfo,
      ctx.postError,
      ctx.runLs,
      ctx.logOp,
    );
  },
  mkdir: async (ctx, msg) => {
    await handleMkdir(
      ctx.invocation,
      msg.intoPath,
      ctx.postInfo,
      ctx.postError,
      ctx.postBusy,
      ctx.runLs,
      ctx.logOp,
    );
  },
  rename: async (ctx, msg) => {
    await handleRename(
      ctx.invocation,
      msg.oldPath,
      msg.newName,
      ctx.postInfo,
      ctx.postError,
      ctx.runLs,
      ctx.logOp,
    );
  },
  chmod: async (ctx, msg) => {
    await handleChmod(
      ctx.invocation,
      msg.path,
      msg.currentPerms,
      ctx.postInfo,
      ctx.postError,
      ctx.runLs,
      ctx.logOp,
    );
  },
  preview: async (ctx, msg) => {
    await handlePreview(
      ctx.invocation,
      msg.path,
      msg.size,
      ctx.postInfo,
      ctx.postError,
      ctx.logOp,
    );
  },
  followSymlink: async (ctx, msg) => {
    await handleFollowSymlink(
      ctx.invocation,
      msg.path,
      ctx.runLs,
      ctx.postError,
    );
  },
  copyPath: async (ctx, msg) => {
    await vscode.env.clipboard.writeText(msg.path);
    ctx.postInfo(`Copied: ${msg.path}`);
  },
  copyScpPath: async (ctx, msg) => {
    const p = toScpPath(ctx.target, msg.path);
    await vscode.env.clipboard.writeText(p);
    ctx.postInfo(`Copied: ${p}`);
  },
  cancel: async (ctx, _msg) => {
    const killed = ctx.cancelAll();
    ctx.postInfo(
      killed > 0
        ? `Cancelled ${killed} in-flight ${killed === 1 ? "op" : "ops"}.`
        : "Nothing in flight to cancel.",
    );
  },
  persistPath: async (ctx, msg) => {
    await ctx.writeLastPath(msg.path);
  },
  openLocalPane: async (ctx, msg) => {
    await handleOpenLocalPane(
      ctx.readLastLocalPath(),
      ctx.post,
      (p) => ctx.writeLastLocalPath(p),
      {},
      msg.preset,
    );
  },
  persistLocalPath: async (ctx, msg) => {
    await ctx.writeLastLocalPath(msg.path);
  },
  downloadToLocalDir: async (ctx, msg) => {
    await handleDownloadToLocalDir(
      ctx.invocation,
      msg.remotePaths,
      msg.intoLocalPath,
      ctx.post,
      ctx.postInfo,
      ctx.postError,
      ctx.logOp,
    );
  },
  localRename: async (ctx, msg) => {
    await handleLocalRename(
      msg.oldPath,
      msg.newName,
      ctx.post,
      ctx.postInfo,
      ctx.postError,
    );
  },
  localDelete: async (ctx, msg) => {
    await handleLocalDelete(
      msg.path,
      msg.kind,
      ctx.post,
      ctx.postInfo,
      ctx.postError,
    );
  },
  bulkLocalDelete: async (ctx, msg) => {
    await handleBulkLocalDelete(
      msg.items,
      ctx.post,
      ctx.postInfo,
      ctx.postError,
    );
  },
} satisfies {
  [T in W2E["type"]]: Dispatcher<Extract<W2E, { type: T }>>;
};

/**
 * Route a single W2E message to its dispatcher. Catches handler
 * exceptions and surfaces them via `postError` so one bad op doesn't
 * crash the panel.
 */
export async function dispatchMessage(
  ctx: OpContext,
  msg: W2E,
): Promise<void> {
  // The cast is safe — `dispatchers[msg.type]` is the narrowed
  // dispatcher for exactly this `msg` variant, but TypeScript can't
  // see that across the keyed access.
  const handler = (dispatchers as Record<string, Dispatcher<W2E>>)[msg.type];
  if (!handler) {
    return;
  }
  try {
    await handler(ctx, msg);
  } catch (err) {
    ctx.postError(err, `unhandled op ${String(msg.type)}`);
  }
}
