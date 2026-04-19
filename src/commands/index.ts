/**
 * Aggregates every registerCommand call in the extension. `activate()` calls
 * `registerAllCommands(deps)` once and pushes the returned disposables into
 * `context.subscriptions`.
 */

import * as vscode from "vscode";
import { log } from "../log";
import { registerBulkCommands } from "./bulkCommands";
import { registerConfigRecoveryCommands } from "./configRecoveryCommands";
import { registerConnectCommands } from "./connectCommands";
import { registerConnectionHistoryCommand } from "./connectionHistoryCommand";
import { registerDiagnosticsCommand } from "./diagnosticsCommand";
import { registerHelpPanelCommand } from "./helpPanelCommand";
import { registerExportProfileCommand } from "./exportProfileCommand";
import { registerGenerateKeypairCommand } from "./generateKeypairCommand";
import { registerImportProfileCommand } from "./importProfileCommand";
import { registerLaunchProfileCommands } from "./launchProfileCommands";
import { registerHelpCommands } from "./helpCommands";
import { registerRemoveHostKeyCommand } from "./hostKeyCommand";
import { registerIconCommand } from "./iconCommand";
import { registerImportSshConfigCommand } from "./importSshConfigCommand";
import { registerLoadExampleCommand } from "./loadExampleCommand";
import { registerPasswordCommands } from "./passwordCommands";
import { registerQuickConnectCommand } from "./quickConnectCommand";
import { registerRunCommandCommand } from "./runCommandCommand";
import { registerServerCommands } from "./serverCommands";
import { registerSessionHistoryPanel } from "./sessionHistoryPanel";
import { registerSessionRecordingCommand } from "./sessionRecordingCommands";
import { registerSftpBrowserCommand } from "./sftpBrowser";
import { registerSftpPickCommands } from "./sftpPickCommand";
import { CommandDeps } from "./types";

export { CommandDeps } from "./types";

export function registerAllCommands(deps: CommandDeps): vscode.Disposable[] {
  const refreshStatus = vscode.commands.registerCommand(
    "vsCRT.refreshStatus",
    () => deps.statusProvider.refresh(),
  );

  const showLog = vscode.commands.registerCommand("vsCRT.showLog", () => {
    log.show();
  });

  return [
    ...registerServerCommands(deps),
    ...registerConnectCommands(deps),
    ...registerPasswordCommands(deps),
    ...registerIconCommand(deps),
    ...registerHelpCommands(),
    ...registerImportSshConfigCommand(deps),
    ...registerLoadExampleCommand(deps),
    ...registerGenerateKeypairCommand(),
    ...registerQuickConnectCommand(deps),
    ...registerRemoveHostKeyCommand(),
    ...registerConfigRecoveryCommands(deps),
    ...registerExportProfileCommand(deps),
    ...registerImportProfileCommand(deps),
    ...registerRunCommandCommand(deps),
    ...registerDiagnosticsCommand(deps),
    ...registerConnectionHistoryCommand(),
    ...registerHelpPanelCommand(deps),
    ...registerBulkCommands(deps),
    ...registerSessionRecordingCommand(),
    ...registerSessionHistoryPanel(),
    ...registerLaunchProfileCommands(deps),
    ...registerSftpBrowserCommand(deps),
    ...registerSftpPickCommands(deps),
    refreshStatus,
    showLog,
  ];
}
