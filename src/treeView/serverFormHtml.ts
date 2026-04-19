/**
 * Thin loader for the add/edit-server webview panel. Reads
 * `media/serverForm.html` from disk, computes the runtime values
 * (CSP nonce, URIs, labels, per-field initial values, radio-button checked
 * states, etc.), and substitutes them into the template.
 *
 * The HTML/CSS/JS live in `media/` so editors can lint and syntax-highlight
 * them properly. Edit-mode state that the injected script needs is passed
 * through an inline bootstrap script (`window.__vscrtEditFlags = …`) so the
 * main script file can be loaded via a clean <script src="…"> tag.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CRTConfigNode } from "../config/vscrtConfig";
import {
  ALL_ICON_PRESETS,
  CUSTOM_ICON_FILES,
  ICON_PRESET_GROUPS,
  isCustomIcon,
} from "./iconPresets";
import { generateNonce } from "./webviewNonce";

export function renderServerFormHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  targetClusterName: string | null,
  existing: CRTConfigNode | undefined,
): string {
  const nonce = generateNonce();
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media");

  const codiconsCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "node_modules",
      "@vscode",
      "codicons",
      "dist",
      "codicon.css",
    ),
  );
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "serverForm.css"),
  );
  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "serverForm.js"),
  );

  const csp = [
    "default-src 'none'",
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join("; ");

  const customIconUris: Record<string, string> = {};
  for (const [id, file] of Object.entries(CUSTOM_ICON_FILES)) {
    customIconUris[id] = webview
      .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "icons", file))
      .toString();
  }

  // In Add-mode pre-select `server`; in Edit-mode respect whatever is stored
  // (including blank).
  const currentIcon = existing ? (existing.icon ?? "") : "server";

  const iconPresetOptions = ICON_PRESET_GROUPS.map((group) => {
    const header =
      `<li class="icon-select-group" role="presentation">` +
      `${escapeHtml(group.title)}</li>`;
    const rows = group.items
      .map((p) => {
        const selected = currentIcon === p.id;
        let iconMarkup = "";
        if (p.kind === "custom" && customIconUris[p.id]) {
          iconMarkup = `<img src="${escapeHtml(customIconUris[p.id])}" alt="" />`;
        } else if (p.kind === "codicon") {
          iconMarkup = `<i class="codicon codicon-${escapeHtml(p.id)}"></i>`;
        }
        // id is primary (what's written to config); human label is secondary.
        // Both strings are indexed in data-search for type-to-filter.
        const searchHaystack = `${p.id} ${p.label}`.toLowerCase();
        const secondary =
          p.label && p.label !== p.id
            ? `<span class="option-label">${escapeHtml(p.label)}</span>`
            : "";
        return (
          `<li role="option" data-value="${escapeHtml(p.id)}" tabindex="-1"` +
          ` data-search="${escapeHtml(searchHaystack)}"` +
          `${selected ? ' aria-selected="true"' : ""}>` +
          `<span class="icon-cell" aria-hidden="true">${iconMarkup}</span>` +
          `<span class="option-text">` +
          `<span class="option-id">${escapeHtml(p.id)}</span>` +
          secondary +
          `</span>` +
          `</li>`
        );
      })
      .join("");
    return header + rows;
  }).join("");

  const isEdit = !!existing;
  const title = isEdit ? "Edit Server" : "Add Server";
  const submitLabel = isEdit ? "Save Changes" : "Add Server";
  const targetOrLocation = isEdit ? "Location" : "Target";
  const targetLabel = targetClusterName
    ? escapeHtml(targetClusterName)
    : "(root)";

  const nameValue = existing ? escapeHtml(existing.name) : "";
  const endpointValue = existing ? escapeHtml(existing.endpoint) : "";
  const iconValue = escapeHtml(currentIcon);
  const identityFileValue = existing?.identityFile
    ? escapeHtml(existing.identityFile)
    : "";
  const jumpHostValue = existing?.jumpHost ? escapeHtml(existing.jumpHost) : "";
  const portForwardsValue = existing?.portForwards?.length
    ? escapeHtml(existing.portForwards.join("\n"))
    : "";
  const envValue = existing?.env
    ? escapeHtml(
        Object.entries(existing.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      )
    : "";

  const authIsPassword =
    !existing || existing.preferredAuthentication !== "publickey";
  const storageIsPassphrase = existing?.passwordStorage === "passphrase";
  const termLoc: "default" | "panel" | "editor" =
    existing?.terminalLocation === "panel"
      ? "panel"
      : existing?.terminalLocation === "editor"
        ? "editor"
        : "default";

  // Only booleans + enum strings — safe to inline in JSON without further
  // escaping. No plaintext passwords are ever sent to the client.
  const editFlags = {
    isEdit,
    hasExistingPassword:
      !!existing &&
      existing.preferredAuthentication === "password" &&
      !!existing.password,
    originalAuth: existing?.preferredAuthentication ?? "",
    iconIsCustom: isCustomIcon(currentIcon),
    iconIsPreset:
      !!currentIcon && ALL_ICON_PRESETS.some((p) => p.id === currentIcon),
    customIconUris,
  };

  const templatePath = path.join(
    extensionUri.fsPath,
    "media",
    "serverForm.html",
  );
  const template = fs.readFileSync(templatePath, "utf8");

  return substitute(template, {
    csp,
    nonce,
    codiconsCssUri: codiconsCssUri.toString(),
    cssUri: cssUri.toString(),
    jsUri: jsUri.toString(),
    title,
    submitLabel,
    targetOrLocation,
    targetLabel,
    nameValue,
    endpointValue,
    iconValue,
    iconPresetOptions,
    identityFileValue,
    jumpHostValue,
    portForwardsValue,
    envValue,
    termLocDefaultChecked: termLoc === "default" ? "checked" : "",
    termLocPanelChecked: termLoc === "panel" ? "checked" : "",
    termLocEditorChecked: termLoc === "editor" ? "checked" : "",
    authPasswordChecked: authIsPassword ? "checked" : "",
    authPublickeyChecked: authIsPassword ? "" : "checked",
    sectPasswordHidden: authIsPassword ? "" : "hidden",
    sectPublickeyHidden: authIsPassword ? "hidden" : "",
    storageSecretChecked: storageIsPassphrase ? "" : "checked",
    storagePassphraseChecked: storageIsPassphrase ? "checked" : "",
    passwordPlaceholder: isEdit ? "Leave blank to keep existing" : "",
    installFieldHidden: isEdit ? "hidden" : "",
    editFlagsJson: JSON.stringify(editFlags),
  });
}

function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(
        `renderServerFormHtml: missing substitution for \${${key}}`,
      );
    }
    return values[key];
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
