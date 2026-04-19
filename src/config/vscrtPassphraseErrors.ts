/**
 * Standalone exception types used by the passphrase service.
 *
 * Split out of `vscrtPassphrase.ts` because that module imports
 * `vscode` at its top and is therefore unrunnable under plain Node
 * (the `vscrt-remote` CLI). This file has no VS Code imports, so
 * `PassphraseCancelled` can be checked via `instanceof` from CLI
 * and extension code alike.
 */

export class PassphraseCancelled extends Error {
  constructor() {
    super("vsCRT: passphrase entry cancelled.");
    this.name = "PassphraseCancelled";
  }
}
