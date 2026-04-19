/**
 * Thin loader for the connection webview. Reads `media/connectionView.html`
 * from disk and substitutes the handful of runtime values (CSP nonce,
 * codicon/stylesheet/script webview URIs). The HTML, CSS, and JS are
 * maintained as separate files in `media/` so editors can lint and
 * syntax-highlight them properly.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CUSTOM_ICON_FILES } from "./iconPresets";
import { generateNonce } from "./webviewNonce";

export function renderWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
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
    vscode.Uri.joinPath(mediaRoot, "connectionView.css"),
  );
  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "connectionView.js"),
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

  const templatePath = path.join(
    extensionUri.fsPath,
    "media",
    "connectionView.html",
  );
  const template = fs.readFileSync(templatePath, "utf8");

  return substitute(template, {
    csp,
    nonce,
    codiconsCssUri: codiconsCssUri.toString(),
    cssUri: cssUri.toString(),
    jsUri: jsUri.toString(),
    customIconUrisJson: JSON.stringify(customIconUris),
  });
}

/** Naive ${key} substitution. Keys must be alphanumeric/camelCase. */
function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(`renderWebviewHtml: missing substitution for \${${key}}`);
    }
    return values[key];
  });
}
