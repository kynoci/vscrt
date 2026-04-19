/**
 * "vsCRT: Import from ~/.ssh/config" — a one-shot onboarding helper for
 * users arriving from plain ssh. Parses the file, presents a checkbox
 * QuickPick (all selected by default), maps each chosen Host block to a
 * CRTConfigNode, and appends them to a root-level "Imported" folder.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CRTConfigNode, uniqueName } from "../config/vscrtConfig";
import { log } from "../log";
import {
  SshHostEntry,
  isWildcard,
  parseSshConfig,
} from "../remote";
import { JUMP_HOST_PATTERN } from "../treeView/serverFormModel";
import { formatError } from "./commandUtils";
import { CommandDeps } from "./types";

const IMPORTED_FOLDER = "Imported";

export function registerImportSshConfigCommand(
  deps: CommandDeps,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.importSshConfig", async () => {
      await runImport(deps);
    }),
  ];
}

async function runImport(deps: CommandDeps): Promise<void> {
  const { configManager, connectionView } = deps;

  const sshConfigPath = path.join(os.homedir(), ".ssh", "config");
  let text: string;
  try {
    text = await fs.promises.readFile(sshConfigPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      vscode.window.showInformationMessage(
        `vsCRT: no SSH config found at ${sshConfigPath}.`,
      );
      return;
    }
    vscode.window.showErrorMessage(
      `vsCRT: could not read ${sshConfigPath} — ${formatError(err)}`,
    );
    return;
  }

  const entries = parseSshConfig(text);
  const importable = entries.filter((e) => !isWildcard(e.name));
  if (importable.length === 0) {
    vscode.window.showInformationMessage(
      `vsCRT: no importable Host entries found in ${sshConfigPath}.`,
    );
    return;
  }

  interface PickItem extends vscode.QuickPickItem {
    entry: SshHostEntry;
  }
  const items: PickItem[] = importable.map((entry) => ({
    label: entry.name,
    description: describeEntry(entry),
    entry,
    picked: true,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Import from ${sshConfigPath}`,
    placeHolder: `Select hosts to import into the "${IMPORTED_FOLDER}" folder`,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!picked || picked.length === 0) {
    return;
  }

  // Ensure the target folder exists. appendCluster is a no-op if the
  // folder already exists at the requested depth.
  const currentConfig = await configManager.loadConfig();
  const alreadyThere =
    currentConfig?.folder?.some((f) => f.name === IMPORTED_FOLDER) ?? false;
  if (!alreadyThere) {
    await configManager.appendCluster(null, IMPORTED_FOLDER);
  }

  const existingNodes =
    (await configManager.getAllNodesInFolder(IMPORTED_FOLDER)) ?? [];
  const usedNames = new Set(existingNodes.map((n) => n.name));

  let imported = 0;
  let droppedJumps = 0;
  let appendFailures = 0;
  for (const item of picked) {
    const node = hostEntryToNode(item.entry, { droppedJumpHandler: () => {
      droppedJumps += 1;
    }});
    if (usedNames.has(node.name)) {
      node.name = uniqueName(node.name, [...usedNames]);
    }
    usedNames.add(node.name);

    const ok = await configManager.appendNode(IMPORTED_FOLDER, node);
    if (ok) {
      imported += 1;
    } else {
      appendFailures += 1;
    }
  }

  await connectionView.reload();

  const bits = [`imported ${imported} host(s) into "${IMPORTED_FOLDER}"`];
  if (droppedJumps > 0) {
    bits.push(`dropped ${droppedJumps} unsafe ProxyJump value(s)`);
  }
  if (appendFailures > 0) {
    bits.push(`${appendFailures} append failure(s)`);
  }
  vscode.window.showInformationMessage(`vsCRT: ${bits.join("; ")}.`);
}

interface MapOptions {
  /** Called once per entry whose ProxyJump value is unsafe and was dropped. */
  droppedJumpHandler?: () => void;
}

/**
 * Map an SshHostEntry into a CRTConfigNode. Exported for testability.
 * ProxyJump values that don't match the shell-safe character set are
 * dropped — the rest of the entry still imports, and the caller is
 * notified via the optional callback so UI can aggregate a count.
 */
export function hostEntryToNode(
  entry: SshHostEntry,
  opts: MapOptions = {},
): CRTConfigNode {
  const user = (entry.user ?? "").trim();
  const host = (entry.hostName ?? entry.name).trim();
  const endpoint = buildEndpoint(user, host, entry.port);

  const node: CRTConfigNode = {
    name: entry.name,
    endpoint,
  };

  if (entry.identityFile) {
    node.preferredAuthentication = "publickey";
    node.identityFile = entry.identityFile;
  }

  if (entry.proxyJump) {
    if (JUMP_HOST_PATTERN.test(entry.proxyJump)) {
      node.jumpHost = entry.proxyJump;
    } else {
      log.warn(
        `Import: dropping unsafe ProxyJump for "${entry.name}": ${entry.proxyJump}`,
      );
      opts.droppedJumpHandler?.();
    }
  }

  if (entry.forwardAgent === true) {
    node.agentForwarding = true;
  }

  if (
    entry.addKeysToAgent === "yes" ||
    entry.addKeysToAgent === "no" ||
    entry.addKeysToAgent === "ask" ||
    entry.addKeysToAgent === "confirm"
  ) {
    node.addKeysToAgent = entry.addKeysToAgent;
  }

  if (typeof entry.connectTimeoutSeconds === "number") {
    node.connectTimeoutSeconds = entry.connectTimeoutSeconds;
  }
  if (typeof entry.serverAliveIntervalSeconds === "number") {
    node.serverAliveIntervalSeconds = entry.serverAliveIntervalSeconds;
  }
  if (typeof entry.identitiesOnly === "boolean") {
    node.identitiesOnly = entry.identitiesOnly;
  }
  if (entry.extraDirectives && Object.keys(entry.extraDirectives).length > 0) {
    node.extraSshDirectives = { ...entry.extraDirectives };
  }

  return node;
}

function buildEndpoint(user: string, host: string, port?: number): string {
  let ep = user ? `${user}@${host}` : host;
  if (typeof port === "number" && port !== 22) {
    ep += `:${port}`;
  }
  return ep;
}

function describeEntry(e: SshHostEntry): string {
  const parts: string[] = [];
  const host = e.hostName ?? "";
  const userHost =
    e.user && host ? `${e.user}@${host}` : host || e.name;
  parts.push(userHost);
  if (typeof e.port === "number" && e.port !== 22) {
    parts.push(`port ${e.port}`);
  }
  if (e.identityFile) {
    parts.push(`key ${e.identityFile}`);
  }
  if (e.proxyJump) {
    parts.push(`-J ${e.proxyJump}`);
  }
  return parts.join(" · ");
}
