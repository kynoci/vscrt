/**
 * SFTP Browser panel lifecycle.
 *
 * Resolves auth mode, spawns the webview panel, constructs an
 * `OpContext`, wires the message bus, and registers cleanup hooks.
 */
import * as vscode from "vscode";
import type { CRTConfigNode } from "../../config/vscrtConfig";
import { formatError } from "../../errorUtils";
import { log } from "../../log";
import {
  ChildTracker,
  type SftpAction,
  buildSshInvocation,
  listRemoteDirectory,
  normalizeRemotePath,
  recordSftpFileOp,
  resolveEndpoint,
  resolveHostKeyCheck,
  resolveNonInteractiveAuthMode,
} from "../../remote";
import type { CommandDeps } from "../types";
import { OpContext, dispatchMessage } from "./messageBus";
import { buildWebviewHtml } from "./panelHost/buildHtml";
import { readLastPath, writeLastPath } from "./panelHost/persistPath";
import {
  readLastLocalPath,
  writeLastLocalPath,
} from "./panelHost/persistLocalPath";
import type { E2W, W2E } from "./types";

/** Panels keyed by node name so we reuse instead of duplicating. */
const panelRegistry = new Map<string, vscode.WebviewPanel>();

export async function launchBrowser(
  node: CRTConfigNode,
  deps: CommandDeps,
): Promise<void> {
  // Dedup: if this node already has a panel, reveal it.
  const existing = panelRegistry.get(node.name);
  if (existing) {
    existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active);
    return;
  }

  // Use the non-interactive resolver so a node with a stored
  // password but no explicit `preferredAuthentication` field still
  // lands on password-auto (sshpass path) — otherwise it would fall
  // to "password-manual" and we'd bail below, or ssh would run with
  // no credentials and every `runSshRemote` call would reject with
  // "Command failed …" in the panel status bar.
  const authMode = resolveNonInteractiveAuthMode(node);
  log.info(
    `openSftpBrowser "${node.name}": resolved authMode=${authMode} ` +
      `(preferred=${node.preferredAuthentication ?? "—"}, ` +
      `hasPassword=${!!node.password?.trim()}, ` +
      `hasIdentityFile=${!!node.identityFile?.trim()})`,
  );
  if (authMode === "password-manual") {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "vsCRT: SFTP browser (preview) needs a stored password, publickey, or ssh-agent. " +
          "This node is set to manual password entry — use 'Open SFTP…' for an interactive session instead.",
      ),
    );
    return;
  }

  const { target, port } = resolveEndpoint(node);
  const hostKeyCheck = await resolveHostKeyCheck(node, target, port);
  if (hostKeyCheck === null) {
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "vscrt.sftpBrowser",
    `SFTP: ${node.name}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(deps.context.extensionUri, "media"),
      ],
    },
  );
  panelRegistry.set(node.name, panel);
  panel.webview.html = buildWebviewHtml(panel.webview, deps);

  const post = (msg: E2W): void => {
    void panel.webview.postMessage(msg);
  };
  const postBusy = (busy: boolean): void => post({ type: "busy", busy });
  const postError = (err: unknown, fallback: string): void => {
    log.warn(`SFTP browser: ${fallback}:`, err);
    post({ type: "error", message: formatError(err) || fallback });
  };
  const postInfo = (message: string): void => post({ type: "info", message });

  const invocation = await buildSshInvocation({
    node,
    target,
    port,
    authMode,
    hostKeyCheck,
    unsealPassword: deps.secretService
      ? deps.secretService.unseal.bind(deps.secretService)
      : async (stored) => stored,
  });

  /**
   * Fire-and-forget audit-log helper bound to this panel's node +
   * target. Swallows its own errors — the underlying
   * `recordSftpFileOp` also guards with its own catch.
   */
  const logOp = (
    action: SftpAction,
    succeeded: boolean,
    remotePath?: string,
    errMsg?: string,
  ): void => {
    void recordSftpFileOp(
      node,
      target,
      port,
      action,
      succeeded,
      remotePath,
      errMsg,
    );
  };

  const tracker = new ChildTracker();
  const cancelAll = (): number => tracker.cancelAll();
  // Thread the tracker through so every subsequent runSshRemote /
  // runSftpBatch call without an explicit tracker defaults to ours.
  invocation.tracker = tracker;

  const runLs = async (rawPath: string): Promise<void> => {
    const p = normalizeRemotePath(rawPath);
    postBusy(true);
    try {
      const entries = await listRemoteDirectory(invocation, p, tracker);
      post({ type: "listing", path: p, entries });
      logOp("list", true, p);
    } catch (err) {
      postError(err, `ls failed at ${p}`);
      logOp("list", false, p, formatError(err));
    } finally {
      postBusy(false);
    }
  };

  // Dispatcher table lives in `./messageBus.ts`. The `satisfies`
  // constraint there enforces that every W2E case has a handler at
  // compile time.
  const opContext: OpContext = {
    invocation,
    post,
    postInfo,
    postError,
    postBusy,
    runLs,
    logOp,
    cancelAll,
    deps,
    node,
    target,
    readLastPath: () => readLastPath(deps.context, node.name),
    writeLastPath: (p) => writeLastPath(deps.context, node.name, p),
    readLastLocalPath: () => readLastLocalPath(deps.context, node.name),
    writeLastLocalPath: (p) => writeLastLocalPath(deps.context, node.name, p),
  };
  const msgSub = panel.webview.onDidReceiveMessage(async (msg: W2E) => {
    await dispatchMessage(opContext, msg);
  });

  panel.onDidDispose(() => {
    panelRegistry.delete(node.name);
    msgSub.dispose();
    invocation.cleanup();
  });
}
