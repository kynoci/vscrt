/**
 * Small helpers shared across command handlers — error classification
 * and re-exporting the shared string formatter so existing imports keep
 * working.
 */

import * as vscode from "vscode";
import { log } from "../log";
import { formatError } from "../errorUtils";
import { PassphraseCancelled } from "../config/vscrtPassphrase";

export { formatError };

export function isUserCancellation(err: unknown): err is PassphraseCancelled {
  return err instanceof PassphraseCancelled;
}

/**
 * Wrap an async command handler so user-cancellations are swallowed
 * silently and unexpected errors show a toast + log entry. Returns a
 * function suitable for passing to `registerCommand`.
 *
 * Example:
 *   vscode.commands.registerCommand(
 *     "vsCRT.foo",
 *     wrapAsyncHandler("foo", async (arg) => { ... }),
 *   );
 */
export function wrapAsyncHandler<A extends unknown[]>(
  label: string,
  fn: (...args: A) => Promise<void> | void,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (isUserCancellation(err)) {
        return;
      }
      log.error(`${label}:`, err);
      vscode.window.showErrorMessage(`vsCRT: ${label} failed — ${formatError(err)}`);
    }
  };
}
