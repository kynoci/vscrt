/**
 * Per-node globalState persistence for the SFTP Browser's last-
 * visited remote path. Stored as a single `Record<nodeName, path>`
 * map under one key so the browser for "server A" doesn't overwrite
 * the remembered path for "server B".
 */
import type * as vscode from "vscode";

export const LAST_PATH_KEY = "vscrt.sftpBrowser.lastPath";

export function readLastPath(
  ctx: vscode.ExtensionContext,
  nodeName: string,
): string | undefined {
  const map = ctx.globalState.get<Record<string, string>>(LAST_PATH_KEY);
  return map?.[nodeName];
}

export async function writeLastPath(
  ctx: vscode.ExtensionContext,
  nodeName: string,
  path: string,
): Promise<void> {
  const map = ctx.globalState.get<Record<string, string>>(LAST_PATH_KEY) ?? {};
  map[nodeName] = path;
  await ctx.globalState.update(LAST_PATH_KEY, map);
}
