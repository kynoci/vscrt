/**
 * Extension-facing entry points that preserve the pre-refactor
 * signatures (`new CRTSshService(secretService)`, `testConnection(node,
 * secretService, options)`, `resolveHostKeyCheck(node, target, port)`)
 * by owning a `VscodeHostAdapter` under the hood. Everything else —
 * argv construction, password delivery, host-key TOFU — flows through
 * the shared core actions.
 */

import { CRTConfigNode } from "../../config/vscrtConfigTypes";
import { CRTSecretService } from "../../config/vscrtSecret";
import { connect as coreConnect, resolveHostKeyCheck as coreResolveHostKeyCheck } from "../actions/connect";
import {
  TestOptions,
  TestResult,
  testConnection as coreTestConnection,
} from "../actions/test";
import { HostKeyCheckMode } from "../core/helpers";
import { VscodeHostAdapter } from "./vscodeHostAdapter";

export class CRTSshService {
  private readonly host: VscodeHostAdapter;

  constructor(secretService?: CRTSecretService) {
    this.host = new VscodeHostAdapter({ secret: secretService });
  }

  async connectFromConfig(
    node: CRTConfigNode,
    location: "panel" | "editor" = "panel",
  ): Promise<void> {
    await coreConnect(node, this.host, { location });
  }

  /** Called from `extension.deactivate()` to release the terminal-close listener. */
  dispose(): void {
    this.host.dispose();
  }
}

/**
 * Back-compat 3-arg wrapper for callers outside the connect flow
 * (SFTP command, SFTP browser). Uses a short-lived adapter because
 * these callers don't spawn terminals that need the
 * onDidCloseTerminal listener.
 */
export async function resolveHostKeyCheck(
  node: CRTConfigNode,
  target: string,
  port: number,
): Promise<HostKeyCheckMode | null> {
  const host = new VscodeHostAdapter();
  try {
    return await coreResolveHostKeyCheck(node, target, port, host);
  } finally {
    host.dispose();
  }
}

/**
 * Test Connection probe with the legacy `(node, secretService?, opts?)`
 * signature. Every invocation uses a short-lived `VscodeHostAdapter`.
 */
export async function testConnection(
  node: CRTConfigNode,
  secretService?: CRTSecretService,
  options: TestOptions = {},
): Promise<TestResult> {
  const host = new VscodeHostAdapter({ secret: secretService });
  try {
    return await coreTestConnection(node, host, options);
  } finally {
    host.dispose();
  }
}
