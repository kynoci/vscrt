/**
 * Extension-facing wrappers over the telemetry helpers in
 * `../telemetry/sessionTelemetry.ts`. Preserves the pre-refactor
 * parameterless-host signatures by lazily constructing a shared
 * `VscodeHostAdapter` for the two settings reads.
 */

import type { CRTConfigNode } from "../../config/vscrtConfigTypes";
import type { SessionKind, SftpAction } from "../telemetry/connectionLog";
import {
  buildSftpFileOpEntry,
  recordConnectStart as coreRecordConnectStart,
  recordSftpFileOp as coreRecordSftpFileOp,
  recordSessionMetadata as coreRecordSessionMetadata,
} from "../telemetry/sessionTelemetry";
import { VscodeHostAdapter } from "./vscodeHostAdapter";

export { buildSftpFileOpEntry };

let shared: VscodeHostAdapter | undefined;
function getSharedHost(): VscodeHostAdapter {
  if (!shared) {
    shared = new VscodeHostAdapter();
  }
  return shared;
}

export async function recordConnectStart(
  node: CRTConfigNode,
  target: string,
  port: number,
  authMode: string,
  sessionKind: SessionKind = "ssh",
): Promise<void> {
  return coreRecordConnectStart(
    node,
    target,
    port,
    authMode,
    getSharedHost(),
    sessionKind,
  );
}

export async function recordSftpFileOp(
  node: CRTConfigNode,
  target: string,
  port: number,
  action: SftpAction,
  succeeded: boolean,
  remotePath?: string,
  errorMessage?: string,
): Promise<void> {
  return coreRecordSftpFileOp(
    node,
    target,
    port,
    action,
    succeeded,
    getSharedHost(),
    remotePath,
    errorMessage,
  );
}

export async function recordSessionMetadata(
  node: CRTConfigNode,
  target: string,
  port: number,
  authMode: string,
  sessionKind: SessionKind = "ssh",
): Promise<void> {
  return coreRecordSessionMetadata(
    node,
    target,
    port,
    authMode,
    getSharedHost(),
    sessionKind,
  );
}
