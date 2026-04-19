/**
 * Shared ssh + sftp telemetry — host-agnostic. The two settings reads
 * (`connectionLogging`, `sessionRecording`) go through `HostAdapter`
 * so the CLI can drive the same audit-log + metadata pipeline.
 *
 * Every helper is fire-and-forget from the caller's perspective: a
 * busted audit log must never block a working connection. Errors are
 * swallowed and logged.
 */

import * as os from "os";
import type { CRTConfigNode } from "../../config/vscrtConfigTypes";
import { log } from "../../log";
import {
  ConnectionLogEntry,
  SessionKind,
  SftpAction,
  appendEntry,
  makeEntry,
} from "./connectionLog";
import {
  parseSessionRecordingMode,
  writeSessionMetadata,
} from "./sessionRecorder";
import { HostAdapter } from "../host/hostAdapter";

export async function recordConnectStart(
  node: CRTConfigNode,
  target: string,
  port: number,
  authMode: string,
  host: HostAdapter,
  sessionKind: SessionKind = "ssh",
): Promise<void> {
  const mode = host.getConnectionLogMode();
  if (mode === "off") {
    return;
  }
  const entry = makeEntry(new Date(), node.name, authMode, "started", {
    endpoint: `${target}:${port}`,
    sessionKind,
  });
  try {
    await appendEntry(os.homedir(), entry, mode);
  } catch (err) {
    log.warn("connectionLog append failed:", err);
  }
}

export function buildSftpFileOpEntry(
  now: Date,
  node: CRTConfigNode,
  target: string,
  port: number,
  action: SftpAction,
  succeeded: boolean,
  remotePath?: string,
  errorMessage?: string,
): ConnectionLogEntry {
  return makeEntry(
    now,
    node.name,
    "sftp-browser",
    succeeded ? "connected" : "failed",
    {
      endpoint: `${target}:${port}`,
      sessionKind: "sftp",
      action,
      remotePath,
      errorMessage: succeeded ? undefined : errorMessage,
    },
  );
}

export async function recordSftpFileOp(
  node: CRTConfigNode,
  target: string,
  port: number,
  action: SftpAction,
  succeeded: boolean,
  host: HostAdapter,
  remotePath?: string,
  errorMessage?: string,
): Promise<void> {
  const mode = host.getConnectionLogMode();
  if (mode === "off") {
    return;
  }
  const entry = buildSftpFileOpEntry(
    new Date(),
    node,
    target,
    port,
    action,
    succeeded,
    remotePath,
    errorMessage,
  );
  try {
    await appendEntry(os.homedir(), entry, mode);
  } catch (err) {
    log.warn("connectionLog (sftp op) append failed:", err);
  }
}

export async function recordSessionMetadata(
  node: CRTConfigNode,
  target: string,
  port: number,
  authMode: string,
  host: HostAdapter,
  sessionKind: SessionKind = "ssh",
): Promise<void> {
  const globalMode = host.getSessionRecordingMode();
  const nodeMode = parseSessionRecordingMode(node.recordSession);
  const effective = nodeMode !== "off" ? nodeMode : globalMode;
  if (effective === "off") {
    return;
  }
  try {
    await writeSessionMetadata({
      timestamp: new Date().toISOString(),
      serverName: node.name,
      endpoint: `${target}:${port}`,
      authMode,
      mode: effective,
      pid: process.pid,
      sessionKind,
    });
  } catch (err) {
    log.warn("sessionRecorder: metadata write failed:", err);
  }
}
