/**
 * Per-verb command handlers. Each takes a ParsedArgs, does its thing,
 * and returns a process exit code. Output goes to stdout/stderr —
 * nothing else. Keeps the entry point (`index.ts`) tiny.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ParsedArgs } from "./argParser";
import {
  defaultConfigPath,
  filterRows,
  flattenTree,
  readConfig,
  type FlatRow,
} from "./configReader";
import { formatError } from "./errorUtils";
import { buildDeepLink } from "./urlBuilder";

const execFileAsync = promisify(execFile);

const BINARIES_OF_INTEREST = [
  "ssh",
  "sshpass",
  "ssh-keygen",
  "ssh-keyscan",
  "ssh-add",
  "ssh-copy-id",
  "code",
];

export async function runConnect(args: ParsedArgs): Promise<number> {
  const target = args.positional[0];
  if (!target) {
    process.stderr.write(
      "vscrt connect: missing <path>. Try: vscrt connect Prod/Web\n",
    );
    return 2;
  }
  const url = buildDeepLink("connect", { name: target });
  if (args.flags.json) {
    process.stdout.write(JSON.stringify({ url }) + "\n");
    return 0;
  }
  try {
    await execFileAsync("code", ["--open-url", url]);
    process.stdout.write(`vscrt: opened ${url}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `vscrt connect: could not exec 'code' — is the VS Code CLI on PATH?\n` +
        ` ${formatError(err)}\n`,
    );
    return 1;
  }
}

/**
 * `vscrt sftp [<path>] [--browser]` — symmetric to `connect`, opens
 * either the interactive SFTP terminal (default) or the Preview
 * browser (`--browser`). Omitting `<path>` opens the QuickPick-style
 * picker inside the extension.
 */
export async function runSftp(args: ParsedArgs): Promise<number> {
  const target = args.positional[0];
  const verb = args.flags.browser ? "sftpBrowser" : "sftp";
  const url = buildDeepLink(verb, target ? { name: target } : {});
  if (args.flags.json) {
    process.stdout.write(JSON.stringify({ url }) + "\n");
    return 0;
  }
  try {
    await execFileAsync("code", ["--open-url", url]);
    process.stdout.write(`vscrt: opened ${url}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `vscrt sftp: could not exec 'code' — is the VS Code CLI on PATH?\n` +
        ` ${formatError(err)}\n`,
    );
    return 1;
  }
}

export function runLs(args: ParsedArgs): number {
  const cfgPath =
    typeof args.flags.config === "string"
      ? args.flags.config
      : defaultConfigPath();
  const result = readConfig(cfgPath);
  if (!result.exists) {
    process.stderr.write(
      `vscrt ls: no config at ${result.path}. Run vsCRT in VS Code once to seed it.\n`,
    );
    return 1;
  }
  if (result.error) {
    process.stderr.write(
      `vscrt ls: ${result.error} (check ${result.path} for syntax errors)\n`,
    );
    return 1;
  }
  const rows = flattenTree(result.folder);
  const filter =
    typeof args.flags.filter === "string" ? args.flags.filter : undefined;
  const filtered = filterRows(rows, filter);

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(filtered, null, 2) + "\n");
    return 0;
  }

  if (filtered.length === 0) {
    const msg = filter
      ? `(no servers match filter: ${filter})\n`
      : "(no servers — add one via vsCRT in VS Code)\n";
    process.stdout.write(msg);
    return 0;
  }
  process.stdout.write(formatTable(filtered));
  return 0;
}

/**
 * Pure: render rows as a padded human-readable table (trailing newline
 * included). Column widths adapt to content but are capped at 80 chars;
 * overflow is truncated with a trailing `…`. Empty input yields a
 * header-only table (PATH + ENDPOINT + AUTH, no data rows).
 */
export function formatTable(rows: readonly FlatRow[]): string {
  const TABLE_MAX_COL = 80;
  const truncCol = (s: string, max: number): string => {
    if (s.length <= max) {
      return s;
    }
    return s.slice(0, max - 1) + "…";
  };
  const maxPath = Math.min(
    TABLE_MAX_COL,
    Math.max(4, ...rows.map((r) => r.path.length)),
  );
  const maxEp = Math.min(
    TABLE_MAX_COL,
    Math.max(8, ...rows.map((r) => (r.endpoint ?? "").length)),
  );
  const lines: string[] = [];
  lines.push(
    `${"PATH".padEnd(maxPath)}  ${"ENDPOINT".padEnd(maxEp)}  AUTH`,
  );
  lines.push(
    `${"-".repeat(maxPath)}  ${"-".repeat(maxEp)}  ----`,
  );
  for (const r of rows) {
    const p = truncCol(r.path, maxPath);
    const e = truncCol(r.endpoint ?? "", maxEp);
    lines.push(`${p.padEnd(maxPath)}  ${e.padEnd(maxEp)}  ${r.auth ?? ""}`);
  }
  return lines.join("\n") + "\n";
}

export interface DiagHeaderInput {
  timestamp: Date;
  nodeVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  cpuCount: number;
  home: string;
}

/**
 * Pure helper: render the diag report header (title + environment block)
 * from an input struct. Exported for unit tests.
 */
export function renderDiagHeader(input: DiagHeaderInput): string[] {
  return [
    "# vscrt diagnostics",
    "",
    `_generated ${input.timestamp.toISOString()}_`,
    "",
    `- Node: ${input.nodeVersion}`,
    `- Platform: ${input.platform} (${input.arch})`,
    `- OS release: ${input.osRelease}`,
    `- CPUs: ${input.cpuCount}`,
    `- HOME: ${input.home}`,
    "",
    "## Config",
  ];
}

export async function runDiag(_args: ParsedArgs): Promise<number> {
  const out: string[] = renderDiagHeader({
    timestamp: new Date(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuCount: os.cpus().length,
    home: os.homedir(),
  });
  const cfgPath = defaultConfigPath();
  if (fs.existsSync(cfgPath)) {
    const cfg = readConfig(cfgPath);
    if (cfg.error) {
      out.push(`- ${cfgPath}: ERROR ${cfg.error}`);
    } else {
      const rows = flattenTree(cfg.folder);
      out.push(`- ${cfgPath}: ${rows.length} ${rows.length === 1 ? "server" : "servers"}`);
    }
  } else {
    out.push(`- ${cfgPath}: (missing — the extension creates it on first run)`);
  }
  out.push("");
  out.push("## Binaries");
  for (const b of BINARIES_OF_INTEREST) {
    out.push(`- ${b}: ${await whichStatus(b)}`);
  }
  out.push("");
  out.push("## Backups dir");
  const backupsDir = path.join(os.homedir(), ".vscrt", "backups");
  if (fs.existsSync(backupsDir)) {
    const n = fs
      .readdirSync(backupsDir)
      .filter((f) => f.startsWith("vscrtConfig."))
      .length;
    out.push(`- ${backupsDir}: ${n} ${n === 1 ? "backup" : "backups"}`);
  } else {
    out.push(`- ${backupsDir}: (not yet created)`);
  }

  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

async function whichStatus(binary: string): Promise<string> {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(probe, [binary], {
      timeout: 3000,
      encoding: "utf-8",
    });
    const firstLine = stdout.split("\n")[0]?.trim();
    return firstLine ? `present (${firstLine})` : "present";
  } catch {
    return "missing";
  }
}

export function runHelp(): number {
  process.stdout.write(helpText());
  return 0;
}

export function runVersion(version: string): number {
  process.stdout.write(`vscrt ${version}\n`);
  return 0;
}

/**
 * Exported for tests: renders the help text that `runHelp` writes to
 * stdout. Pure — no I/O — so consumers can assert on the full text body.
 */
export function helpText(): string {
  return [
    "vscrt — CLI companion for the vsCRT VS Code extension",
    "",
    "Usage: vscrt <verb> [args]",
    "",
    "Verbs:",
    "  connect <path>        Open a saved server in a new VS Code terminal.",
    "  sftp [<path>]         Open an SFTP session (add --browser for the preview GUI).",
    "  ls                    List configured servers as a table.",
    "  diag                  Print a diagnostics report (paste into issues).",
    "  help                  Show this help.",
    "  version               Print the CLI version.",
    "",
    "Flags:",
    "  --json                Machine-readable output (connect/sftp: print URL; ls: JSON).",
    "  --filter <substring>  Filter ls output by path or endpoint substring.",
    "  --config <path>       Read from a specific config file.",
    "  --browser             With sftp: open the read-only SFTP Browser preview.",
    "  -h, --help            Show this help.",
    "  -v, --version         Print the CLI version.",
    "",
    "Exit codes:",
    "  0  success",
    "  1  runtime error (missing config, `code` not on PATH, etc.)",
    "  2  usage error (missing <path>, unknown verb, etc.)",
    "",
    "Examples:",
    "  vscrt ls --filter prod",
    "  vscrt connect Prod/Web",
    "  vscrt connect --json Prod/DB/Primary",
    "  vscrt sftp Prod/Web",
    "  vscrt sftp --browser Prod/Web",
    "  vscrt sftp                     # palette-style server picker",
    "  vscrt ls --config /path/to/vscrtConfig.json",
    "  vscrt diag",
  ].join("\n") + "\n";
}
