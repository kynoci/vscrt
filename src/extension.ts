import * as vscode from "vscode";
import * as os from "os";
import { registerAllCommands } from "./commands";
import { VscrtUriHandler } from "./commands/uriHandler";
import { CRTConfigService } from "./config/vscrtConfig";
import {
  AutoLockMode,
  CRTPassphraseService,
  autoLockModeToMs,
  parseAutoLockMode,
} from "./config/vscrtPassphrase";
import { CRTSecretService } from "./config/vscrtSecret";
import { CONFIG_FILENAME, VSCRT_HOME_NAME } from "./fsPaths";
import { log, setLogSink } from "./log";
import {
  CRTSshService,
  cleanupAllNowSync,
  cleanupOrphanFiles,
  cleanupTerminal,
} from "./remote";
import { StatusProvider } from "./status/statusProvider";
import { registerTerminalProfileProvider } from "./terminalProfile";
import { CRTWebviewProvider } from "./treeView/webviewTree";

/**
 * Opaque test-only surface exposed via `extension.exports.__test` so
 * integration tests can introspect live services without going through
 * global VS Code APIs. Never referenced by production code.
 */
export interface VscrtTestApi {
  configManager: CRTConfigService;
  passphraseService: CRTPassphraseService;
  connectionView: CRTWebviewProvider;
}

export interface VscrtExports {
  __test: VscrtTestApi;
}

export function activate(context: vscode.ExtensionContext): VscrtExports {
  // Wire the shared logger to a dedicated output channel FIRST so every
  // subsequent activation step (service construction, command registration,
  // orphan sweep) logs somewhere the user can actually find.
  const logChannel = vscode.window.createOutputChannel("vsCRT");
  context.subscriptions.push(logChannel);
  setLogSink(logChannel);
  log.info("Extension activating…");

  const passphraseService = new CRTPassphraseService(context.secrets);
  const secretService = new CRTSecretService(context.secrets, passphraseService);
  const configManager = new CRTConfigService(secretService, context.extensionUri);
  const sshService = new CRTSshService(secretService);
  context.subscriptions.push({ dispose: () => sshService.dispose() });

  // Connection view — webview-based cluster/server tree.
  // `context` is threaded in so the provider can persist the user's
  // tree expand/collapse set across window reloads and restarts
  // (PLAN 3 / globalState).
  const connectionView = new CRTWebviewProvider(
    configManager,
    context.extensionUri,
    context,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "vscrt.connectionView",
      connectionView,
    ),
  );

  // Status view — OS / WSL / sshpass availability.
  const statusProvider = new StatusProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("vscrt.statusView", statusProvider),
  );

  const deps = {
    context,
    passphraseService,
    secretService,
    configManager,
    sshService,
    connectionView,
    statusProvider,
  };
  context.subscriptions.push(...registerAllCommands(deps));

  // vscode://kynoci.vscrt/<verb>?<params> deep links — shared with the
  // CLI companion which invokes `code --open-url` against these URLs.
  context.subscriptions.push(
    vscode.window.registerUriHandler(new VscrtUriHandler(deps)),
  );

  // Native terminal-dropdown entry: "vsCRT: SSH Server" lives alongside
  // the user's default shell profiles in the `+ ▾` menu. Clicking it pops
  // a QuickPick and routes through `vsCRT.connect`.
  context.subscriptions.push(registerTerminalProfileProvider(deps));

  // Clean up password files / pipe servers when their terminal closes.
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((term) => cleanupTerminal(term)),
  );

  // Watch ~/.vscrt/vscrtConfig.json for external edits (user opens the
  // file in the editor, or another tool rewrites it). On any change,
  // invalidate the in-memory cache and ask the connection view to
  // reconcile — so users no longer need to hit Refresh manually.
  const configWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(os.homedir(), `${VSCRT_HOME_NAME}/${CONFIG_FILENAME}`),
  );
  const reloadOnExternalChange = (): void => {
    configManager.invalidateCache();
    void connectionView.reload();
  };
  configWatcher.onDidChange(reloadOnExternalChange);
  configWatcher.onDidCreate(reloadOnExternalChange);
  configWatcher.onDidDelete(reloadOnExternalChange);
  context.subscriptions.push(configWatcher);

  // Passphrase auto-lock — reads the user setting, switches between the
  // time-based idle timer and the window-focus listener, and re-applies
  // on setting changes without needing an extension reload.
  let focusLostDisposable: vscode.Disposable | undefined;
  const applyAutoLock = (mode: AutoLockMode): void => {
    focusLostDisposable?.dispose();
    focusLostDisposable = undefined;
    if (mode === "onFocusLost") {
      passphraseService.setIdleTimeout(undefined);
      focusLostDisposable = vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) {
          passphraseService.lock();
          log.info("Passphrase locked on window focus-loss.");
        }
      });
    } else {
      passphraseService.setIdleTimeout(autoLockModeToMs(mode));
    }
    log.info(`Passphrase auto-lock mode: ${mode}.`);
  };
  applyAutoLock(
    parseAutoLockMode(
      vscode.workspace
        .getConfiguration("vsCRT")
        .get<string>("passphraseAutoLock"),
    ),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vsCRT.passphraseAutoLock")) {
        applyAutoLock(
          parseAutoLockMode(
            vscode.workspace
              .getConfiguration("vsCRT")
              .get<string>("passphraseAutoLock"),
          ),
        );
      }
      if (e.affectsConfiguration("vsCRT.sharedConfigPaths")) {
        // Shared overlay is baked into the cached config; reset so the
        // next read re-merges with the new paths.
        configManager.invalidateCache();
        void connectionView.reload();
      }
    }),
  );
  context.subscriptions.push({
    dispose: () => focusLostDisposable?.dispose(),
  });

  // Sweep orphaned password files left behind by crashes.
  cleanupOrphanFiles().catch((err) =>
    log.warn("orphan sweep failed:", err),
  );

  // Vault status bar — shows lock state when a passphrase is configured,
  // hides when users have only OS-keychain secrets. Click opens a menu.
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "vsCRT.vaultStatusMenu";
  context.subscriptions.push(statusBar);

  const refreshVaultStatus = async (): Promise<void> => {
    const initialized = await passphraseService.isInitialized();
    if (!initialized) {
      statusBar.hide();
      return;
    }
    const unlocked = passphraseService.getCachedParams() !== undefined;
    statusBar.text = unlocked ? "$(unlock) vsCRT" : "$(lock) vsCRT";
    const humanState = unlocked ? "unlocked" : "locked";
    statusBar.tooltip = unlocked
      ? "vsCRT vault is unlocked — click for lock / show log / auto-lock settings"
      : "vsCRT vault is locked — click for lock / show log / auto-lock settings";
    // Screen readers ignore codicon $(lock)/$(unlock) glyphs — give them a
    // plain-text label so the state is announced instead of the decorative icon.
    statusBar.accessibilityInformation = {
      label: `vsCRT vault ${humanState}`,
      role: "button",
    };
    statusBar.show();
  };
  void refreshVaultStatus();
  context.subscriptions.push(
    passphraseService.onDidChangeLockState(() => {
      void refreshVaultStatus();
    }),
  );

  log.info("Extension activated.");

  return {
    __test: {
      configManager,
      passphraseService,
      connectionView,
    },
  };
}

/**
 * Extension deactivation. VS Code calls this on window reload / uninstall /
 * disable. Synchronous by contract — async work must complete here or get
 * abandoned. We use the sync sweep to remove any outstanding password
 * tempfiles so a crashed ssh process can't leak them.
 */
export function deactivate(): void {
  cleanupAllNowSync();
  setLogSink(undefined);
}
