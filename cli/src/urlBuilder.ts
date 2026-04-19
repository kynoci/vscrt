/**
 * Build `vscode://kynoci.vscrt/<verb>?<params>` URLs. The extension's
 * URL handler (src/commands/uriHandler.ts) parses the same shape — any
 * change here must be mirrored there. Pure: no I/O.
 */

export const PUBLISHER = "kynoci";
export const EXTENSION_NAME = "vscrt";
export const SCHEME = "vscode";

/** Complete URL prefix (e.g. `vscode://kynoci.vscrt/`). */
export function urlPrefix(): string {
  return `${SCHEME}://${PUBLISHER}.${EXTENSION_NAME}/`;
}

export type DeepLinkVerb =
  | "connect"
  | "open"
  | "quickConnect"
  | "validate"
  | "sftp"
  | "sftpBrowser";

export function buildDeepLink(
  verb: DeepLinkVerb,
  params: Record<string, string | undefined> = {},
): string {
  const search: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) {
      continue;
    }
    search.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  const query = search.length > 0 ? `?${search.join("&")}` : "";
  return `${SCHEME}://${PUBLISHER}.${EXTENSION_NAME}/${verb}${query}`;
}
