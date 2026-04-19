/**
 * Stand-alone reader for `~/.vscrt/vscrtConfig.json`. Lets `vscrt ls`
 * and `vscrt diag` work without the extension running.
 *
 * Deliberately minimal: no migrations, no secret resolution, no schema
 * validation. The extension handles all of that when it actually loads
 * the file. The CLI just needs to scan folders + nodes and display a
 * tree.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatError } from "./errorUtils";

export interface ReadConfigResult {
  path: string;
  exists: boolean;
  folder?: CliFolder[];
  error?: string;
}

export interface CliFolder {
  name: string;
  subfolder?: CliFolder[];
  nodes?: CliNode[];
}

export interface CliNode {
  name: string;
  endpoint?: string;
  preferredAuthentication?: string;
  identityFile?: string;
  jumpHost?: string;
}

export function defaultConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".vscrt", "vscrtConfig.json");
}

export function readConfig(filePath: string = defaultConfigPath()): ReadConfigResult {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { folder?: CliFolder[] };
    return {
      path: filePath,
      exists: true,
      folder: Array.isArray(parsed.folder) ? parsed.folder : [],
    };
  } catch (err) {
    return {
      path: filePath,
      exists: true,
      error: formatError(err),
    };
  }
}

export interface FlatRow {
  path: string;       // slash-joined (Prod/Web)
  endpoint?: string;
  auth?: string;
}

/**
 * Filter a flat row list by a case-insensitive substring match against
 * either `path` or `endpoint`. Pure — easy to unit-test.
 */
export function filterRows(
  rows: readonly FlatRow[],
  substring: string | undefined,
): FlatRow[] {
  if (!substring) {
    return [...rows];
  }
  const needle = substring.toLowerCase();
  return rows.filter(
    (r) =>
      r.path.toLowerCase().includes(needle) ||
      (r.endpoint?.toLowerCase().includes(needle) ?? false),
  );
}

/** Walk the tree and yield every node with its slash-joined path. */
export function flattenTree(folder: CliFolder[] | undefined): FlatRow[] {
  if (!folder) {
    return [];
  }
  const out: FlatRow[] = [];
  const walk = (list: CliFolder[], prefix: string): void => {
    for (const f of list) {
      const here = prefix ? `${prefix}/${f.name}` : f.name;
      for (const n of f.nodes ?? []) {
        out.push({
          path: `${here}/${n.name}`,
          endpoint: n.endpoint,
          auth: n.preferredAuthentication,
        });
      }
      if (f.subfolder) {
        walk(f.subfolder, here);
      }
    }
  };
  walk(folder, "");
  return out;
}
