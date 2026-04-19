/**
 * Unit tests for the `ChildTracker` helper used by the SFTP browser's
 * Cancel button. We don't spawn real processes — we build a minimal
 * mock that records `kill(signal)` calls — which is enough to pin the
 * contract the real runners depend on.
 */

import * as assert from "assert";
import { ChildTracker } from "../remote";

// Minimal mock that satisfies the `{ kill(signal) }` contract we use.
function mockChild(): { kill: (sig?: string) => void; killedWith: string[] } {
  const killedWith: string[] = [];
  return {
    kill: (sig?: string) => {
      killedWith.push(sig ?? "DEFAULT");
    },
    killedWith,
  };
}

describe("ChildTracker", () => {
  it("starts empty", () => {
    const t = new ChildTracker();
    assert.strictEqual(t.size, 0);
  });

  it("track() increments size; untrack() decrements", () => {
    const t = new ChildTracker();
    const c = mockChild();
    const untrack = t.track(c as unknown as Parameters<typeof t.track>[0]);
    assert.strictEqual(t.size, 1);
    untrack();
    assert.strictEqual(t.size, 0);
  });

  it("cancelAll() kills each registered child with SIGTERM", () => {
    const t = new ChildTracker();
    const a = mockChild();
    const b = mockChild();
    t.track(a as unknown as Parameters<typeof t.track>[0]);
    t.track(b as unknown as Parameters<typeof t.track>[0]);
    const n = t.cancelAll();
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(a.killedWith, ["SIGTERM"]);
    assert.deepStrictEqual(b.killedWith, ["SIGTERM"]);
  });

  it("cancelAll() clears the set so subsequent cancels are no-ops", () => {
    const t = new ChildTracker();
    const c = mockChild();
    t.track(c as unknown as Parameters<typeof t.track>[0]);
    assert.strictEqual(t.cancelAll(), 1);
    assert.strictEqual(t.size, 0);
    assert.strictEqual(t.cancelAll(), 0);
  });

  it("cancelAll() swallows kill() errors and still clears", () => {
    const t = new ChildTracker();
    const bad = {
      kill: () => {
        throw new Error("already gone");
      },
    };
    const good = mockChild();
    t.track(bad as unknown as Parameters<typeof t.track>[0]);
    t.track(good as unknown as Parameters<typeof t.track>[0]);
    // Doesn't throw even though one child's kill() throws.
    const n = t.cancelAll();
    // `good` still got signalled; `bad`'s throw didn't prevent the count.
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(good.killedWith, ["SIGTERM"]);
  });

  it("untrack() removes only the specific child, leaving others tracked", () => {
    const t = new ChildTracker();
    const a = mockChild();
    const b = mockChild();
    const untrackA = t.track(a as unknown as Parameters<typeof t.track>[0]);
    t.track(b as unknown as Parameters<typeof t.track>[0]);
    untrackA();
    assert.strictEqual(t.size, 1);
    t.cancelAll();
    assert.deepStrictEqual(a.killedWith, []);
    assert.deepStrictEqual(b.killedWith, ["SIGTERM"]);
  });
});
