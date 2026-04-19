/**
 * Password-related commands: change, switch storage mode, lock/reset the
 * passphrase, clear all stored secrets, rotate KDF parameters.
 */

import * as vscode from "vscode";
import { vscrtConfigFilePath } from "../fsPaths";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
  CRTConfigService,
} from "../config/vscrtConfig";
import {
  ArgonParams,
  DEFAULT_PARAMS,
  RotationKeys,
  argonParamsEqual,
  reencryptBlob,
} from "../config/vscrtPassphrase";
import type { CRTTarget } from "../treeView/treeTarget";
import { log } from "../log";
import { formatError, isUserCancellation } from "./commandUtils";
import { CommandDeps } from "./types";

export function registerPasswordCommands(
  deps: CommandDeps,
): vscode.Disposable[] {
  const {
    configManager,
    connectionView,
    secretService,
    passphraseService,
  } = deps;

  const changePasswordCommand = vscode.commands.registerCommand(
    "vsCRT.changePassword",
    async (treeItem?: CRTTarget) => {
      if (!treeItem || treeItem.item.type !== "node") {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "vsCRT: select a server node to change its password.",
          ),
        );
        return;
      }
      const nodeName = treeItem.item.config.name;
      const newPassword = await vscode.window.showInputBox({
        title: vscode.l10n.t('Change Password for "{0}"', nodeName),
        prompt: vscode.l10n.t(
          "Enter the new SSH password (stored in secure storage).",
        ),
        password: true,
        ignoreFocusOut: true,
      });
      if (!newPassword) {
        return;
      }
      let ok: boolean;
      try {
        ok = await configManager.updatePassword(nodeName, newPassword);
      } catch (err) {
        if (isUserCancellation(err)) {
          return;
        }
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: could not update password for "{0}" — {1}',
            nodeName,
            formatError(err),
          ),
        );
        return;
      }
      if (!ok) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: could not update password for "{0}".',
            nodeName,
          ),
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        vscode.l10n.t('vsCRT: updated password for "{0}".', nodeName),
      );
    },
  );

  const setPasswordStorageCommand = vscode.commands.registerCommand(
    "vsCRT.setPasswordStorage",
    async (treeItem?: CRTTarget) => {
      if (!treeItem || treeItem.item.type !== "node") {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "vsCRT: select a server node to change its password storage.",
          ),
        );
        return;
      }
      const node = treeItem.item.config;
      const current = node.passwordStorage ?? "secretstorage";
      const currentTag = vscode.l10n.t("(current)");
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: vscode.l10n.t("SecretStorage"),
            description:
              current === "secretstorage"
                ? currentTag
                : vscode.l10n.t("OS keychain reference"),
            value: "secretstorage" as const,
          },
          {
            label: vscode.l10n.t("Passphrase-encrypted"),
            description:
              current === "passphrase"
                ? currentTag
                : vscode.l10n.t("Argon2id + AES-GCM ciphertext in config"),
            value: "passphrase" as const,
          },
        ],
        {
          title: vscode.l10n.t('Password Storage for "{0}"', node.name),
          ignoreFocusOut: true,
        },
      );
      if (!pick || pick.value === current) {
        return;
      }
      try {
        const ok = await configManager.setPasswordStorage(node.name, pick.value);
        if (!ok) {
          vscode.window.showErrorMessage(
            vscode.l10n.t(
              'vsCRT: could not change storage for "{0}".',
              node.name,
            ),
          );
          return;
        }
      } catch (err) {
        if (isUserCancellation(err)) {
          return;
        }
        vscode.window.showErrorMessage(
          vscode.l10n.t("vsCRT: {0}", formatError(err)),
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'vsCRT: "{0}" now uses {1}.',
          node.name,
          pick.label,
        ),
      );
    },
  );

  const lockPassphraseCommand = vscode.commands.registerCommand(
    "vsCRT.lockPassphrase",
    () => {
      passphraseService.lock();
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          "vsCRT: passphrase locked. Next use will prompt again.",
        ),
      );
    },
  );

  const resetPassphraseCommand = vscode.commands.registerCommand(
    "vsCRT.resetPassphrase",
    async () => {
      const typed = await vscode.window.showInputBox({
        title: vscode.l10n.t("vsCRT: Reset Passphrase"),
        prompt: vscode.l10n.t(
          "Type RESET to discard the current passphrase setup. Existing enc:v3 ciphertexts will become unreadable.",
        ),
        ignoreFocusOut: true,
      });
      if (typed !== "RESET") {
        vscode.window.showInformationMessage(vscode.l10n.t("vsCRT: reset cancelled."));
        return;
      }
      await passphraseService.resetSetup();
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          "vsCRT: passphrase setup wiped. Re-enter a new one on next use.",
        ),
      );
    },
  );

  const clearAllSecretsCommand = vscode.commands.registerCommand(
    "vsCRT.clearAllSecrets",
    async () => {
      const typed = await vscode.window.showInputBox({
        title: vscode.l10n.t("vsCRT: Clear All Secrets"),
        prompt: vscode.l10n.t(
          "Type CLEAR to delete every stored SSH password.",
        ),
        ignoreFocusOut: true,
      });
      if (typed !== "CLEAR") {
        vscode.window.showInformationMessage(vscode.l10n.t("vsCRT: clear cancelled."));
        return;
      }
      await secretService.clearAll();
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          "vsCRT: cleared all stored SSH passwords. Nodes now require manual password entry.",
        ),
      );
    },
  );

  const rotateKdfParamsCommand = vscode.commands.registerCommand(
    "vsCRT.rotateKdfParams",
    async () => {
      await runRotateKdfParams(deps);
    },
  );

  const vaultStatusMenuCommand = vscode.commands.registerCommand(
    "vsCRT.vaultStatusMenu",
    async () => {
      const unlocked = passphraseService.getCachedParams() !== undefined;
      const initialized = await passphraseService.isInitialized();
      interface Item extends vscode.QuickPickItem {
        id: "lock" | "showLog" | "openSettings" | "resetPassphrase";
      }
      const items: Item[] = [];
      if (initialized && unlocked) {
        items.push({
          id: "lock",
          label: vscode.l10n.t("$(lock) Lock now"),
          description: vscode.l10n.t(
            "Forget the cached Argon2id key until next use.",
          ),
        });
      }
      items.push(
        {
          id: "showLog",
          label: vscode.l10n.t("$(output) Show Output Log"),
          description: vscode.l10n.t("Reveal the vsCRT output channel."),
        },
        {
          id: "openSettings",
          label: vscode.l10n.t("$(settings-gear) Change auto-lock mode…"),
          description: "vsCRT.passphraseAutoLock",
        },
      );
      if (initialized) {
        items.push({
          id: "resetPassphrase",
          label: vscode.l10n.t("$(trash) Reset passphrase setup…"),
          description: vscode.l10n.t(
            "Wipe the passphrase (existing ciphertexts become unreadable).",
          ),
        });
      }
      const pick = await vscode.window.showQuickPick(items, {
        title: unlocked
          ? vscode.l10n.t("vsCRT: Vault (unlocked)")
          : vscode.l10n.t("vsCRT: Vault (locked)"),
        placeHolder: vscode.l10n.t("Pick an action"),
      });
      if (!pick) {
        return;
      }
      switch (pick.id) {
        case "lock":
          await vscode.commands.executeCommand("vsCRT.lockPassphrase");
          return;
        case "showLog":
          await vscode.commands.executeCommand("vsCRT.showLog");
          return;
        case "openSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "vsCRT.passphraseAutoLock",
          );
          return;
        case "resetPassphrase":
          await vscode.commands.executeCommand("vsCRT.resetPassphrase");
          
      }
    },
  );

  return [
    changePasswordCommand,
    setPasswordStorageCommand,
    lockPassphraseCommand,
    resetPassphraseCommand,
    clearAllSecretsCommand,
    rotateKdfParamsCommand,
    vaultStatusMenuCommand,
  ];
}

/* -----------------------------------------------------------------------
 *   ROTATE KDF PARAMETERS
 * --------------------------------------------------------------------- */

async function runRotateKdfParams(deps: CommandDeps): Promise<void> {
  const { passphraseService, secretService, configManager, connectionView } =
    deps;

  if (!(await passphraseService.isInitialized())) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("vsCRT: passphrase not set up — nothing to rotate."),
    );
    return;
  }

  const current = await passphraseService.getStoredParams();
  const target = DEFAULT_PARAMS;
  if (current && argonParamsEqual(current, target)) {
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "vsCRT: already at the latest KDF parameters ({0}).",
        fmtParams(target),
      ),
    );
    return;
  }

  const confirmDetail = [
    current
      ? vscode.l10n.t("Current:  {0}", fmtParams(current))
      : vscode.l10n.t("Current:  (unknown)"),
    vscode.l10n.t("New:      {0}", fmtParams(target)),
    "",
    vscode.l10n.t(
      "vsCRT will re-encrypt every passphrase-encrypted password in your config under the new parameters. Your passphrase does not change.",
    ),
    "",
    vscode.l10n.t(
      "A backup of the current config file will be written alongside it before the rewrite.",
    ),
  ].join("\n");
  const rotateLabel = vscode.l10n.t("Rotate");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("vsCRT: Rotate passphrase KDF parameters?"),
    { modal: true, detail: confirmDetail },
    rotateLabel,
  );
  if (choice !== rotateLabel) {
    return;
  }

  let keys: RotationKeys;
  try {
    keys = await passphraseService.deriveKeysForRotation(target);
  } catch (err) {
    if (isUserCancellation(err)) {
      return;
    }
    vscode.window.showErrorMessage(
      vscode.l10n.t("vsCRT: rotation failed — {0}", formatError(err)),
    );
    return;
  }

  // Back up the config file before rewriting — atomic fs.writeFile already
  // protects against a half-written file, but the backup gives users a
  // hand-recoverable copy if something goes wrong further down the pipe.
  try {
    await backupConfigFile();
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "vsCRT: could not write config backup; aborting — {0}",
        formatError(err),
      ),
    );
    return;
  }

  const config = await configManager.loadConfig();
  if (!config) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "vsCRT: could not load vscrtConfig.json for rotation.",
      ),
    );
    return;
  }

  let rotated = 0;
  try {
    walkAllNodes(config, (node) => {
      if (!node.password) {
        return;
      }
      if (!secretService.isPassphraseCiphertext(node.password)) {
        return;
      }
      node.password = reencryptBlob(
        node.password,
        keys.oldKey,
        keys.newKey,
        keys.newParams,
      );
      rotated += 1;
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "vsCRT: rotation aborted — could not re-encrypt a password: {0}",
        formatError(err),
      ),
    );
    return;
  }

  try {
    await configManager.saveConfig(config);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "vsCRT: rotation aborted — could not save config: {0}. Original config restored from backup.",
        formatError(err),
      ),
    );
    await restoreConfigBackup(configManager).catch((restoreErr: unknown) => {
      log.error("Failed to restore config backup after rotation abort:", restoreErr);
    });
    return;
  }

  try {
    await passphraseService.commitRotation(keys.newKey, keys.newParams);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "vsCRT: config re-encrypted but check token update failed ({0}). Re-run this command to finish.",
        formatError(err),
      ),
    );
    return;
  }

  await connectionView.reload();
  vscode.window.showInformationMessage(
    vscode.l10n.t(
      "vsCRT: rotated {0} password(s) to {1}.",
      rotated,
      fmtParams(target),
    ),
  );
}

function fmtParams(p: ArgonParams): string {
  return `t=${p.t}, m=${p.m}, p=${p.p}`;
}

/** Depth-first walk across every node under every folder/subfolder. */
function walkAllNodes(
  config: CRTConfig,
  visit: (node: CRTConfigNode) => void,
): void {
  const walk = (clusters: CRTConfigCluster[] | undefined): void => {
    if (!clusters) {
      return;
    }
    for (const c of clusters) {
      if (c.nodes) {
        for (const n of c.nodes) {
          visit(n);
        }
      }
      walk(c.subfolder);
    }
  };
  walk(config.folder);
}

function configFileUri(): vscode.Uri {
  return vscode.Uri.file(vscrtConfigFilePath());
}

function backupFileUri(suffix: string): vscode.Uri {
  return vscode.Uri.file(vscrtConfigFilePath() + `.bak-${suffix}`);
}

/**
 * Copy ~/.vscrt/vscrtConfig.json to a timestamped .bak file. Stored path is
 * tracked globally so restoreConfigBackup can find it if rotation fails
 * after the main file is rewritten.
 */
let lastBackupSuffix: string | undefined;

async function backupConfigFile(): Promise<void> {
  lastBackupSuffix = new Date().toISOString().replace(/[:.]/g, "-");
  const src = configFileUri();
  const dst = backupFileUri(lastBackupSuffix);
  const data = await vscode.workspace.fs.readFile(src);
  await vscode.workspace.fs.writeFile(dst, data);
}

async function restoreConfigBackup(
  configManager: CRTConfigService,
): Promise<void> {
  if (!lastBackupSuffix) {
    return;
  }
  const src = backupFileUri(lastBackupSuffix);
  const dst = configFileUri();
  const data = await vscode.workspace.fs.readFile(src);
  await vscode.workspace.fs.writeFile(dst, data);
  // Drop the in-memory cache so the next load reads the restored file.
  configManager.invalidateCache();
}
