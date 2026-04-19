/**
 * Read a server profile out of `~/.vscrt/vscrtConfig.json` by
 * slash-delimited path. Pure Node — no `vscode` imports.
 *
 * Deliberately minimal: no migrations, no schema validation, no
 * secret resolution. The on-disk JSON is trusted; the extension's
 * full loader handles drift / schema evolution. This reader exists
 * for the CLI and programmatic callers that just need "give me the
 * node at path X."
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  CRTConfigCluster,
  CRTConfigNode,
} from "../../config/vscrtConfigTypes";

export interface VscrtConfigFile {
  folder?: CRTConfigCluster[];
}

export function defaultConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".vscrt", "vscrtConfig.json");
}

export function readConfigFile(
  filePath: string = defaultConfigPath(),
): VscrtConfigFile {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as VscrtConfigFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Config at ${filePath} is not a JSON object.`);
  }
  return parsed;
}

/**
 * Resolve a slash-delimited path (e.g. "Prod/Web/api-01") into a
 * specific `CRTConfigNode`. Returns undefined when no node matches.
 *
 * Path semantics: each segment except the last names a folder
 * (top-level `folder[i].name` or nested `subfolder[i].name`). The
 * final segment names a node inside the last folder's `nodes` list.
 * Matching is case-sensitive.
 */
export function resolveProfile(
  cfg: VscrtConfigFile,
  profilePath: string,
): CRTConfigNode | undefined {
  const segs = profilePath.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) {
    return undefined;
  }
  const nodeName = segs[segs.length - 1];
  const folderSegs = segs.slice(0, -1);

  const folders = cfg.folder ?? [];
  // Walk matching folders by name at each depth.
  let currentList: CRTConfigCluster[] = folders;
  let currentFolder: CRTConfigCluster | undefined;
  for (const seg of folderSegs) {
    const match = currentList.find((f) => f.name === seg);
    if (!match) {
      return undefined;
    }
    currentFolder = match;
    currentList = match.subfolder ?? [];
  }

  // No folder segments: search across every top-level folder's nodes.
  if (!currentFolder) {
    for (const f of folders) {
      const hit = (f.nodes ?? []).find((n) => n.name === nodeName);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }
  return (currentFolder.nodes ?? []).find((n) => n.name === nodeName);
}

/**
 * List every node in the config as `Folder/Sub/Name` paths. Useful
 * for `vscrt-remote ls` and for error messages that suggest the
 * closest matches when a path misses.
 */
export function listProfilePaths(cfg: VscrtConfigFile): string[] {
  const out: string[] = [];
  const walk = (list: CRTConfigCluster[], prefix: string): void => {
    for (const f of list) {
      const here = prefix ? `${prefix}/${f.name}` : f.name;
      for (const n of f.nodes ?? []) {
        out.push(`${here}/${n.name}`);
      }
      if (f.subfolder) {
        walk(f.subfolder, here);
      }
    }
  };
  walk(cfg.folder ?? [], "");
  return out;
}
