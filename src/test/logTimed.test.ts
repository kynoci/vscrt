import * as assert from "assert";
import { LogSink, log, setLogSink } from "../log";

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      appendLine: (line: string) => lines.push(line),
      show: () => undefined,
    },
  };
}

describe("log.timed", () => {
  afterEach(() => {
    setLogSink(undefined);
  });

  it("returns the wrapped function's result", async () => {
    const { sink } = recordingSink();
    setLogSink(sink);
    const result = await log.timed("fast-work", async () => 42);
    assert.strictEqual(result, 42);
  });

  it("emits an INFO line for fast paths", async () => {
    const { sink, lines } = recordingSink();
    setLogSink(sink);
    await log.timed("fast-work", async () => undefined);
    assert.ok(
      lines.some((l) => /\[INFO\].*fast-work took \d+ms/.test(l)),
      `expected INFO 'took Xms', got:\n${lines.join("\n")}`,
    );
  });

  it("escalates to WARN when the run exceeds slowMs", async () => {
    const { sink, lines } = recordingSink();
    setLogSink(sink);
    await log.timed(
      "slow-work",
      async () => new Promise((r) => setTimeout(r, 40)),
      { slowMs: 10 },
    );
    assert.ok(
      lines.some((l) => /\[WARN\].*slow-work took \d+ms \(slow/.test(l)),
      `expected WARN 'slow' annotation, got:\n${lines.join("\n")}`,
    );
  });

  it("logs ERROR with elapsed time when the work throws, and re-throws", async () => {
    const { sink, lines } = recordingSink();
    setLogSink(sink);
    let caught: unknown;
    try {
      await log.timed("crashy", async () => {
        throw new Error("boom");
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error);
    assert.strictEqual((caught as Error).message, "boom");
    assert.ok(
      lines.some((l) => /\[ERROR\].*crashy failed after \d+ms/.test(l)),
      `expected ERROR 'failed after Xms', got:\n${lines.join("\n")}`,
    );
  });

  it("accepts sync callbacks too", async () => {
    const { sink } = recordingSink();
    setLogSink(sink);
    const result = await log.timed("sync-work", () => "sync-ok");
    assert.strictEqual(result, "sync-ok");
  });
});
