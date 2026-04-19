/**
 * Config validation + rolling-backup restore commands. Exposed so users who
 * hand-edit ~/.vscrt/vscrtConfig.json can (a) get a readable error report
 * without guessing line/column from red squiggles, and (b) undo a bad edit
 * by picking from the last N auto-snapshots the save path writes.
 *
 * Validation here is intentionally lightweight — JSON parse + shape check
 * (folder is array, clusters have `name`, nodes have `name` + `endpoint`).
 * Full schema enforcement still happens in the editor via the
 * contributes.jsonValidation hookup; running AJV at runtime would pull a
 * ~60 KB dependency into the shipped bundle for rarely-used commands.
 */

import * as fs from "fs";
import * as vscode from "vscode";
import { log } from "../log";
import {
  BackupEntry,
  listBackups,
} from "../config/vscrtConfigBackup";
import { formatError } from "../errorUtils";
import { vscrtBackupsDir, vscrtConfigFilePath } from "../fsPaths";
import { CommandDeps } from "./types";

function configFilePath(): string {
  return vscrtConfigFilePath();
}

function backupsDir(): string {
  return vscrtBackupsDir();
}

export interface ValidationIssue {
  pointer: string;
  message: string;
}

/**
 * Pure shape check. Returns an array of `{ pointer, message }` issues; empty
 * means the config is structurally valid (JSON schema gaps are surfaced in
 * the editor, not here). Exported for unit testing.
 */
export function validateConfigShape(cfg: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    issues.push({ pointer: "", message: "Root must be a JSON object." });
    return issues;
  }
  const root = cfg as Record<string, unknown>;
  if (root.folder !== undefined) {
    if (!Array.isArray(root.folder)) {
      issues.push({ pointer: "/folder", message: "Must be an array." });
    } else {
      root.folder.forEach((c, i) =>
        validateCluster(c, `/folder/${i}`, issues),
      );
    }
  }
  return issues;
}

function validateCluster(
  cluster: unknown,
  pointer: string,
  issues: ValidationIssue[],
): void {
  if (cluster === null || typeof cluster !== "object" || Array.isArray(cluster)) {
    issues.push({ pointer, message: "Folder must be a JSON object." });
    return;
  }
  const c = cluster as Record<string, unknown>;
  if (typeof c.name !== "string" || !c.name.trim()) {
    issues.push({
      pointer: `${pointer}/name`,
      message: "Folder must have a non-empty 'name' string.",
    });
  }
  if (c.nodes !== undefined) {
    if (!Array.isArray(c.nodes)) {
      issues.push({
        pointer: `${pointer}/nodes`,
        message: "Must be an array.",
      });
    } else {
      c.nodes.forEach((n, i) =>
        validateNode(n, `${pointer}/nodes/${i}`, issues),
      );
    }
  }
  if (c.subfolder !== undefined) {
    if (!Array.isArray(c.subfolder)) {
      issues.push({
        pointer: `${pointer}/subfolder`,
        message: "Must be an array.",
      });
    } else {
      c.subfolder.forEach((sc, i) =>
        validateCluster(sc, `${pointer}/subfolder/${i}`, issues),
      );
    }
  }
}

function validateNode(
  node: unknown,
  pointer: string,
  issues: ValidationIssue[],
): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    issues.push({ pointer, message: "Server must be a JSON object." });
    return;
  }
  const n = node as Record<string, unknown>;
  if (typeof n.name !== "string" || !n.name.trim()) {
    issues.push({
      pointer: `${pointer}/name`,
      message: "Server must have a non-empty 'name' string.",
    });
  }
  if (typeof n.endpoint !== "string" || !n.endpoint.trim()) {
    issues.push({
      pointer: `${pointer}/endpoint`,
      message: "Server must have a non-empty 'endpoint' string.",
    });
  }
}

/** Count folders (including nested) + nodes for a QuickPick description. */
export function summarizeConfig(cfg: unknown): { folders: number; nodes: number } {
  let folders = 0;
  let nodes = 0;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { folders, nodes };
  }
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const c of list) {
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        continue;
      }
      folders += 1;
      const rec = c as Record<string, unknown>;
      if (Array.isArray(rec.nodes)) {
        nodes += rec.nodes.length;
      }
      walk(rec.subfolder);
    }
  };
  walk((cfg as Record<string, unknown>).folder);
  return { folders, nodes };
}

function formatBackupRelativeTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms)) {
    return "(unknown time)";
  }
  const diffS = Math.max(0, Math.floor((now - ms) / 1000));
  if (diffS < 60) {
    return `${diffS}s ago`;
  }
  if (diffS < 3600) {
    return `${Math.floor(diffS / 60)}m ago`;
  }
  if (diffS < 86400) {
    return `${Math.floor(diffS / 3600)}h ago`;
  }
  return `${Math.floor(diffS / 86400)}d ago`;
}

export function registerConfigRecoveryCommands(
  deps: CommandDeps,
): vscode.Disposable[] {
  const { configManager, connectionView } = deps;

  const validateCommand = vscode.commands.registerCommand(
    "vsCRT.validateConfig",
    async () => {
      const filePath = configFilePath();
      let text: string;
      try {
        text = await fs.promises.readFile(filePath, "utf-8");
      } catch (err) {
        vscode.window.showErrorMessage(
          `vsCRT: could not read ${filePath}: ${formatError(err)}`,
        );
        return;
      }
      if (!text.trim()) {
        vscode.window.showInformationMessage(
          "vsCRT: config file is empty (treated as blank config).",
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        log.error("validateConfig: JSON parse error:", err);
        vscode.window
          .showErrorMessage(
            `vsCRT: vscrtConfig.json is not valid JSON. ${formatError(err)}`,
            "Show Output Log",
          )
          .then((pick) => {
            if (pick === "Show Output Log") {
              log.show();
            }
          });
        return;
      }
      const issues = validateConfigShape(parsed);
      if (issues.length === 0) {
        const summary = summarizeConfig(parsed);
        const folderWord = summary.folders === 1 ? "folder" : "folders";
        const serverWord = summary.nodes === 1 ? "server" : "servers";
        vscode.window.showInformationMessage(
          `vsCRT: config is valid — ${summary.folders} ${folderWord}, ${summary.nodes} ${serverWord}.`,
        );
        return;
      }
      log.info(`validateConfig: ${issues.length} ${issues.length === 1 ? "issue" : "issues"} found:`);
      for (const i of issues) {
        log.info(`  ${i.pointer || "/"} — ${i.message}`);
      }
      vscode.window
        .showWarningMessage(
          `vsCRT: config has ${issues.length} structural ${issues.length === 1 ? "issue" : "issues"}. Open the output log for details.`,
          "Show Output Log",
        )
        .then((pick) => {
          if (pick === "Show Output Log") {
            log.show();
          }
        });
    },
  );

  const restoreCommand = vscode.commands.registerCommand(
    "vsCRT.restoreConfigBackup",
    async () => {
      const dir = backupsDir();
      const entries = await listBackups(dir);
      if (entries.length === 0) {
        vscode.window.showInformationMessage(
          "vsCRT: no backups available yet. Backups are written automatically before each save.",
        );
        return;
      }
      const items = entries.map((e) => {
        const preview = previewBackup(e);
        const when = formatBackupRelativeTime(e.timestamp);
        const sizeInfo = preview.parseOk
          ? `${preview.folders} ${preview.folders === 1 ? "folder" : "folders"}, ${preview.nodes} ${preview.nodes === 1 ? "server" : "servers"}`
          : "(not valid JSON)";
        return {
          label: formatTimestampLabel(e),
          description: when,
          detail: sizeInfo,
          entry: e,
        };
      });
      const picked = await vscode.window.showQuickPick(items, {
        title: "vsCRT: Restore Config Backup",
        placeHolder: "Pick a backup to restore (newest first)",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) {
        return;
      }

      const confirm = "Restore";
      const confirmed = await vscode.window.showWarningMessage(
        `Replace vscrtConfig.json with backup from ${picked.description}?`,
        {
          modal: true,
          detail:
            "A fresh backup of the current file is written first, so you can undo this by picking that backup next time.",
        },
        confirm,
      );
      if (confirmed !== confirm) {
        return;
      }

      try {
        const text = await fs.promises.readFile(picked.entry.fullPath, "utf-8");
        await fs.promises.writeFile(configFilePath(), text, {
          encoding: "utf-8",
        });
        configManager.invalidateCache();
        void connectionView.reload();
        vscode.window.showInformationMessage(
          `vsCRT: restored ${picked.entry.filename}.`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `vsCRT: restore failed: ${formatError(err)}`,
        );
      }
    },
  );

  return [validateCommand, restoreCommand];
}

interface BackupPreview {
  parseOk: boolean;
  folders: number;
  nodes: number;
}

function previewBackup(entry: BackupEntry): BackupPreview {
  try {
    const text = fs.readFileSync(entry.fullPath, "utf-8");
    const parsed = JSON.parse(text);
    const { folders, nodes } = summarizeConfig(parsed);
    return { parseOk: true, folders, nodes };
  } catch {
    return { parseOk: false, folders: 0, nodes: 0 };
  }
}

function formatTimestampLabel(entry: BackupEntry): string {
  if (!Number.isFinite(entry.timestamp)) {
    return entry.filename;
  }
  const d = new Date(entry.timestamp);
  // "2026-04-16 21:07:42"
  const iso = d.toISOString();
  return iso.slice(0, 19).replace("T", " ");
}

