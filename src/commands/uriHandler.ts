/**
 * Custom URL-scheme handler. Registered with VS Code via
 * `window.registerUriHandler`, this routes `vscode://kynoci.vscrt/<verb>`
 * deep links into the same command surface the Connection tree + Command
 * Palette already use.
 *
 * Sibling of the CLI: `vscrt connect prod-web` uses `code --open-url` to
 * invoke these exact URLs, so whatever lands here also lands when the
 * CLI is used from a shell.
 *
 * Security posture:
 *   - No verb ever sends a password automatically. `/connect` opens the
 *     terminal (the user sees the session); credentials come from the
 *     existing SecretService / passphrase flow with the same UX as a
 *     click-through connect.
 *   - The `name` param is only used as a key into the config tree — it
 *     never reaches `spawn` / `exec` / the shell.
 *   - Unknown verbs hard-reject with a toast; silently falling through
 *     could be weaponised by a malicious page.
 */

import * as vscode from "vscode";
import { findNodeByPath } from "../config/vscrtConfigPaths";
import { log } from "../log";
import type { CommandDeps } from "./types";

export type DeepLinkVerb =
  | "connect"
  | "open"
  | "quickConnect"
  | "validate"
  | "sftp"
  | "sftpBrowser"
  | "unknown";

export interface DeepLinkParsed {
  verb: DeepLinkVerb;
  /** Value of the `name` query param (decoded), when present. */
  name?: string;
  /** The raw input, retained for error reporting. */
  raw: string;
}

/**
 * Parse a deep-link URI into a sealed verb + optional `name` param.
 * Pure — no VS Code calls — so it's fully unit-testable.
 *
 * Accepted shapes:
 *   vscode://kynoci.vscrt/connect?name=Prod/Web
 *   vscode://kynoci.vscrt/open?name=Staging
 *   vscode://kynoci.vscrt/quickConnect
 *   vscode://kynoci.vscrt/validate
 */
export function parseDeepLink(uri: { path: string; query: string }): DeepLinkParsed {
  const verbPath = uri.path.replace(/^\//, "").split("/")[0] ?? "";
  const verb: DeepLinkVerb =
    verbPath === "connect" ||
    verbPath === "open" ||
    verbPath === "quickConnect" ||
    verbPath === "validate" ||
    verbPath === "sftp" ||
    verbPath === "sftpBrowser"
      ? verbPath
      : "unknown";

  const params = new URLSearchParams(uri.query);
  const nameRaw = params.get("name");
  const name = nameRaw ? nameRaw : undefined;

  return { verb, name, raw: `${uri.path}?${uri.query}` };
}

export class VscrtUriHandler implements vscode.UriHandler {
  constructor(private readonly deps: CommandDeps) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    const parsed = parseDeepLink({ path: uri.path, query: uri.query });
    log.info(
      `Deep link received: verb=${parsed.verb}${parsed.name ? ` name="${parsed.name}"` : ""}`,
    );
    await this.route(parsed);
  }

  private async route(parsed: DeepLinkParsed): Promise<void> {
    switch (parsed.verb) {
      case "connect":
        await this.handleConnect(parsed);
        return;
      case "open":
        await this.handleOpen(parsed);
        return;
      case "quickConnect":
        await vscode.commands.executeCommand("vsCRT.quickConnect");
        return;
      case "validate":
        await vscode.commands.executeCommand("vsCRT.validateConfig");
        return;
      // The legacy `sftp` verb used to open an interactive sftp terminal
      // via `vsCRT.openSftp`. That command was removed; we redirect to
      // the browser so old deep-links keep working.
      case "sftp":
      case "sftpBrowser":
        await this.handleSftp(
          parsed,
          "vsCRT.openSftpBrowser",
          "vsCRT.openSftpBrowserPick",
        );
        return;
      case "unknown":
      default:
        vscode.window.showErrorMessage(
          `vsCRT: unknown deep-link verb in ${parsed.raw || "(empty)"}.`,
        );
    }
  }

  /**
   * Shared handler for `/sftp` and `/sftpBrowser` deep links. With a
   * `name` param we resolve directly to the node target; without,
   * route to the QuickPick-based command (palette-style) so users
   * clicking a bare `/sftp` URL get a picker instead of an error.
   */
  private async handleSftp(
    parsed: DeepLinkParsed,
    directCommandId: string,
    pickerCommandId: string,
  ): Promise<void> {
    if (!parsed.name) {
      await vscode.commands.executeCommand(pickerCommandId);
      return;
    }
    const cfg = await this.deps.configManager.loadConfig();
    if (!cfg) {
      vscode.window.showErrorMessage(
        "vsCRT: config is unavailable — cannot resolve deep-link target.",
      );
      return;
    }
    const node = findNodeByPath(cfg, parsed.name);
    if (!node) {
      vscode.window.showErrorMessage(
        `vsCRT: no server found at "${parsed.name}".`,
      );
      return;
    }
    await vscode.commands.executeCommand(directCommandId, {
      item: {
        type: "node",
        path: parsed.name,
        label: node.name,
        config: node,
      },
    });
  }

  private async handleConnect(parsed: DeepLinkParsed): Promise<void> {
    if (!parsed.name) {
      vscode.window.showErrorMessage(
        "vsCRT: `/connect` deep link requires a `name` parameter (e.g. ?name=Prod/Web).",
      );
      return;
    }
    const cfg = await this.deps.configManager.loadConfig();
    if (!cfg) {
      vscode.window.showErrorMessage(
        "vsCRT: config is unavailable — cannot resolve deep-link target.",
      );
      return;
    }
    const node = findNodeByPath(cfg, parsed.name);
    if (!node) {
      vscode.window.showErrorMessage(
        `vsCRT: no server found at "${parsed.name}". Check the path spelling.`,
      );
      return;
    }
    log.info(`Deep link → connectFromConfig "${parsed.name}"`);
    await this.deps.sshService.connectFromConfig(node, "panel");
  }

  private async handleOpen(parsed: DeepLinkParsed): Promise<void> {
    // The "open but don't connect" verb: reveal the node in the tree and
    // select it. We don't have a dedicated reveal API on the webview
    // provider; the least-magical fallback is to refresh + focus the
    // Connection view so the user can see the target highlighted.
    if (!parsed.name) {
      vscode.window.showErrorMessage(
        "vsCRT: `/open` deep link requires a `name` parameter.",
      );
      return;
    }
    const cfg = await this.deps.configManager.loadConfig();
    if (!cfg || !findNodeByPath(cfg, parsed.name)) {
      vscode.window.showErrorMessage(
        `vsCRT: no server found at "${parsed.name}".`,
      );
      return;
    }
    await vscode.commands.executeCommand("workbench.view.extension.vscrt");
    // Future: once the webview exposes a reveal API, wire it here. For
    // now we just bring the panel forward so the user can locate it.
  }
}
