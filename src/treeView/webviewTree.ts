import * as os from "os";
import * as vscode from "vscode";
import { CRTConfigService } from "../config/vscrtConfig";
import { log } from "../log";
import { readLastN } from "../remote";
import { badgeFor, buildLastStatusMap } from "./connectionStatus";
import { CRTTarget } from "./treeTarget";
import { renderWebviewHtml } from "./webviewTreeHtml";
import {
  COMMAND_IDS,
  W2E,
  WebviewItem,
  collectExpandablePaths,
  configToItems,
  pruneStaleExpanded,
} from "./webviewTreeModel";

/**
 * Hosts the connection tree as a webview. Owns the view's lifecycle,
 * handles messages from the injected script (see webviewTreeHtml.ts), and
 * translates them into VS Code command invocations or config-service calls.
 */
export class CRTWebviewProvider implements vscode.WebviewViewProvider {
  /**
   * globalState key for the persisted expand/collapse set. Versioned
   * shape so a future schema change can be detected and reset
   * cleanly rather than corrupting the UI on a downgrade.
   *
   * See docs/PLAN_3_REMEMBER_TREE_EXPAND_COLLAPSE.md for the
   * requirements contract (R1–R5) this field satisfies.
   */
  private static readonly STATE_KEY = "vscrt.tree.expandedPaths";
  private static readonly STATE_VERSION = 1;

  private view?: vscode.WebviewView;
  private readonly expanded: Set<string>;
  private initialExpandDone = false;
  /** True when `loadPersisted` found a valid record in globalState
   *  — used to distinguish "first-ever install" (expand all) from
   *  "user previously collapsed everything" (leave alone). */
  private readonly hasEverPersisted: boolean;
  /** Coalesces bursts of toggles into one globalState write per tick
   *  (plan R5). */
  private persistPending = false;

  constructor(
    private readonly configManager: CRTConfigService,
    private readonly extensionUri: vscode.Uri,
    private readonly context?: vscode.ExtensionContext,
  ) {
    const persisted = this.loadPersisted();
    this.expanded = persisted.set;
    this.hasEverPersisted = persisted.hadRecord;
  }

  /**
   * Read the persisted expanded-path set from globalState. Tolerates
   * absent / corrupt / forward-incompat shapes by falling back to an
   * empty set — the first-run bootstrap path will then re-expand all.
   *
   * Returns BOTH the set and a flag saying whether a valid record was
   * found, because an empty-but-valid record (user collapsed
   * everything yesterday) and a missing record (never installed
   * before) warrant different bootstrap behaviour.
   */
  private loadPersisted(): { set: Set<string>; hadRecord: boolean } {
    if (!this.context) {
      return { set: new Set(), hadRecord: false };
    }
    const raw = this.context.globalState.get<unknown>(
      CRTWebviewProvider.STATE_KEY,
    );
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as { version?: unknown }).version ===
        CRTWebviewProvider.STATE_VERSION &&
      Array.isArray((raw as { paths?: unknown }).paths)
    ) {
      const paths = (raw as { paths: unknown[] }).paths.filter(
        (p): p is string => typeof p === "string",
      );
      return { set: new Set(paths), hadRecord: true };
    }
    return { set: new Set(), hadRecord: false };
  }

  /**
   * Schedule a globalState write. Multiple back-to-back calls within
   * the same event-loop tick coalesce into a single `update` — a user
   * clicking through a deeply-nested tree pays one disk hit, not N.
   */
  private schedulePersist(): void {
    if (!this.context) {return;}
    if (this.persistPending) {return;}
    this.persistPending = true;
    queueMicrotask(() => {
      this.persistPending = false;
      if (!this.context) {return;}
      void this.context.globalState.update(CRTWebviewProvider.STATE_KEY, {
        version: CRTWebviewProvider.STATE_VERSION,
        paths: [...this.expanded],
      });
    });
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    const codiconsRoot = vscode.Uri.joinPath(
      this.extensionUri,
      "node_modules",
      "@vscode",
      "codicons",
      "dist",
    );
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [codiconsRoot, mediaRoot],
    };
    webviewView.webview.html = renderWebviewHtml(
      webviewView.webview,
      this.extensionUri,
    );

    webviewView.webview.onDidReceiveMessage(async (msg: W2E) => {
      if (!msg) {
        return;
      }
      try {
        await this.handleMessage(msg);
      } catch (err) {
        log.error("webview message handler error:", err);
      }
    });
  }

  async reload(): Promise<void> {
    await this.postTree();
  }

  private async handleMessage(msg: W2E): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.postTree();
        return;
      case "toggle":
        if (msg.expanded) {
          this.expanded.add(msg.path);
        } else {
          this.expanded.delete(msg.path);
        }
        this.schedulePersist();
        return;
      case "invoke":
        await this.handleInvoke(msg);
        return;
      case "move":
        await this.handleMove(msg);
        
    }
  }

  private async handleInvoke(
    msg: Extract<W2E, { type: "invoke" }>,
  ): Promise<void> {
    const commandId = COMMAND_IDS[msg.command];
    if (!commandId) {
      // Silent no-op here used to mask a real bug: the context-menu
      // entry was posting an enum value that wasn't in COMMAND_IDS,
      // so users saw nothing happen when they clicked. Always log so
      // the Output Log exposes the misalignment.
      log.warn(
        `webview handleInvoke: no VS Code command mapped for "${msg.command}" — check COMMAND_IDS in webviewTreeModel.ts.`,
      );
      return;
    }

    // Bulk commands take a `{ paths: string[] }` payload instead of a
    // single CRTTarget. They don't need resolution here — the handler
    // resolves each path against the live config.
    if (
      msg.command === "bulkConnect" ||
      msg.command === "bulkTest" ||
      msg.command === "bulkDelete"
    ) {
      await vscode.commands.executeCommand(commandId, {
        paths: msg.paths ?? [],
      });
      return;
    }

    const forwardsOpts =
      msg.command === "connect" || msg.command === "connectAllInFolder";
    const opts =
      forwardsOpts && (msg.trigger || msg.location)
        ? { trigger: msg.trigger, location: msg.location }
        : undefined;

    // Root-level invocations pass no target.
    if (!msg.targetPath || !msg.targetKind) {
      if (opts) {
        await vscode.commands.executeCommand(commandId, undefined, opts);
      } else {
        await vscode.commands.executeCommand(commandId);
      }
      return;
    }

    const target = await this.buildTarget(msg.targetPath, msg.targetKind);
    if (!target) {
      vscode.window.showErrorMessage(
        `vsCRT: could not resolve "${msg.targetPath}" in config.`,
      );
      return;
    }
    if (opts) {
      await vscode.commands.executeCommand(commandId, target, opts);
    } else {
      await vscode.commands.executeCommand(commandId, target);
    }
  }

  private async buildTarget(
    path: string,
    kind: "cluster" | "subcluster" | "node",
  ): Promise<CRTTarget | null> {
    const label = path.split("/").pop() ?? path;
    if (kind === "node") {
      const node = await this.configManager.getNodeByPath(path);
      if (!node) {
        return null;
      }
      return { item: { type: "node", path, label: node.name, config: node } };
    }
    return { item: { type: kind, path, label } };
  }

  private async handleMove(
    msg: Extract<W2E, { type: "move" }>,
  ): Promise<void> {
    const ok =
      msg.sourceKind === "node"
        ? await this.configManager.moveNode(
            msg.sourcePath,
            msg.targetPath,
            msg.targetKind,
            msg.position,
          )
        : await this.configManager.moveCluster(
            msg.sourcePath,
            msg.targetPath,
            msg.targetKind,
            msg.position,
          );
    if (ok) {
      await this.postTree();
    }
  }

  private async postTree(): Promise<void> {
    if (!this.view) {
      return;
    }
    const cfg = await this.configManager.loadConfig();
    const items = cfg ? configToItems(cfg) : [];

    // Attach last-connection badges derived from the audit log. Cheap
    // best-effort: if the log doesn't exist (logging disabled) we
    // silently skip.
    try {
      const entries = await readLastN(os.homedir(), 500);
      if (entries.length > 0) {
        const status = buildLastStatusMap(entries);
        applyBadges(items, status);
      }
    } catch (err) {
      log.debug("postTree: connection-log badge derivation failed:", err);
    }

    if (!this.initialExpandDone) {
      this.initialExpandDone = true;
      if (this.hasEverPersisted) {
        // Restored from globalState — prune paths that disappeared
        // while the user was away, persist only if the prune
        // actually removed anything.
        if (pruneStaleExpanded(items, this.expanded) > 0) {
          this.schedulePersist();
        }
      } else {
        // First-ever render on a fresh install — keep the original
        // "expand everything so the user sees the full tree"
        // behaviour, then persist so the next reload short-circuits
        // to the restored branch above.
        collectExpandablePaths(items, this.expanded);
        this.schedulePersist();
      }
    } else {
      // Drop paths that no longer exist after a mutation; persist
      // the smaller set only when something actually changed.
      if (pruneStaleExpanded(items, this.expanded) > 0) {
        this.schedulePersist();
      }
    }

    this.view.webview.postMessage({
      type: "tree",
      items,
      expanded: [...this.expanded],
    });
  }
}

function applyBadges(
  items: WebviewItem[],
  status: Map<string, { outcome: "started" | "connected" | "failed" | "cancelled"; at: number; errorMessage?: string }>,
): void {
  const walk = (list: WebviewItem[]): void => {
    for (const item of list) {
      if (item.type === "node") {
        const badge = badgeFor(status.get(item.label));
        if (badge) {
          item.badge = badge;
        }
      }
      if (item.children) {
        walk(item.children);
      }
    }
  };
  walk(items);
}
