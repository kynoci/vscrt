import * as assert from "assert";
import {
  badgeFor,
  buildLastStatusMap,
  humaniseAgo,
} from "../treeView/connectionStatus";
import { ConnectionLogEntry } from "../remote";

const FIXED_NOW = Date.parse("2026-04-17T12:00:00Z");

describe("humaniseAgo", () => {
  it("formats seconds / minutes / hours / days", () => {
    assert.strictEqual(humaniseAgo(FIXED_NOW - 10_000, FIXED_NOW), "10s ago");
    assert.strictEqual(humaniseAgo(FIXED_NOW - 120_000, FIXED_NOW), "2m ago");
    assert.strictEqual(
      humaniseAgo(FIXED_NOW - 7 * 3_600_000, FIXED_NOW),
      "7h ago",
    );
    assert.strictEqual(
      humaniseAgo(FIXED_NOW - 2 * 86_400_000, FIXED_NOW),
      "2d ago",
    );
  });

  it("clamps to 0 for future timestamps", () => {
    assert.strictEqual(humaniseAgo(FIXED_NOW + 60_000, FIXED_NOW), "0s ago");
  });
});

describe("buildLastStatusMap", () => {
  it("keeps the latest entry per server", () => {
    const entries: ConnectionLogEntry[] = [
      {
        timestamp: "2026-04-17T10:00:00Z",
        serverName: "alpha",
        authMode: "publickey",
        outcome: "failed",
      },
      {
        timestamp: "2026-04-17T11:30:00Z",
        serverName: "alpha",
        authMode: "publickey",
        outcome: "connected",
      },
      {
        timestamp: "2026-04-17T11:00:00Z",
        serverName: "beta",
        authMode: "publickey",
        outcome: "connected",
      },
    ];
    const map = buildLastStatusMap(entries);
    assert.strictEqual(map.get("alpha")?.outcome, "connected");
    assert.strictEqual(map.get("beta")?.outcome, "connected");
    assert.strictEqual(map.size, 2);
  });

  it("ignores entries with unparseable timestamps", () => {
    const entries: ConnectionLogEntry[] = [
      {
        timestamp: "not-a-date",
        serverName: "x",
        authMode: "publickey",
        outcome: "connected",
      },
    ];
    assert.strictEqual(buildLastStatusMap(entries).size, 0);
  });
});

describe("badgeFor", () => {
  it("returns null when there is no status", () => {
    assert.strictEqual(badgeFor(undefined), null);
  });

  it("returns success for a recent connect (≤1h)", () => {
    const badge = badgeFor(
      { outcome: "connected", at: FIXED_NOW - 120_000 },
      FIXED_NOW,
    );
    assert.ok(badge);
    assert.strictEqual(badge.kind, "success");
    assert.match(badge.text, /^✓ /);
  });

  it("returns muted for an older success (>1h)", () => {
    const badge = badgeFor(
      { outcome: "connected", at: FIXED_NOW - 5 * 3_600_000 },
      FIXED_NOW,
    );
    assert.ok(badge);
    assert.strictEqual(badge.kind, "muted");
  });

  it("returns error for a recent failure", () => {
    const badge = badgeFor(
      { outcome: "failed", at: FIXED_NOW - 300_000, errorMessage: "denied" },
      FIXED_NOW,
    );
    assert.ok(badge);
    assert.strictEqual(badge.kind, "error");
    assert.ok(badge.tooltip.includes("denied"));
  });

  it("returns muted for cancelled", () => {
    const badge = badgeFor(
      { outcome: "cancelled", at: FIXED_NOW - 30_000 },
      FIXED_NOW,
    );
    assert.ok(badge);
    assert.strictEqual(badge.kind, "muted");
  });

  it("handles dangling 'started' entries with an ellipsis marker", () => {
    const badge = badgeFor(
      { outcome: "started", at: FIXED_NOW - 30_000 },
      FIXED_NOW,
    );
    assert.ok(badge);
    assert.match(badge.text, /^…/);
  });
});
