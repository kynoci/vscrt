/**
 * Commands that mutate the server tree: add/edit/delete/duplicate servers and
 * add/rename/delete folders. Each command validates its target, invokes the
 * CRTConfigService, then refreshes the webview on success.
 */

import * as vscode from "vscode";
import { CRTConfigNode } from "../config/vscrtConfig";
import { CRTSecretService } from "../config/vscrtSecret";
import { installPublicKey } from "../remote";
import { openServerForm, ServerFormData } from "../treeView/serverForm";
import type { CRTTarget } from "../treeView/treeTarget";
import { formatError, isUserCancellation } from "./commandUtils";
import { CommandDeps } from "./types";

export function registerServerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, configManager, secretService, connectionView } = deps;

  const openConfigCommand = vscode.commands.registerCommand(
    "vsCRT.openConfig",
    () => configManager.openConfigFile(),
  );

  const addServerCommand = vscode.commands.registerCommand(
    "vsCRT.addServer",
    async (target?: CRTTarget) => {
      let targetClusterName: string | null = null;
      if (
        target &&
        (target.item.type === "cluster" || target.item.type === "subcluster")
      ) {
        targetClusterName = target.item.label;
      }

      // No folder context (top-bar button / Command Palette) — ask which folder.
      if (!targetClusterName) {
        const folderPaths = await configManager.getAllFolderPaths();
        if (folderPaths.length === 0) {
          vscode.window.showErrorMessage(
            vscode.l10n.t(
              "vsCRT: create a folder first — servers must live inside a folder.",
            ),
          );
          return;
        }
        const pick = await vscode.window.showQuickPick(folderPaths, {
          title: vscode.l10n.t("Add Server — pick a folder"),
          placeHolder: vscode.l10n.t(
            "Which folder should the new server live in?",
          ),
          ignoreFocusOut: true,
        });
        if (!pick) {
          return;
        }
        targetClusterName = pick.split("/").pop() ?? pick;
      }

      const form = await openServerForm(context.extensionUri, {
        targetClusterName,
      });
      if (!form) {
        return;
      }

      let ok: boolean;
      try {
        ok = await configManager.appendNode(targetClusterName, {
          name: form.name,
          endpoint: form.endpoint,
          icon: form.icon,
          terminalLocation: form.terminalLocation,
          jumpHost: form.jumpHost,
          portForwards: form.portForwards,
          env: form.env,
          preferredAuthentication: form.preferredAuthentication,
          identityFile: form.identityFile,
          password: form.password,
          passwordStorage:
            form.passwordStorage === "passphrase" ? "passphrase" : undefined,
        });
      } catch (err) {
        if (isUserCancellation(err)) {
          return;
        }
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "vsCRT: could not add server — {0}",
            formatError(err),
          ),
        );
        return;
      }

      if (!ok) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: Could not find folder "{0}" in vscrtConfig.json',
            targetClusterName,
          ),
        );
        return;
      }

      await connectionView.reload();

      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'vsCRT: Added server "{0}" under {1}.',
          form.name,
          targetClusterName,
        ),
      );

      // "Install public key now" deploys the pubkey via ssh-copy-id,
      // authed with a one-time password that is never persisted.
      if (
        form.installPublicKeyNow &&
        form.oneTimePassword &&
        form.identityFile
      ) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t(
              'vsCRT: Installing public key on "{0}"…',
              form.name,
            ),
            cancellable: false,
          },
          async () => {
            const tempNode: CRTConfigNode = {
              name: form.name,
              endpoint: form.endpoint,
              identityFile: form.identityFile,
            };
            const result = await installPublicKey(
              tempNode,
              form.oneTimePassword ?? "",
            );
            if (result.success) {
              vscode.window.showInformationMessage(
                vscode.l10n.t("vsCRT: {0}", result.message),
              );
            } else {
              vscode.window.showErrorMessage(
                vscode.l10n.t(
                  "vsCRT: key install failed — {0}",
                  result.message,
                ),
              );
            }
          },
        );
      }
    },
  );

  const editServerCommand = vscode.commands.registerCommand(
    "vsCRT.editServer",
    async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage(vscode.l10n.t("vsCRT: select a server node to edit."));
        return;
      }
      const existing = target.item.config;
      const oldPath = target.item.path;
      const parentSegments = oldPath.split("/");
      const parentClusterName =
        parentSegments.length > 1
          ? parentSegments[parentSegments.length - 2]
          : null;

      const form = await openServerForm(context.extensionUri, {
        targetClusterName: parentClusterName,
        existing,
      });
      if (!form) {
        return;
      }

      try {
        const newNode = await buildUpdatedNode(form, existing, secretService);
        const ok = await configManager.updateNode(oldPath, newNode);
        if (!ok) {
          vscode.window.showErrorMessage(
            vscode.l10n.t(
              'vsCRT: could not find "{0}" in vscrtConfig.json.',
              existing.name,
            ),
          );
          return;
        }
        await connectionView.reload();
        vscode.window.showInformationMessage(
          vscode.l10n.t('vsCRT: updated server "{0}".', form.name),
        );
      } catch (err) {
        if (isUserCancellation(err)) {
          return;
        }
        vscode.window.showErrorMessage(
          vscode.l10n.t("vsCRT: edit failed — {0}", formatError(err)),
        );
      }
    },
  );

  const renameClusterCommand = vscode.commands.registerCommand(
    "vsCRT.renameCluster",
    async (target?: CRTTarget) => {
      if (
        !target ||
        (target.item.type !== "cluster" && target.item.type !== "subcluster")
      ) {
        vscode.window.showErrorMessage(vscode.l10n.t("vsCRT: select a folder to rename."));
        return;
      }
      const oldName = target.item.label;
      const kindLabel =
        target.item.type === "subcluster"
          ? vscode.l10n.t("Subfolder")
          : vscode.l10n.t("Folder");

      const input = await vscode.window.showInputBox({
        title: vscode.l10n.t("Rename {0}", kindLabel),
        prompt: vscode.l10n.t('Enter a new name for "{0}"', oldName),
        value: oldName,
        valueSelection: [0, oldName.length],
        ignoreFocusOut: true,
        validateInput: (v) => {
          const s = v.trim();
          if (!s) {
            return vscode.l10n.t("Name cannot be empty.");
          }
          if (s.includes("/")) {
            return vscode.l10n.t("Name cannot contain '/'.");
          }
          return null;
        },
      });
      if (!input) {
        return;
      }
      const newName = input.trim();
      if (newName === oldName) {
        return;
      }

      const ok = await configManager.renameCluster(target.item.path, newName);
      if (!ok) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: could not rename "{0}" — a sibling with that name may already exist.',
            oldName,
          ),
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        vscode.l10n.t('vsCRT: renamed "{0}" to "{1}".', oldName, newName),
      );
    },
  );

  const deleteNodeCommand = vscode.commands.registerCommand(
    "vsCRT.deleteNode",
    async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage(vscode.l10n.t("vsCRT: select a server to delete."));
        return;
      }
      const name = target.item.label;
      const confirmLabel = vscode.l10n.t("Delete");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete server "{0}"?', name),
        {
          modal: true,
          detail: vscode.l10n.t(
            "This removes the entry and forgets its stored password.",
          ),
        },
        confirmLabel,
      );
      if (choice !== confirmLabel) {
        return;
      }
      const ok = await configManager.deleteNode(target.item.path);
      if (!ok) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: could not delete "{0}" — not found in config.',
            name,
          ),
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        vscode.l10n.t('vsCRT: deleted server "{0}".', name),
      );
    },
  );

  const deleteClusterCommand = vscode.commands.registerCommand(
    "vsCRT.deleteCluster",
    async (target?: CRTTarget) => {
      if (
        !target ||
        (target.item.type !== "cluster" && target.item.type !== "subcluster")
      ) {
        vscode.window.showErrorMessage(vscode.l10n.t("vsCRT: select a folder to delete."));
        return;
      }
      const name = target.item.label;
      const kindLabel =
        target.item.type === "subcluster"
          ? vscode.l10n.t("subfolder")
          : vscode.l10n.t("folder");

      const counts = await configManager.countClusterContents(target.item.path);
      const detail =
        counts && (counts.nodes > 0 || counts.subfolder > 0)
          ? vscode.l10n.t(
              "This will also remove {0} {1} and {2} {3}, and forget any stored passwords.",
              counts.subfolder,
              counts.subfolder === 1
                ? vscode.l10n.t("subfolder")
                : vscode.l10n.t("subfolders"),
              counts.nodes,
              counts.nodes === 1
                ? vscode.l10n.t("server")
                : vscode.l10n.t("servers"),
            )
          : vscode.l10n.t("This folder is empty.");

      const confirmLabel = vscode.l10n.t("Delete");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete {0} "{1}"?', kindLabel, name),
        { modal: true, detail },
        confirmLabel,
      );
      if (choice !== confirmLabel) {
        return;
      }
      const ok = await configManager.deleteCluster(target.item.path);
      if (!ok) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: could not delete "{0}" — not found in config.',
            name,
          ),
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        vscode.l10n.t('vsCRT: deleted {0} "{1}".', kindLabel, name),
      );
    },
  );

  const addClusterCommand = vscode.commands.registerCommand(
    "vsCRT.addCluster",
    async (treeItem?: CRTTarget) => {
      const name = await vscode.window.showInputBox({
        title: vscode.l10n.t("Add Folder"),
        prompt: vscode.l10n.t("Enter folder / subfolder name:"),
        placeHolder: vscode.l10n.t("e.g. Production-2 or DB-ReadOnly"),
        ignoreFocusOut: true,
      });
      if (!name) {
        return;
      }

      let parentName: string | null = null;

      // If user clicked on a cluster/subcluster, add under that
      if (treeItem) {
        if (
          treeItem.item.type === "cluster" ||
          treeItem.item.type === "subcluster"
        ) {
          parentName = treeItem.item.label;
        }
      }

      const ok = await configManager.appendCluster(parentName, name);
      if (!ok) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: Could not find parent folder "{0}" in vscrtConfig.json',
            parentName ?? "",
          ),
        );
        return;
      }

      await connectionView.reload();

      vscode.window.showInformationMessage(
        parentName
          ? vscode.l10n.t('vsCRT: Added subfolder "{0}".', name)
          : vscode.l10n.t('vsCRT: Added folder "{0}".', name),
      );
    },
  );

  const duplicateNodeCommand = vscode.commands.registerCommand(
    "vsCRT.duplicateNode",
    async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage(vscode.l10n.t("vsCRT: select a server to duplicate."));
        return;
      }
      const originalName = target.item.label;
      const newName = await configManager.duplicateNode(target.item.path);
      if (!newName) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: could not duplicate "{0}".',
            originalName,
          ),
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'vsCRT: duplicated "{0}" as "{1}".',
          originalName,
          newName,
        ),
      );
    },
  );

  const refreshCommand = vscode.commands.registerCommand("vsCRT.refresh", () =>
    connectionView.reload(),
  );

  return [
    openConfigCommand,
    addServerCommand,
    editServerCommand,
    renameClusterCommand,
    deleteNodeCommand,
    deleteClusterCommand,
    addClusterCommand,
    duplicateNodeCommand,
    refreshCommand,
  ];
}

/**
 * Merge a form submission with the existing node config. Handles the
 * password / storage-mode transitions so secrets get re-sealed under the
 * right scheme (OS keychain vs. passphrase) and stale references get cleaned
 * up from SecretStorage.
 */
async function buildUpdatedNode(
  form: ServerFormData,
  existing: CRTConfigNode,
  secretService?: CRTSecretService,
): Promise<CRTConfigNode> {
  const newNode: CRTConfigNode = { ...existing };

  newNode.name = form.name;
  newNode.endpoint = form.endpoint;
  if (form.icon) {
    newNode.icon = form.icon;
  } else {
    delete newNode.icon;
  }
  if (form.terminalLocation === "panel" || form.terminalLocation === "editor") {
    newNode.terminalLocation = form.terminalLocation;
  } else {
    delete newNode.terminalLocation;
  }
  if (form.jumpHost) {
    newNode.jumpHost = form.jumpHost;
  } else {
    delete newNode.jumpHost;
  }
  if (form.portForwards && form.portForwards.length > 0) {
    newNode.portForwards = form.portForwards;
  } else {
    delete newNode.portForwards;
  }
  if (form.env && Object.keys(form.env).length > 0) {
    newNode.env = form.env;
  } else {
    delete newNode.env;
  }
  newNode.preferredAuthentication = form.preferredAuthentication;

  if (form.preferredAuthentication === "password") {
    delete newNode.identityFile;
    const newStorage =
      form.passwordStorage === "passphrase" ? "passphrase" : "secretstorage";

    if (form.password && secretService) {
      // User typed a new plaintext — drop old reference, seal the new one.
      if (existing.password) {
        await secretService.forget(existing.password);
      }
      newNode.password = await secretService.seal(form.password, newStorage);
    } else if (
      existing.password &&
      secretService &&
      (existing.passwordStorage ?? "secretstorage") !== newStorage
    ) {
      // Storage mode changed but password unchanged — re-seal under new mode.
      const plaintext = await secretService.unseal(existing.password);
      if (plaintext !== undefined) {
        await secretService.forget(existing.password);
        newNode.password = await secretService.seal(plaintext, newStorage);
      }
    }
    // else: keep the existing stored reference as-is.

    if (newStorage === "passphrase") {
      newNode.passwordStorage = "passphrase";
    } else {
      delete newNode.passwordStorage;
    }
  } else {
    // Switched to public key — drop password fields and clear any stored secret.
    if (existing.password && secretService) {
      await secretService.forget(existing.password);
    }
    delete newNode.password;
    delete newNode.passwordStorage;
    newNode.identityFile = form.identityFile;
  }

  return newNode;
}
