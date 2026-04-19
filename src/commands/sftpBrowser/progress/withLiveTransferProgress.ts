/**
 * `withLiveTransferProgress` — wraps an async transfer in a VS Code
 * notification that ticks rate/ETA text every `intervalMs`.
 *
 * The ticker only reports to `progress.report({ message })` — never
 * mutates the title — so it nests cleanly with other progress
 * notifications.
 */
import * as vscode from "vscode";
import { formatTransferProgress } from "./formatters";

export interface LiveProgressOptions {
  title: string;
  totalBytes: number;
  /** Called periodically to probe current bytes transferred. Return a
   *  number (NaN/0 for "unknown"). */
  getBytes: () => Promise<number> | number;
  /** Poll interval in ms. Default 500. */
  intervalMs?: number;
}

export async function withLiveTransferProgress<T>(
  opts: LiveProgressOptions,
  run: () => Promise<T>,
): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `vsCRT: ${opts.title}`,
      cancellable: false,
    },
    async (progress) => {
      const start = Date.now();
      let stopped = false;
      let lastBytes = 0;
      const interval = opts.intervalMs ?? 500;

      const tick = async (): Promise<void> => {
        if (stopped) {
          return;
        }
        try {
          const bytes = await opts.getBytes();
          lastBytes = Number.isFinite(bytes as number)
            ? (bytes as number)
            : lastBytes;
        } catch {
          // Probe failures are expected around transfer start/end.
        }
        const elapsed = (Date.now() - start) / 1000;
        const message = formatTransferProgress(
          lastBytes,
          opts.totalBytes,
          elapsed,
        );
        progress.report({ message });
      };

      // Kick once immediately so the notification shows something
      // before the first tick fires.
      await tick();
      const timer = setInterval(() => {
        void tick();
      }, interval);
      try {
        return await run();
      } finally {
        stopped = true;
        clearInterval(timer);
      }
    },
  );
}
