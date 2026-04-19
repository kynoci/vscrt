/**
 * HostAdapter — the seam that lets the same core ssh/sshpass/sftp
 * logic run inside the VS Code extension *and* under a plain Node
 * CLI (`vscrt-remote`). Everything the core would otherwise need
 * from `vscode.*` (prompts, notifications, terminal, settings,
 * SecretStorage) is funneled through this interface.
 *
 * See docs/PLAN_5_HEADLESS_REMOTE_CORE.md §3 for the full design.
 */

export type HostKeyPolicy = "auto-accept" | "prompt-on-first" | "strict";
export type ConnectionLogMode = "off" | "minimal" | "verbose";
export type SessionRecordingMode = "off" | "minimal" | "full";
export type TerminalLocation = "panel" | "editor";

export interface ConfirmOptions {
  title: string;
  detail: string;
  /** Label on the "trust" / "proceed" button. */
  trustLabel: string;
}

export interface OpenTerminalOptions {
  /** Display name (the extension prefixes this with "vsCRT:"). */
  name: string;
  /** Shell to spawn — e.g. `/bin/bash`, `powershell.exe`. */
  shellPath: string;
  /** Command to send into the shell after it starts. */
  command: string;
  /** Per-node env var overrides merged over the inherited env. */
  env?: Record<string, string>;
  /** Panel vs editor split — only meaningful inside VS Code. */
  location?: TerminalLocation;
}

/**
 * Abstract handle for a live terminal / shell session. Produced by
 * `HostAdapter.openTerminal`. The adapter owns the underlying
 * `vscode.Terminal` (or spawned child process, for the CLI); core
 * code only interacts through this handle.
 */
export interface TerminalHandle {
  /**
   * Register a tempfile or password server that should be cleaned up
   * when the terminal closes. Matches the existing
   * `associateTerminal(...)` semantics in `sshPasswordDelivery.ts`.
   */
  associateResources(res: { file?: string; server?: import("net").Server }): void;

  /** Fire a callback when the terminal / session ends. */
  onClose(cb: () => void): void;

  /** Force-close (caller rarely needs this; closure is user-driven). */
  dispose(): void;
}

export interface HostAdapter {
  // ─── user-facing prompts ────────────────────────────────────────────
  /**
   * Modal yes/no confirmation. VS Code uses showWarningMessage with
   * `modal: true`; the CLI prompts on stderr via readline.
   * Returns true iff the user explicitly confirmed with `trustLabel`.
   */
  confirm(opts: ConfirmOptions): Promise<boolean>;

  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;

  // ─── settings ───────────────────────────────────────────────────────
  getHostKeyPolicy(): HostKeyPolicy;
  getConnectionLogMode(): ConnectionLogMode;
  getSessionRecordingMode(): SessionRecordingMode;

  // ─── secret resolution ──────────────────────────────────────────────
  /**
   * Resolve a stored password into plaintext. Handles all four
   * forms that can appear in `~/.vscrt/vscrtConfig.json`:
   *   - `@secret:<uuid>`       — VS Code SecretStorage (extension only)
   *   - `enc:v3:…` / `enc:v4:…` — Argon2id + AES-GCM (both hosts)
   *   - plaintext              — legacy (both hosts)
   *
   * Returns `undefined` if the field is empty. Throws when resolution
   * fails (e.g. bad passphrase, SecretStorage unavailable under CLI).
   */
  unsealPassword(stored: string | undefined): Promise<string | undefined>;

  // ─── sessions ───────────────────────────────────────────────────────
  openTerminal(opts: OpenTerminalOptions): TerminalHandle;
}
