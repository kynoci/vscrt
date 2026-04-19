/**
 * vsCRT.exportProfile — serialise the current config as a portable,
 * passphrase-encrypted bundle. Designed for moving a curated server list
 * between machines, or committing an auditable (password-stripped) copy to
 * a team git repo.
 *
 * Flow:
 *   1. Prompt for an export passphrase + confirmation (or offer strip mode).
 *   2. If re-keying: unseal every node's stored password via the in-session
 *      SecretService, then seal each one under a fresh Argon2id key derived
 *      from the export passphrase.
 *   3. Ask where to save; write a single JSON file.
 *
 * Strip mode skips steps 1's passphrase prompts entirely and omits the
 * password field from every node in the bundle.
 */

import * as fs from "fs";
import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { log } from "../log";
import { PassphraseCancelled, sealWithKey } from "../config/vscrtPassphrase";
import {
  BUNDLE_FORMAT,
  assembleBundle,
  deriveNewBundleKey,
  mapNodePasswords,
  stripMachineSpecificFields,
} from "../config/vscrtExportBundle";
import { CommandDeps } from "./types";

const MIN_BUNDLE_PASSPHRASE = 12;

export function registerExportProfileCommand(
  deps: CommandDeps,
): vscode.Disposable[] {
  const { configManager, secretService } = deps;

  return [
    vscode.commands.registerCommand("vsCRT.exportProfile", async () => {
      const cfg = await configManager.loadConfig();
      if (!cfg || !cfg.folder || cfg.folder.length === 0) {
        vscode.window.showInformationMessage(
          "vsCRT: nothing to export — add at least one folder/server first.",
        );
        return;
      }

      const mode = await vscode.window.showQuickPick(
        [
          {
            label: "Re-key passwords for another machine",
            description: "Interactive passphrase required at import time",
            detail:
              "Every stored password is decrypted then re-encrypted under a fresh Argon2id key derived from a passphrase you set now.",
            value: "rekey" as const,
          },
          {
            label: "Strip passwords (auditable)",
            description: "No secrets in the file — safe to commit to a shared repo",
            detail:
              "Produces a bundle with structure only: folders, endpoints, auth methods, port forwards — no encrypted or plaintext passwords.",
            value: "strip" as const,
          },
        ],
        {
          title: "vsCRT: Export Profile — mode",
          placeHolder: "How should passwords be handled in the exported file?",
        },
      );
      if (!mode) {
        return;
      }

      const saveUri = await vscode.window.showSaveDialog({
        title: "vsCRT: Export Profile",
        filters: { "vsCRT bundle": ["json"] },
        saveLabel: "Export",
        defaultUri: vscode.Uri.file(
          `vscrt-profile-${new Date().toISOString().slice(0, 10)}.json`,
        ),
      });
      if (!saveUri) {
        return;
      }

      try {
        const bundle =
          mode.value === "strip"
            ? await buildStrippedBundle(cfg)
            : await buildRekeyedBundle(cfg, secretService);
        if (!bundle) {
          return; // user cancelled a nested prompt
        }
        const json = JSON.stringify(bundle, null, 2);
        await fs.promises.writeFile(saveUri.fsPath, json, {
          encoding: "utf-8",
          mode: 0o600,
        });
        const summary =
          mode.value === "strip"
            ? "Exported (passwords stripped)."
            : "Exported with re-keyed passwords. Keep your export passphrase safe — it is NOT recoverable.";
        vscode.window.showInformationMessage(`vsCRT: ${summary}`);
      } catch (err) {
        if (err instanceof PassphraseCancelled) {
          return;
        }
        log.error("exportProfile failed:", err);
        vscode.window.showErrorMessage(
          `vsCRT: export failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  ];
}

async function buildStrippedBundle(
  cfg: import("../config/vscrtConfig").CRTConfig,
) {
  // Strip mode still derives a key + checkToken so the bundle is
  // self-consistent — the receiver can import without any passphrase
  // because `passwordsIncluded=false` lets the flow skip verification.
  // Using a throwaway random passphrase here keeps the shape uniform.
  const throwaway = randomBytes(32).toString("base64");
  const { key, salt, params } = await deriveNewBundleKey(throwaway);
  const { config: stripped } = await mapNodePasswords(cfg, async () => undefined);
  const sanitized = stripMachineSpecificFields(stripped);
  return assembleBundle(key, salt, params, false, sanitized);
}

async function buildRekeyedBundle(
  cfg: import("../config/vscrtConfig").CRTConfig,
  secretService: import("../config/vscrtSecret").CRTSecretService,
) {
  const passphrase = await promptNewBundlePassphrase();
  if (!passphrase) {
    return null;
  }

  // Derive a fresh Argon2id key under DEFAULT_PARAMS. This is SLOW (~0.5 s
  // on a laptop) so we surface progress feedback.
  const bundle = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "vsCRT: Exporting profile…",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Deriving bundle key (Argon2id)…" });
      const { key, salt, params } = await deriveNewBundleKey(passphrase);

      progress.report({ message: "Re-keying stored passwords…" });
      const { config: rekeyed, count } = await mapNodePasswords(
        cfg,
        async (pw) => {
          const plaintext = await secretService.unseal(pw);
          if (!plaintext) {
            // No resolvable plaintext (e.g. empty reference) — skip: leave
            // as-is so the receiver still sees *something* they can edit.
            return pw;
          }
          return sealWithKey(key, params, plaintext);
        },
      );
      log.info(`exportProfile: re-keyed ${count} password(s).`);
      const sanitized = stripMachineSpecificFields(rekeyed);
      return assembleBundle(key, salt, params, true, sanitized);
    },
  );
  return bundle;
}

async function promptNewBundlePassphrase(): Promise<string | null> {
  const first = await vscode.window.showInputBox({
    title: "vsCRT: Export Passphrase",
    prompt:
      "Choose a passphrase for this bundle. You'll need it to import on another machine. Minimum 12 characters.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length < MIN_BUNDLE_PASSPHRASE
        ? `Minimum ${MIN_BUNDLE_PASSPHRASE} characters.`
        : null,
  });
  if (first === undefined) {
    return null;
  }
  const second = await vscode.window.showInputBox({
    title: "vsCRT: Confirm Export Passphrase",
    prompt: "Re-enter to confirm.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === first ? null : "Passphrases do not match."),
  });
  if (second === undefined) {
    return null;
  }
  return first;
}

// Re-export for test discoverability; not used outside the module.
export { BUNDLE_FORMAT };
