/**
 * vsCRT.showDiagnostics — write a one-shot, secret-free diagnostic
 * report into the output channel so users can paste it straight into
 * an issue report.
 *
 * Intentionally pull-only: never sends anything off the machine,
 * never reads configured passwords. The values we expose are the
 * ones already visible elsewhere (package.json version, counts from
 * loaded config, presence/absence of system binaries) — the point
 * of the command is to aggregate them in one place.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import { promisify } from "util";
import * as vscode from "vscode";
import { CRTConfig, CRTConfigCluster } from "../config/vscrtConfig";
import { log } from "../log";
import { listBackups } from "../config/vscrtConfigBackup";
import { vscrtBackupsDir } from "../fsPaths";
import { defaultKnownHostsPath } from "../remote";
import { CommandDeps } from "./types";

const execFileAsync = promisify(execFile);

const BINARIES_OF_INTEREST = [
  "ssh",
  "sshpass",
  "ssh-keygen",
  "ssh-keyscan",
  "ssh-add",
  "ssh-copy-id",
] as const;

export interface DiagnosticsReport {
  version: string;
  vscodeVersion: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  counts: {
    folders: number;
    nodes: number;
    configBackups: number;
    knownHostsLines: number;
  };
  binaries: Record<string, string>; // name → "present" | "missing" | error
  vault: {
    initialized: boolean;
    unlocked: boolean;
    autoLockMode: string;
    hostKeyPolicy: string;
  };
  connectionLog: {
    enabled: boolean;
    mode: string;
  };
}

/**
 * Render the report as a markdown block suitable for pasting into an
 * issue. Exported for unit testing the redaction invariant — assert
 * no endpoint/password/salt ever appears in the output.
 */
export function formatReport(report: DiagnosticsReport): string {
  const lines: string[] = [];
  lines.push("# vsCRT diagnostics");
  lines.push("");
  lines.push(`- **vsCRT version**: ${report.version}`);
  lines.push(`- **VS Code version**: ${report.vscodeVersion}`);
  lines.push(`- **Platform**: ${report.platform} (${report.arch})`);
  lines.push(`- **Node**: ${report.nodeVersion}`);
  lines.push("");
  lines.push("## Counts");
  lines.push(`- Folders: ${report.counts.folders}`);
  lines.push(`- Servers: ${report.counts.nodes}`);
  lines.push(`- Config backups: ${report.counts.configBackups}`);
  lines.push(`- known_hosts lines: ${report.counts.knownHostsLines}`);
  lines.push("");
  lines.push("## Binary availability");
  for (const [name, status] of Object.entries(report.binaries)) {
    lines.push(`- \`${name}\`: ${status}`);
  }
  lines.push("");
  lines.push("## Vault state");
  lines.push(`- Initialised: ${report.vault.initialized}`);
  lines.push(`- Unlocked: ${report.vault.unlocked}`);
  lines.push(`- Auto-lock mode: ${report.vault.autoLockMode}`);
  lines.push(`- Host-key policy: ${report.vault.hostKeyPolicy}`);
  lines.push("");
  lines.push("## Connection log");
  lines.push(`- Enabled: ${report.connectionLog.enabled}`);
  lines.push(`- Mode: ${report.connectionLog.mode}`);
  return lines.join("\n");
}

export function countConfig(cfg: CRTConfig | undefined | null): {
  folders: number;
  nodes: number;
} {
  let folders = 0;
  let nodes = 0;
  if (!cfg?.folder) {
    return { folders, nodes };
  }
  const walk = (clusters: CRTConfigCluster[]): void => {
    for (const c of clusters) {
      folders += 1;
      nodes += c.nodes?.length ?? 0;
      if (c.subfolder) {
        walk(c.subfolder);
      }
    }
  };
  walk(cfg.folder);
  return { folders, nodes };
}

async function checkBinaries(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of BINARIES_OF_INTEREST) {
    out[name] = await whichStatus(name);
  }
  return out;
}

async function whichStatus(binary: string): Promise<string> {
  // Use a platform-aware lookup that doesn't care whether it's on PATH
  // via `which` (POSIX) or `where` (Windows). Exit code 0 → present.
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(probe, [binary], {
      timeout: 3000,
      encoding: "utf-8",
    });
    return "present";
  } catch (err) {
    const e = err as { code?: number | string } | null;
    if (e?.code === "ENOENT") {
      return `${probe} not available`;
    }
    return "missing";
  }
}

async function countLinesIfExists(filePath: string): Promise<number> {
  try {
    const text = await fs.promises.readFile(filePath, "utf-8");
    return text.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

export function registerDiagnosticsCommand(
  deps: CommandDeps,
): vscode.Disposable[] {
  const { context, configManager, passphraseService } = deps;

  return [
    vscode.commands.registerCommand("vsCRT.showDiagnostics", async () => {
      await log.timed("showDiagnostics", async () => {
        const cfg = await configManager.loadConfig();
        const { folders, nodes } = countConfig(cfg);
        const backupsDir = vscrtBackupsDir();
        const backups = await listBackups(backupsDir);
        const knownHostsLines = await countLinesIfExists(
          defaultKnownHostsPath(),
        );
        const binaries = await checkBinaries();
        const settings = vscode.workspace.getConfiguration("vsCRT");
        const report: DiagnosticsReport = {
          version: (context.extension?.packageJSON?.version as string) ?? "?",
          vscodeVersion: vscode.version,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          counts: {
            folders,
            nodes,
            configBackups: backups.length,
            knownHostsLines,
          },
          binaries,
          vault: {
            initialized: await passphraseService.isInitialized(),
            unlocked: passphraseService.getCachedParams() !== undefined,
            autoLockMode: settings.get<string>("passphraseAutoLock") ?? "?",
            hostKeyPolicy: settings.get<string>("hostKeyPolicy") ?? "?",
          },
          connectionLog: {
            enabled:
              (settings.get<string>("connectionLogging") ?? "off") !== "off",
            mode: settings.get<string>("connectionLogging") ?? "off",
          },
        };
        const rendered = formatReport(report);
        // Log each line so the whole report is in the output channel
        // already formatted — users can copy-paste from there.
        for (const line of rendered.split("\n")) {
          log.info(line);
        }
        log.show(true);
        vscode.window.showInformationMessage(
          "vsCRT: diagnostics written to the Output Log. Paste the block into an issue when filing.",
        );
      });
    }),
  ];
}
