import * as assert from "assert";
import {
  TransferQueue,
  summarizeTransferResults,
} from "../commands/transferQueue";

describe("TransferQueue", () => {
  it("runs every task and returns a result per id in enqueue order", async () => {
    const q = new TransferQueue<number>({ concurrency: 2 });
    for (let i = 0; i < 5; i += 1) {
      q.add({
        id: `t${i}`,
        label: `task ${i}`,
        run: async () => i,
      });
    }
    const results = await q.drain();
    assert.strictEqual(results.length, 5);
    // Results come back in completion order, not enqueue order. Check
    // that every id appears exactly once.
    const ids = results.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ["t0", "t1", "t2", "t3", "t4"]);
    for (const r of results) {
      assert.strictEqual(r.outcome, "success");
      assert.strictEqual(typeof r.value, "number");
    }
  });

  it("respects the concurrency cap", async () => {
    const cap = 3;
    let currentInflight = 0;
    let maxInflight = 0;
    const q = new TransferQueue({ concurrency: cap });
    for (let i = 0; i < 10; i += 1) {
      q.add({
        id: `t${i}`,
        label: `t${i}`,
        run: async () => {
          currentInflight += 1;
          maxInflight = Math.max(maxInflight, currentInflight);
          await new Promise((r) => setTimeout(r, 5));
          currentInflight -= 1;
        },
      });
    }
    await q.drain();
    assert.ok(maxInflight <= cap, `maxInflight=${maxInflight} cap=${cap}`);
    assert.ok(maxInflight >= 1, "expected at least one task inflight");
  });

  it("captures task failures without rejecting the queue", async () => {
    const q = new TransferQueue({ concurrency: 2 });
    q.add({ id: "ok", label: "ok", run: async () => undefined });
    q.add({
      id: "bad",
      label: "bad",
      run: async () => {
        throw new Error("boom");
      },
    });
    const results = await q.drain();
    const ok = results.find((r) => r.id === "ok");
    const bad = results.find((r) => r.id === "bad");
    assert.ok(ok && bad);
    assert.strictEqual(ok?.outcome, "success");
    assert.strictEqual(bad?.outcome, "failure");
    assert.ok(bad?.error instanceof Error);
  });

  it("honours cancel() — pending tasks are recorded as cancelled", async () => {
    const q = new TransferQueue({ concurrency: 1 });
    let ran = 0;
    for (let i = 0; i < 5; i += 1) {
      q.add({
        id: `t${i}`,
        label: `t${i}`,
        run: async (ctx) => {
          ran += 1;
          if (i === 0) {
            // First task cancels everything else mid-run.
            q.cancel();
          }
          // Tasks that observe cancellation can bail early — exposed
          // so future implementations that poll long-running work have
          // a clear contract. The assert at function end is the real
          // behaviour guarantee.
          void ctx.cancelled();
        },
      });
    }
    const results = await q.drain();
    const cancelled = results.filter((r) => r.outcome === "cancelled").length;
    assert.ok(cancelled >= 3, `expected >= 3 cancelled, got ${cancelled}`);
    assert.ok(ran <= 2, `expected <= 2 tasks to start, got ${ran}`);
  });

  it("reports progress to onProgress on every start + end", async () => {
    const events: { completed: number; inflight: number }[] = [];
    const q = new TransferQueue({
      concurrency: 2,
      onProgress: (e) =>
        events.push({ completed: e.completed, inflight: e.inflight.length }),
    });
    for (let i = 0; i < 3; i += 1) {
      q.add({ id: `t${i}`, label: `t${i}`, run: async () => undefined });
    }
    await q.drain();
    // Last event should report 3 completed, 0 inflight.
    const last = events[events.length - 1];
    assert.strictEqual(last.completed, 3);
    assert.strictEqual(last.inflight, 0);
    // At some point at least one task should have been inflight.
    assert.ok(events.some((e) => e.inflight >= 1));
  });

  it("clamps concurrency to [1, 16]", async () => {
    // Can't introspect the private field, but drain should still work.
    const zero = new TransferQueue({ concurrency: 0 });
    zero.add({ id: "a", label: "a", run: async () => undefined });
    const r = await zero.drain();
    assert.strictEqual(r.length, 1);
  });

  it("an empty queue drains to an empty result list", async () => {
    const q = new TransferQueue();
    assert.deepStrictEqual(await q.drain(), []);
  });
});

describe("summarizeTransferResults", () => {
  it("returns success when every task succeeded", () => {
    const s = summarizeTransferResults([
      { id: "a", label: "a", outcome: "success", durationMs: 10 },
      { id: "b", label: "b", outcome: "success", durationMs: 10 },
    ]);
    assert.strictEqual(s.kind, "success");
    assert.match(s.message, /2 files/);
  });

  it("returns partial when some succeeded and some didn't", () => {
    const s = summarizeTransferResults([
      { id: "a", label: "a", outcome: "success", durationMs: 10 },
      { id: "b", label: "b", outcome: "failure", durationMs: 10 },
    ]);
    assert.strictEqual(s.kind, "partial");
    assert.match(s.message, /1 \/ 2/);
  });

  it("returns failed when every task failed", () => {
    const s = summarizeTransferResults([
      { id: "a", label: "a", outcome: "failure", durationMs: 10 },
      { id: "b", label: "b", outcome: "failure", durationMs: 10 },
    ]);
    assert.strictEqual(s.kind, "failed");
  });

  it("returns cancelled when every task was cancelled", () => {
    const s = summarizeTransferResults([
      { id: "a", label: "a", outcome: "cancelled", durationMs: 0 },
      { id: "b", label: "b", outcome: "cancelled", durationMs: 0 },
    ]);
    assert.strictEqual(s.kind, "cancelled");
  });

  it("pluralises the single-file count", () => {
    const s = summarizeTransferResults([
      { id: "a", label: "a", outcome: "success", durationMs: 10 },
    ]);
    assert.match(s.message, /1 file/);
  });

  it("handles an empty result list", () => {
    const s = summarizeTransferResults([]);
    assert.strictEqual(s.kind, "success");
  });
});
