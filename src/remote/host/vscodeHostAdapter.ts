/**
 * VS Code implementation of HostAdapter. Delegates every
 * user-facing concern back to `vscode.*` so the core module
 * stays free of VS Code imports.
 *
 * This file is the ONLY place inside `src/remote/` that is
 * allowed to import `vscode`.
 *
 * Every call site inside `src/remote/` talks to a `HostAdapter`;
 * this class is the concrete implementation the extension wires in
 * at activation time. The CLI uses `NodeHostAdapter` instead.
 */

import * as fs from "fs";
import * as net from "net";
import * as vscode from "vscode";
import { CRTSecretService } from "../../config/vscrtSecret";
import { log } from "../../log";
import {
  untrackFile,
  untrackServer,
} from "../core/passwordDelivery";
import {
  ConfirmOptions,
  ConnectionLogMode,
  HostAdapter,
  HostKeyPolicy,
  OpenTerminalOptions,
  SessionRecordingMode,
  TerminalHandle,
} from "./hostAdapter";

function parseHostKeyPolicy(raw: string | undefined): HostKeyPolicy {
  if (raw === "strict" || raw === "prompt-on-first") {
    return raw;
  }
  return "auto-accept";
}

function parseConnectionLogMode(raw: string | undefined): ConnectionLogMode {
  if (raw === "minimal" || raw === "verbose") {
    return raw;
  }
  return "off";
}

function parseSessionRecordingMode(raw: string | undefined): SessionRecordingMode {
  if (raw === "minimal" || raw === "full") {
    return raw;
  }
  return "off";
}

class VscodeTerminalHandle implements TerminalHandle {
  private readonly closeCallbacks: Array<() => void> = [];
  private readonly files: string[] = [];
  private readonly servers: net.Server[] = [];
  private disposed = false;

  constructor(private readonly terminal: vscode.Terminal) {}

  associateResources(res: { file?: string; server?: net.Server }): void {
    if (res.file) {
      this.files.push(res.file);
    }
    if (res.server) {
      this.servers.push(res.server);
    }
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.terminal.dispose();
    } catch {
      /* ignore */
    }
  }

  /**
   * Invoked by the adapter when vscode reports this terminal closed.
   * Cleans up associated tempfiles and servers before firing the
   * registered onClose callbacks.
   */
  _fireClose(): void {
    for (const f of this.files.splice(0)) {
      fs.promises.unlink(f).catch((err: unknown) => {
        log.debug(`cleanup: failed to unlink ${f}: ${err}`);
      });
      untrackFile(f);
    }
    for (const s of this.servers.splice(0)) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
      untrackServer(s);
    }
    for (const cb of this.closeCallbacks.splice(0)) {
      try {
        cb();
      } catch {
        /* swallow — cleanup must not throw */
      }
    }
  }

}

export interface VscodeHostAdapterDeps {
  secret?: CRTSecretService;
}

export class VscodeHostAdapter implements HostAdapter {
  private readonly liveHandles = new Map<vscode.Terminal, VscodeTerminalHandle>();
  private readonly onCloseSub: vscode.Disposable;

  constructor(private readonly deps: VscodeHostAdapterDeps = {}) {
    this.onCloseSub = vscode.window.onDidCloseTerminal((t) => {
      const handle = this.liveHandles.get(t);
      if (!handle) {
        return;
      }
      this.liveHandles.delete(t);
      handle._fireClose();
    });
  }

  dispose(): void {
    this.onCloseSub.dispose();
    for (const h of this.liveHandles.values()) {
      h.dispose();
    }
    this.liveHandles.clear();
  }

  async confirm(opts: ConfirmOptions): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(
      opts.title,
      { modal: true, detail: opts.detail },
      opts.trustLabel,
    );
    return pick === opts.trustLabel;
  }

  error(msg: string): void {
    vscode.window.showErrorMessage(msg);
  }

  warn(msg: string): void {
    vscode.window.showWarningMessage(msg);
  }

  info(msg: string): void {
    vscode.window.showInformationMessage(msg);
  }

  getHostKeyPolicy(): HostKeyPolicy {
    return parseHostKeyPolicy(
      vscode.workspace.getConfiguration("vsCRT").get<string>("hostKeyPolicy"),
    );
  }

  getConnectionLogMode(): ConnectionLogMode {
    return parseConnectionLogMode(
      vscode.workspace.getConfiguration("vsCRT").get<string>("connectionLogging"),
    );
  }

  getSessionRecordingMode(): SessionRecordingMode {
    return parseSessionRecordingMode(
      vscode.workspace.getConfiguration("vsCRT").get<string>("sessionRecording"),
    );
  }

  async unsealPassword(stored: string | undefined): Promise<string | undefined> {
    if (!stored) {
      return undefined;
    }
    if (!this.deps.secret) {
      return stored;
    }
    return this.deps.secret.unseal(stored);
  }

  openTerminal(opts: OpenTerminalOptions): TerminalHandle {
    const terminal = vscode.window.createTerminal({
      name: `vsCRT: ${opts.name}`,
      shellPath: opts.shellPath,
      env: opts.env,
      location:
        opts.location === "editor"
          ? vscode.TerminalLocation.Editor
          : vscode.TerminalLocation.Panel,
    });
    terminal.show(true);
    terminal.sendText(opts.command, true);
    const handle = new VscodeTerminalHandle(terminal);
    this.liveHandles.set(terminal, handle);
    return handle;
  }
}
