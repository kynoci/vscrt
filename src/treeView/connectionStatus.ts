/**
 * Derive per-node "last connection" state from the connection audit
 * log. Pure: callers pass in an array of parsed log entries, we return
 * a `Map<nodeName, LastStatus>` ready for the webview renderer to
 * attach badges.
 *
 * The log uses server NAME as the key (not path) because paths can
 * change when a user renames a folder, while names are stable per-node.
 * Collisions between same-named nodes in different folders are
 * acceptable here — the badge shows the most recent result.
 */

import { ConnectionLogEntry } from "../remote";

export interface LastStatus {
  outcome: "started" | "connected" | "failed" | "cancelled";
  /** ms epoch from the log entry's ISO timestamp. */
  at: number;
  /** Optional error message (verbose-mode log only). */
  errorMessage?: string;
}

export interface BadgeDescriptor {
  text: string;
  kind: "success" | "error" | "muted";
  tooltip: string;
}

export function buildLastStatusMap(
  entries: readonly ConnectionLogEntry[],
): Map<string, LastStatus> {
  const out = new Map<string, LastStatus>();
  for (const entry of entries) {
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at)) {
      continue;
    }
    const prior = out.get(entry.serverName);
    if (!prior || at > prior.at) {
      out.set(entry.serverName, {
        outcome: entry.outcome,
        at,
        errorMessage: entry.errorMessage,
      });
    }
  }
  return out;
}

/** Human-friendly "N units ago" string for a ms-epoch timestamp. */
export function humaniseAgo(ms: number, now: number = Date.now()): string {
  const diffS = Math.max(0, Math.floor((now - ms) / 1000));
  if (diffS < 60) {return `${diffS}s ago`;}
  if (diffS < 3600) {return `${Math.floor(diffS / 60)}m ago`;}
  if (diffS < 86400) {return `${Math.floor(diffS / 3600)}h ago`;}
  return `${Math.floor(diffS / 86400)}d ago`;
}

/**
 * Turn a LastStatus into a renderable badge. Pure: the webview
 * translates `kind` into a CSS class and `text` into the DOM.
 * Returns `null` when we don't want to show any badge for this node
 * (e.g. nothing was ever logged, or the only entry is a bare
 * "started" with no outcome).
 */
export function badgeFor(
  status: LastStatus | undefined,
  now: number = Date.now(),
): BadgeDescriptor | null {
  if (!status) {
    return null;
  }
  const ago = humaniseAgo(status.at, now);
  const ageMs = now - status.at;
  const RECENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  if (status.outcome === "connected") {
    return {
      text: `✓ ${ago}`,
      kind: ageMs < RECENT_WINDOW_MS ? "success" : "muted",
      tooltip: `Last successful connection: ${new Date(status.at).toISOString()}`,
    };
  }
  if (status.outcome === "failed") {
    return {
      text: `✗ ${ago}`,
      kind: "error",
      tooltip:
        `Last attempt failed: ${new Date(status.at).toISOString()}` +
        (status.errorMessage ? `\n${status.errorMessage}` : ""),
    };
  }
  if (status.outcome === "cancelled") {
    return {
      text: `— ${ago}`,
      kind: "muted",
      tooltip: `Last attempt cancelled: ${new Date(status.at).toISOString()}`,
    };
  }
  // "started" with no follow-up log entry: usually means the extension
  // quit or crashed before logging the outcome. Show an "in progress"
  // hint without a harsh red/green.
  return {
    text: `… ${ago}`,
    kind: "muted",
    tooltip: `Last attempt started: ${new Date(status.at).toISOString()} (no outcome recorded)`,
  };
}
