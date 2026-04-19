/**
 * Per-node globalState persistence for the Local pane's last-visited
 * path. Mirrors `persistPath.ts` verbatim except for the key —
 * keeping the helper pair identical so a future unified migration
 * touches one pattern, not two.
 */
import type * as vscode from "vscode";

export const LAST_LOCAL_PATH_KEY = "vscrt.sftpBrowser.lastLocalPath";

export function readLastLocalPath(
  ctx: vscode.ExtensionContext,
  nodeName: string,
): string | undefined {
  const map = ctx.globalState.get<Record<string, string>>(LAST_LOCAL_PATH_KEY);
  return map?.[nodeName];
}

export async function writeLastLocalPath(
  ctx: vscode.ExtensionContext,
  nodeName: string,
  path: string,
): Promise<void> {
  const map =
    ctx.globalState.get<Record<string, string>>(LAST_LOCAL_PATH_KEY) ?? {};
  map[nodeName] = path;
  await ctx.globalState.update(LAST_LOCAL_PATH_KEY, map);
}
