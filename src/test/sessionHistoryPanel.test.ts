import * as assert from "assert";
import {
  SessionHistoryRow,
  buildHistoryRows,
  renderHistoryMarkdown,
} from "../commands/sessionHistoryPanel";
import { ConnectionLogEntry, SessionFile } from "../remote";

describe("sessionHistoryPanel", () => {
  describe("buildHistoryRows", () => {
    it("produces no rows for empty inputs", () => {
      assert.deepStrictEqual(buildHistoryRows([], []), []);
    });

    it("tags meta files with kind=meta and log entries with kind=log", () => {
      const metas: SessionFile[] = [
        {
          filename: "2026-04-17T12-00-00Z-prod-web-1234.meta.json",
          fullPath: "/tmp/sessions/x.meta.json",
          timestamp: Date.parse("2026-04-17T12:00:00Z"),
        },
      ];
      const logs: ConnectionLogEntry[] = [
        {
          timestamp: "2026-04-17T12:05:00Z",
          serverName: "prod-web",
          authMode: "publickey",
          outcome: "connected",
        },
      ];
      const rows = buildHistoryRows(metas, logs);
      const kinds = rows.map((r) => r.kind);
      assert.deepStrictEqual(kinds.sort(), ["log", "meta"]);
    });

    it("sorts newest first", () => {
      const logs: ConnectionLogEntry[] = [
        {
          timestamp: "2026-04-01T00:00:00Z",
          serverName: "old",
          authMode: "publickey",
          outcome: "connected",
        },
        {
          timestamp: "2026-04-17T00:00:00Z",
          serverName: "new",
          authMode: "publickey",
          outcome: "connected",
        },
      ];
      const rows = buildHistoryRows([], logs);
      assert.deepStrictEqual(
        rows.map((r) => r.serverName),
        ["new", "old"],
      );
    });

    it("extracts server slug from the meta filename", () => {
      const metas: SessionFile[] = [
        {
          filename: "2026-04-17T12-00-00Z-prod-db-42.meta.json",
          fullPath: "/tmp/x",
          timestamp: Date.parse("2026-04-17T12:00:00Z"),
        },
      ];
      const rows = buildHistoryRows(metas, []);
      assert.strictEqual(rows[0].serverName, "prod-db");
      assert.strictEqual(rows[0].filePath, "/tmp/x");
    });

    it("tolerates malformed timestamps (NaN) by treating them as 0", () => {
      const metas: SessionFile[] = [
        {
          filename: "garbled",
          fullPath: "/tmp/g",
          timestamp: NaN,
        },
      ];
      const rows = buildHistoryRows(metas, []);
      assert.strictEqual(rows[0].timestamp, 0);
    });

    it("copies action / endpoint / errorMessage from log rows", () => {
      const logs: ConnectionLogEntry[] = [
        {
          timestamp: "2026-04-17T12:00:00Z",
          serverName: "x",
          authMode: "publickey",
          outcome: "failed",
          endpoint: "user@host",
          errorMessage: "connection refused",
          sessionKind: "sftp",
          action: "upload",
        },
      ];
      const rows = buildHistoryRows([], logs);
      assert.strictEqual(rows[0].endpoint, "user@host");
      assert.strictEqual(rows[0].errorMessage, "connection refused");
      assert.strictEqual(rows[0].sessionKind, "sftp");
      assert.strictEqual(rows[0].action, "upload");
    });
  });

  describe("renderHistoryMarkdown", () => {
    it("returns an empty-state message when there are no rows", () => {
      const md = renderHistoryMarkdown([]);
      assert.match(md, /Session History/);
      assert.match(md, /No history available/);
    });

    it("includes a markdown table header + one row per entry", () => {
      const rows: SessionHistoryRow[] = [
        {
          kind: "log",
          timestamp: Date.parse("2026-04-17T12:00:00Z"),
          serverName: "web-1",
          authMode: "publickey",
          outcome: "connected",
          elapsedMs: 1500,
        },
        {
          kind: "meta",
          timestamp: Date.parse("2026-04-17T11:00:00Z"),
          serverName: "db-1",
          filePath: "/tmp/sessions/x.meta.json",
        },
      ];
      const md = renderHistoryMarkdown(rows);
      assert.match(md, /\| When \|/);
      assert.match(md, /web-1/);
      assert.match(md, /db-1/);
      // Header row + separator + 2 data rows.
      const tableLines = md.split("\n").filter((l) => l.startsWith("| "));
      assert.ok(tableLines.length >= 4);
    });

    it("renders duration as ms / seconds / minutes by range", () => {
      const base: SessionHistoryRow = {
        kind: "log",
        timestamp: 1,
        serverName: "s",
      };
      const ms = renderHistoryMarkdown([{ ...base, elapsedMs: 500 }]);
      assert.match(ms, /500 ms/);
      const secs = renderHistoryMarkdown([{ ...base, elapsedMs: 5000 }]);
      assert.match(secs, /5\.0 s/);
      const mins = renderHistoryMarkdown([{ ...base, elapsedMs: 125_000 }]);
      assert.match(mins, /2m 5s/);
    });

    it("escapes pipes in cell values so they don't break the table", () => {
      const md = renderHistoryMarkdown([
        {
          kind: "log",
          timestamp: 1,
          serverName: "has|pipe",
          errorMessage: "a | b",
        },
      ]);
      assert.match(md, /has\\\|pipe/);
      assert.match(md, /a \\\| b/);
    });

    it("shows '—' for missing durations", () => {
      const md = renderHistoryMarkdown([
        { kind: "log", timestamp: 1, serverName: "s" },
      ]);
      assert.match(md, /—/);
    });

    it("defaults missing sessionKind to 'ssh' for log rows, 'recording' for meta", () => {
      const md = renderHistoryMarkdown([
        { kind: "log", timestamp: 1, serverName: "a" },
        { kind: "meta", timestamp: 1, serverName: "b" },
      ]);
      assert.match(md, /\| ssh \|/);
      assert.match(md, /\| recording \|/);
    });
  });
});
