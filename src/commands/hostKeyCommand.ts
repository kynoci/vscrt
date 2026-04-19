/**
 * vsCRT.removeHostKey — wraps `ssh-keygen -R` so users can clear a stale
 * known_hosts entry from inside the extension when a host is rebuilt and
 * presents a new key. Without this, the recovery step is a shell trip to
 * `ssh-keygen -R [host]:port` that most users don't remember.
 */

import * as vscode from "vscode";
import {
  extractHost,
  removeHostFromKnownHosts,
  resolveEndpoint,
} from "../remote";
import type { CRTTarget } from "../treeView/treeTarget";

export function registerRemoveHostKeyCommand(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.removeHostKey", async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage(
          vscode.l10n.t("vsCRT: select a server to remove its host key."),
        );
        return;
      }
      const { target: rawTarget, port } = resolveEndpoint(target.item.config);
      const host = extractHost(rawTarget);
      const label = port === 22 ? host : `${host}:${port}`;

      const confirm = vscode.l10n.t("Remove");
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Remove host key for "{0}" from ~/.ssh/known_hosts?',
          label,
        ),
        {
          modal: true,
          detail: vscode.l10n.t(
            "On the next connection, vsCRT will re-verify the host's fingerprint via the usual prompt-on-first flow. A .old backup of known_hosts is written automatically.",
          ),
        },
        confirm,
      );
      if (pick !== confirm) {
        return;
      }

      const result = await removeHostFromKnownHosts(host, port);
      if (result.removed) {
        vscode.window.showInformationMessage(
          vscode.l10n.t("vsCRT: {0}", result.message),
        );
      } else {
        vscode.window.showWarningMessage(
          vscode.l10n.t("vsCRT: {0}", result.message),
        );
      }
    }),
  ];
}
