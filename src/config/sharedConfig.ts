/**
 * Team-shared config overlay.
 *
 * The user's personal config at `~/.vscrt/vscrtConfig.json` remains the
 * single writable source of truth. When the `vsCRT.sharedConfigPaths`
 * setting points at one or more additional files, we load them, strip
 * every password-bearing field, and surface their folders as a synthetic
 * top-level "Shared (read-only)" node in the connection view.
 *
 * Contract:
 *   - Only `publickey` / implicit agent auth flows through. Any node
 *     asking for password auth, or carrying a `password*` field, has
 *     that field dropped on load.
 *   - Loads are gated at the call site on `workspace.isTrusted` — an
 *     untrusted workspace gets no shared overlay.
 *   - The synthetic folder is stripped before any save so it never
 *     round-trips into the user's personal config file.
 */
import * as fs from "fs/promises";
import * as path from "path";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
} from "./vscrtConfigTypes";

/** Top-level cluster name used for the synthetic read-only overlay. */
export const SHARED_FOLDER_NAME = "Shared (read-only)";

/**
 * True when `p` addresses a node/cluster inside the synthetic overlay.
 * Every mutation path checks this and bails with a toast rather than
 * writing back through a shared entry.
 */
export function isSharedPath(p: string | null | undefined): boolean {
  if (!p) {
    return false;
  }
  return p === SHARED_FOLDER_NAME || p.startsWith(`${SHARED_FOLDER_NAME}/`);
}

/**
 * Return a copy of `node` with every password-bearing field stripped.
 * Auth method is coerced to `publickey` unless the node already uses
 * publickey (implicit agent is modeled as the absence of `preferredAuth`
 * + `identityFile`, which we also permit).
 *
 * Exported for unit tests. Pure.
 */
export function sanitizeSharedNode(node: CRTConfigNode): CRTConfigNode {
  const out: CRTConfigNode = { ...node };
  // Drop every password bearer, regardless of encoding. Shared configs
  // MUST NOT ship secrets — the stored ciphertext blob is keyed to the
  // author's passphrase/keychain and would never decrypt for a peer.
  delete out.password;
  delete out.passwordStorage;
  delete out.passwordDelivery;
  // Coerce auth to publickey unless the node is already publickey. A
  // shared "password" node would pop a password prompt at connect time
  // with no hope of satisfying it — hide the footgun.
  if (out.preferredAuthentication === "password") {
    out.preferredAuthentication = "publickey";
  }
  return out;
}

/**
 * Recursive sanitization — applies `sanitizeSharedNode` to every node
 * and walks subfolders. Returns a fresh cluster tree; the input is not
 * mutated.
 */
export function sanitizeSharedCluster(
  cluster: CRTConfigCluster,
): CRTConfigCluster {
  const out: CRTConfigCluster = { name: cluster.name };
  if (cluster.icon) {
    out.icon = cluster.icon;
  }
  if (cluster.nodes) {
    out.nodes = cluster.nodes.map(sanitizeSharedNode);
  }
  if (cluster.subfolder) {
    out.subfolder = cluster.subfolder.map(sanitizeSharedCluster);
  }
  return out;
}

/**
 * Parse a shared-config file and return its top-level folders. Any
 * parse error resolves to `[]` with an `onError` callback so the caller
 * can log (production) or assert (tests).
 */
export async function readSharedConfigFile(
  filePath: string,
  onError?: (err: unknown) => void,
): Promise<CRTConfigCluster[]> {
  try {
    const buf = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(buf) as CRTConfig;
    if (!Array.isArray(parsed.folder)) {
      return [];
    }
    return parsed.folder.map(sanitizeSharedCluster);
  } catch (err) {
    onError?.(err);
    return [];
  }
}

/**
 * Build the synthetic top-level folder that hosts every shared cluster.
 * The folder is itself marked with a `$(lock)` codicon so the webview
 * can render a lock badge without any special per-row logic.
 *
 * Each source file's folders become direct subfolders of the synthetic
 * root. If two files ship a folder named "Prod", both show up as
 * siblings (no name-collision merging) — keeps provenance explicit.
 */
export function buildSharedFolder(
  clustersPerFile: CRTConfigCluster[][],
): CRTConfigCluster | undefined {
  const flat = clustersPerFile.flat();
  if (flat.length === 0) {
    return undefined;
  }
  return {
    name: SHARED_FOLDER_NAME,
    icon: "lock",
    subfolder: flat,
  };
}

/**
 * Append the synthetic shared folder to `userConfig.folder` and return
 * the merged config. The input is shallow-cloned; its `folder` array is
 * re-created. Callers should treat the returned object as the one to
 * render; the personal config file on disk stays untouched.
 */
export function mergeSharedIntoConfig(
  userConfig: CRTConfig,
  clustersPerFile: CRTConfigCluster[][],
): CRTConfig {
  const sharedFolder = buildSharedFolder(clustersPerFile);
  if (!sharedFolder) {
    return userConfig;
  }
  const personal = userConfig.folder ?? [];
  // Strip any stale synthetic folder so back-to-back merges don't stack.
  const cleaned = personal.filter((c) => c.name !== SHARED_FOLDER_NAME);
  return {
    ...userConfig,
    folder: [...cleaned, sharedFolder],
  };
}

/**
 * Strip the synthetic shared folder from a config before serialization.
 * Every save path must funnel through here so the overlay never lands
 * in `~/.vscrt/vscrtConfig.json`.
 */
export function stripSharedFolder(config: CRTConfig): CRTConfig {
  if (!config.folder) {
    return config;
  }
  const cleaned = config.folder.filter((c) => c.name !== SHARED_FOLDER_NAME);
  if (cleaned.length === config.folder.length) {
    return config;
  }
  return { ...config, folder: cleaned };
}

/**
 * Resolve a setting-provided path string. Users can write
 * `${workspaceFolder}/team.json` or `~/team.json` or an absolute path.
 * We handle home-expansion here; workspace-folder expansion is the
 * caller's job since this module is filesystem-only and shouldn't
 * depend on VS Code APIs.
 */
export function resolveSharedConfigPath(
  raw: string,
  homeDir: string,
): string {
  if (raw.startsWith("~/") || raw === "~") {
    return path.join(homeDir, raw.slice(1) || ".");
  }
  return raw;
}
