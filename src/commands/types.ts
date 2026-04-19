/**
 * Dependency bundle passed to each command registrar. Centralizes the set of
 * services the extension's command handlers share so individual files don't
 * have to thread them through one by one.
 */

import * as vscode from "vscode";
import { CRTConfigService } from "../config/vscrtConfig";
import { CRTPassphraseService } from "../config/vscrtPassphrase";
import { CRTSecretService } from "../config/vscrtSecret";
import { CRTSshService } from "../remote";
import { StatusProvider } from "../status/statusProvider";
import { CRTWebviewProvider } from "../treeView/webviewTree";

export interface CommandDeps {
  context: vscode.ExtensionContext;
  passphraseService: CRTPassphraseService;
  secretService: CRTSecretService;
  configManager: CRTConfigService;
  sshService: CRTSshService;
  connectionView: CRTWebviewProvider;
  statusProvider: StatusProvider;
}
