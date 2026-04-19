/**
 * Concurrency-limited transfer queue (E5).
 *
 * Bulk SFTP uploads / downloads used to run as one sequential
 * `sftp -b` batch; a 20-file set blocked on each preceding file. This
 * queue splits a batch into per-file `TransferTask` objects and runs up
 * to `concurrency` of them at a time.
 *
 * Pure, testable — no VS Code / fs / ssh imports. The caller wires task
 * bodies to whatever transport they need (sftp, scp, http, whatever).
 */

export interface TransferTask<T = void> {
  /** Stable id for progress reporting and cancellation. */
  id: string;
  /** Human-readable label — shown in per-task progress lines. */
  label: string;
  /** Actual work. Rejecting is treated as task failure, not queue failure. */
  run: (ctx: TaskContext) => Promise<T>;
}

export interface TaskContext {
  /** Signal that fires when the whole queue (or this task) is cancelled. */
  cancelled: () => boolean;
}

export interface TaskResult<T = void> {
  id: string;
  label: string;
  outcome: "success" | "failure" | "cancelled";
  value?: T;
  error?: unknown;
  durationMs: number;
}

export interface QueueProgressEvent {
  total: number;
  completed: number;
  inflight: string[];
}

export interface QueueOptions {
  /** Max simultaneous tasks. Clamped to [1, 16]. Default 3. */
  concurrency?: number;
  /** Called on every task start + end. */
  onProgress?: (e: QueueProgressEvent) => void;
}

export class TransferQueue<T = void> {
  private readonly tasks: TransferTask<T>[] = [];
  private readonly results: TaskResult<T>[] = [];
  private readonly inflight = new Set<string>();
  private cancelRequested = false;
  private readonly concurrency: number;
  private readonly onProgress?: (e: QueueProgressEvent) => void;

  constructor(opts: QueueOptions = {}) {
    const raw = opts.concurrency ?? 3;
    this.concurrency = Math.max(1, Math.min(16, raw));
    this.onProgress = opts.onProgress;
  }

  add(task: TransferTask<T>): void {
    this.tasks.push(task);
  }

  get size(): number {
    return this.tasks.length;
  }

  /** Cancel every pending task and ask inflight ones to bail. */
  cancel(): void {
    this.cancelRequested = true;
  }

  /**
   * Run every task to completion, respecting the concurrency cap.
   * Resolves with the full result list; never rejects — each task's
   * failure is captured as a `TaskResult` with outcome `"failure"`.
   */
  async drain(): Promise<TaskResult<T>[]> {
    if (this.tasks.length === 0) {
      return [];
    }
    const queue = [...this.tasks];
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(this.concurrency, queue.length);

    const emit = (): void => {
      if (!this.onProgress) {return;}
      this.onProgress({
        total: this.tasks.length,
        completed: this.results.length,
        inflight: [...this.inflight],
      });
    };

    const runOne = async (task: TransferTask<T>): Promise<void> => {
      const start = Date.now();
      this.inflight.add(task.id);
      emit();
      if (this.cancelRequested) {
        this.results.push({
          id: task.id,
          label: task.label,
          outcome: "cancelled",
          durationMs: Date.now() - start,
        });
        this.inflight.delete(task.id);
        emit();
        return;
      }
      try {
        const value = await task.run({
          cancelled: () => this.cancelRequested,
        });
        this.results.push({
          id: task.id,
          label: task.label,
          outcome: this.cancelRequested ? "cancelled" : "success",
          value,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        this.results.push({
          id: task.id,
          label: task.label,
          outcome: this.cancelRequested ? "cancelled" : "failure",
          error: err,
          durationMs: Date.now() - start,
        });
      } finally {
        this.inflight.delete(task.id);
        emit();
      }
    };

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (this.cancelRequested) {
          // Drain pending as cancelled so the results array is complete.
          while (queue.length > 0) {
            const t = queue.shift();
            if (!t) {break;}
            this.results.push({
              id: t.id,
              label: t.label,
              outcome: "cancelled",
              durationMs: 0,
            });
          }
          emit();
          return;
        }
        const t = queue.shift();
        if (!t) {return;}
        await runOne(t);
      }
    };

    for (let i = 0; i < workerCount; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return this.results;
  }
}

/**
 * Aggregate a list of task results into a one-line summary. Pure.
 * Used by the bulk upload / download handlers to decide whether to
 * show a success toast, an error toast, or a partial one.
 */
export function summarizeTransferResults(
  results: TaskResult<unknown>[],
): { kind: "success" | "partial" | "failed" | "cancelled"; message: string } {
  if (results.length === 0) {
    return { kind: "success", message: "" };
  }
  const ok = results.filter((r) => r.outcome === "success").length;
  const cancelled = results.filter((r) => r.outcome === "cancelled").length;
  const failed = results.filter((r) => r.outcome === "failure").length;
  if (cancelled === results.length) {
    return { kind: "cancelled", message: "Cancelled." };
  }
  if (failed === 0 && cancelled === 0) {
    return {
      kind: "success",
      message: `Transferred ${ok} ${ok === 1 ? "file" : "files"}.`,
    };
  }
  if (ok === 0) {
    return {
      kind: "failed",
      message: `Failed ${failed} / ${results.length} (${cancelled} cancelled).`,
    };
  }
  return {
    kind: "partial",
    message: `Transferred ${ok} / ${results.length}; ${failed} failed, ${cancelled} cancelled.`,
  };
}
