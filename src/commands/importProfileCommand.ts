/**
 * vsCRT.importProfile — read a `vscrt-bundle/v1` file produced by
 * `vsCRT.exportProfile` and merge its folders into the current config.
 *
 * Flow:
 *   1. Open dialog → pick the .json file.
 *   2. Parse + validate bundle shape.
 *   3. If bundle contains passwords: prompt for the export passphrase,
 *      derive the bundle key, verify the check token. Decrypt each node's
 *      password then re-seal under the target machine's SecretService.
 *   4. QuickPick top-level folders so the user can import a subset.
 *   5. Append picked folders to the current config (deduping folder names).
 *
 * Password-stripped bundles skip the passphrase prompt entirely — their
 * `password` fields are already absent, so nodes land without credentials
 * and the user can populate them via "Change Password" afterwards.
 */

import * as fs from "fs";
import * as vscode from "vscode";
import {
  CRTConfig,
  CRTConfigCluster,
  uniqueName,
} from "../config/vscrtConfig";
import {
  ExportBundle,
  deriveExistingBundleKey,
  mapNodePasswords,
  validateBundleShape,
  verifyBundleCheckToken,
} from "../config/vscrtExportBundle";
import { PassphraseCancelled, unsealWithKey } from "../config/vscrtPassphrase";
import { log } from "../log";
import { formatError } from "./commandUtils";
import { CommandDeps } from "./types";

export function registerImportProfileCommand(
  deps: CommandDeps,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.importProfile", async () => {
      try {
        await runImport(deps);
      } catch (err) {
        if (err instanceof PassphraseCancelled) {
          return;
        }
        log.error("importProfile failed:", err);
        vscode.window.showErrorMessage(
          `vsCRT: import failed — ${formatError(err)}`,
        );
      }
    }),
  ];
}

async function runImport(deps: CommandDeps): Promise<void> {
  const { configManager, secretService, connectionView } = deps;

  const picked = await vscode.window.showOpenDialog({
    title: "vsCRT: Import Profile Bundle",
    filters: { "vsCRT bundle": ["json"], "All files": ["*"] },
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    openLabel: "Import",
  });
  if (!picked || picked.length === 0) {
    return;
  }

  const raw = await fs.promises.readFile(picked[0].fsPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    vscode.window.showErrorMessage(
      `vsCRT: bundle is not valid JSON — ${formatError(err)}`,
    );
    return;
  }

  const shape = validateBundleShape(parsed);
  if ("error" in shape) {
    vscode.window.showErrorMessage(`vsCRT: ${shape.error}`);
    return;
  }
  const bundle: ExportBundle = shape.bundle;

  // If the bundle carries encrypted passwords, resolve them now. For
  // strip-mode bundles we just accept the password-less structure directly.
  let importableConfig: CRTConfig = bundle.config;
  if (bundle.passwordsIncluded) {
    importableConfig = await rekeyPasswordsForTarget(bundle, secretService);
  }

  const topFolders = importableConfig.folder ?? [];
  if (topFolders.length === 0) {
    vscode.window.showInformationMessage(
      "vsCRT: bundle contains no folders to import.",
    );
    return;
  }

  interface FolderPick extends vscode.QuickPickItem {
    folder: CRTConfigCluster;
  }
  const folderPicks: FolderPick[] = topFolders.map((f) => ({
    label: f.name,
    description: describeFolder(f),
    folder: f,
    picked: true,
  }));
  const chosen = await vscode.window.showQuickPick(folderPicks, {
    canPickMany: true,
    title: `Import from ${picked[0].fsPath}`,
    placeHolder: "Select folders to merge into your config",
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!chosen || chosen.length === 0) {
    return;
  }

  const current = (await configManager.loadConfig()) ?? {};
  if (!current.folder) {
    current.folder = [];
  }
  const existingNames = new Set(current.folder.map((f) => f.name));
  let nodeCount = 0;
  for (const pick of chosen) {
    const renamed = ensureUniqueFolderName(pick.folder, existingNames);
    current.folder.push(renamed);
    existingNames.add(renamed.name);
    nodeCount += countNodes(renamed);
  }
  await configManager.saveConfig(current);

  await connectionView.reload();

  const folderNoun = chosen.length === 1 ? "folder" : "folders";
  const serverNoun = nodeCount === 1 ? "server" : "servers";
  const stripNote = bundle.passwordsIncluded
    ? ""
    : " (passwords were stripped — set them via Change Password).";
  vscode.window.showInformationMessage(
    `vsCRT: imported ${chosen.length} ${folderNoun} / ${nodeCount} ${serverNoun}${stripNote}.`,
  );
}

async function rekeyPasswordsForTarget(
  bundle: ExportBundle,
  secretService: import("../config/vscrtSecret").CRTSecretService,
): Promise<CRTConfig> {
  const passphrase = await vscode.window.showInputBox({
    title: "vsCRT: Import Passphrase",
    prompt:
      "Enter the passphrase you set when exporting this bundle. It is NOT your vsCRT session passphrase.",
    password: true,
    ignoreFocusOut: true,
  });
  if (passphrase === undefined) {
    throw new PassphraseCancelled();
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "vsCRT: Importing profile…",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Deriving bundle key (Argon2id)…" });
      const key = await deriveExistingBundleKey(passphrase, bundle);
      if (!verifyBundleCheckToken(key, bundle.checkToken)) {
        throw new Error("incorrect passphrase for this bundle.");
      }

      progress.report({ message: "Re-sealing passwords for this machine…" });
      const { config } = await mapNodePasswords(bundle.config, async (pw) => {
        try {
          const plaintext = unsealWithKey(key, pw);
          // Seal under the target machine's default mode (secretstorage —
          // the OS keychain). Users can switch any node to passphrase mode
          // afterwards via "Change Password Storage".
          return await secretService.seal(plaintext, "secretstorage");
        } catch (err) {
          log.warn(
            "importProfile: could not decrypt a password; leaving bundle blob in place.",
            err,
          );
          // Return the bundle's blob unchanged so the user notices the
          // broken node and can re-enter the password manually.
          return pw;
        }
      });
      return config;
    },
  );
}

function ensureUniqueFolderName(
  folder: CRTConfigCluster,
  taken: ReadonlySet<string>,
): CRTConfigCluster {
  if (!taken.has(folder.name)) {
    return folder;
  }
  return { ...folder, name: uniqueName(folder.name, [...taken]) };
}

function describeFolder(f: CRTConfigCluster): string {
  const nodes = countNodes(f);
  const subfolders = countSubfolders(f);
  const bits: string[] = [`${nodes} ${nodes === 1 ? "server" : "servers"}`];
  if (subfolders > 0) {
    bits.push(`${subfolders} ${subfolders === 1 ? "subfolder" : "subfolders"}`);
  }
  return bits.join(" · ");
}

function countNodes(folder: CRTConfigCluster): number {
  let n = folder.nodes?.length ?? 0;
  for (const s of folder.subfolder ?? []) {
    n += countNodes(s);
  }
  return n;
}

function countSubfolders(folder: CRTConfigCluster): number {
  const direct = folder.subfolder?.length ?? 0;
  let nested = 0;
  for (const s of folder.subfolder ?? []) {
    nested += countSubfolders(s);
  }
  return direct + nested;
}
