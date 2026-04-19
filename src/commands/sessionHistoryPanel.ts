/**
 * vsCRT.showSessionHistory — renders a unified, human-readable view of
 * every recorded session.
 *
 * Previous surface area:
 *   - vsCRT.showSessionRecordings: QuickPick → opens the raw JSON meta.
 *   - vsCRT.showConnectionHistory: opens ~/.vscrt/connections.log (JSONL).
 *
 * Neither is pleasant to scan. This command reads both data sources,
 * merges them (session metadata + the matching connection-log rows),
 * and opens a generated markdown document in an untitled editor tab.
 * VS Code's built-in Markdown preview gives readers a one-keystroke
 * summary with zero webview plumbing.
 *
 * The module is deliberately FS-pure below `renderHistoryMarkdown` so
 * the unit suite can exercise formatting against fixtures.
 */
import * as os from "os";
import * as vscode from "vscode";
import {
  ConnectionLogEntry,
  SessionFile,
  listSessionRecordings,
  readLastN,
} from "../remote";

export interface SessionHistoryRow {
  kind: "meta" | "log";
  timestamp: number;
  serverName: string;
  endpoint?: string;
  authMode?: string;
  sessionKind?: string;
  outcome?: string;
  elapsedMs?: number;
  action?: string;
  errorMessage?: string;
  filePath?: string;
}

/**
 * Turn session metadata files and connection-log entries into a single
 * time-sorted list of rows. Meta rows carry `kind: "meta"` and the path
 * to the .meta.json file; log rows carry `kind: "log"` and no filePath.
 *
 * Exported for the unit suite. Does no IO.
 */
export function buildHistoryRows(
  metas: SessionFile[],
  logs: ConnectionLogEntry[],
): SessionHistoryRow[] {
  const out: SessionHistoryRow[] = [];
  for (const m of metas) {
    // Filename is the only fact on disk; the metadata blob is already
    // readable by the caller but we keep the row shallow here so
    // buildHistoryRows stays sync + pure.
    const match = m.filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-(.+)-(\d+)\.meta\.json$/);
    const serverSlug = match?.[2] ?? "";
    out.push({
      kind: "meta",
      timestamp: Number.isFinite(m.timestamp) ? m.timestamp : 0,
      serverName: serverSlug,
      filePath: m.fullPath,
    });
  }
  for (const e of logs) {
    const ts = Date.parse(e.timestamp);
    out.push({
      kind: "log",
      timestamp: Number.isFinite(ts) ? ts : 0,
      serverName: e.serverName,
      endpoint: e.endpoint,
      authMode: e.authMode,
      sessionKind: e.sessionKind,
      outcome: e.outcome,
      elapsedMs: e.elapsedMs,
      action: e.action,
      errorMessage: e.errorMessage,
    });
  }
  // Newest first. Rows with identical timestamps stay in source order.
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const s = ms / 1000;
  if (s < 60) {
    return `${s.toFixed(1)} s`;
  }
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function formatTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts === 0) {
    return "(unknown)";
  }
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function escapeMdCell(s: string | undefined): string {
  return (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Render a markdown document for the history rows. Pure; safe to unit-test.
 *
 * Layout:
 *   - Header with counts.
 *   - Merged table (timestamp | server | kind | auth | outcome | duration | extra).
 *   - Footer with hints on where the raw data lives.
 */
export function renderHistoryMarkdown(rows: SessionHistoryRow[]): string {
  const header =
    "# vsCRT — Session History\n\n" +
    `Generated: ${new Date().toISOString()}  \n` +
    `Rows: **${rows.length}** ` +
    `(${rows.filter((r) => r.kind === "log").length} log entries, ` +
    `${rows.filter((r) => r.kind === "meta").length} session recordings)\n\n` +
    "> Log entries come from `~/.vscrt/connections.log` (controlled by the " +
    "`vsCRT.connectionLogging` setting). Session recordings come from " +
    "`~/.vscrt/sessions/*.meta.json` (controlled by the " +
    "`vsCRT.sessionRecording` setting). Both sources are local-only.\n\n";

  if (rows.length === 0) {
    return (
      header +
      "_No history available._\n\n" +
      "Enable logging via **File → Preferences → Settings → vsCRT** to start collecting.\n"
    );
  }

  const lines: string[] = [];
  lines.push(header);
  lines.push(
    "| When | Server | Kind | Auth | Outcome | Duration | Notes |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of rows) {
    const notes: string[] = [];
    if (r.action) {
      notes.push(`action: ${r.action}`);
    }
    if (r.endpoint) {
      notes.push(`endpoint: \`${r.endpoint}\``);
    }
    if (r.errorMessage) {
      notes.push(`error: ${r.errorMessage}`);
    }
    if (r.filePath) {
      notes.push(`file: \`${r.filePath}\``);
    }
    const row = [
      formatTimestamp(r.timestamp),
      escapeMdCell(r.serverName),
      escapeMdCell(r.sessionKind ?? (r.kind === "meta" ? "recording" : "ssh")),
      escapeMdCell(r.authMode),
      escapeMdCell(r.outcome),
      formatDuration(r.elapsedMs),
      escapeMdCell(notes.join("; ")),
    ];
    lines.push(`| ${row.join(" | ")} |`);
  }

  return lines.join("\n") + "\n";
}

export function registerSessionHistoryPanel(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.showSessionHistory", async () => {
      const home = os.homedir();
      const [metas, logs] = await Promise.all([
        listSessionRecordings(home),
        readLastN(home, 500),
      ]);
      const rows = buildHistoryRows(metas, logs);
      const md = renderHistoryMarkdown(rows);

      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: md,
      });
      await vscode.window.showTextDocument(doc, { preview: false });
      // Best-effort: open the built-in markdown preview alongside so
      // users see the rendered table by default.
      await vscode.commands
        .executeCommand("markdown.showPreviewToSide")
        .then(undefined, () => undefined);
    }),
  ];
}
