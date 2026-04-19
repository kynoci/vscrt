import * as assert from "assert";
import { PassphraseCancelled } from "../config/vscrtPassphrase";
import { wrapAsyncHandler } from "../commands/commandUtils";

describe("wrapAsyncHandler", () => {
  it("forwards args and awaits the handler", async () => {
    const calls: unknown[][] = [];
    const wrapped = wrapAsyncHandler("label", async (...args: unknown[]) => {
      calls.push(args);
    });
    await wrapped("a", "b");
    assert.deepStrictEqual(calls, [["a", "b"]]);
  });

  it("swallows PassphraseCancelled silently", async () => {
    const wrapped = wrapAsyncHandler("label", async () => {
      throw new PassphraseCancelled();
    });
    // Should not throw.
    await wrapped();
  });

  it("converts generic errors to a no-throw + side-effect", async () => {
    const wrapped = wrapAsyncHandler("label", async () => {
      throw new Error("generic");
    });
    await wrapped(); // no-throw is the assertion
  });

  it("passes through sync handlers (returns a Promise)", async () => {
    let called = false;
    const wrapped = wrapAsyncHandler("label", () => {
      called = true;
    });
    const out = wrapped();
    assert.ok(out instanceof Promise);
    await out;
    assert.ok(called);
  });

  it("returns a void Promise even for throwing handlers", async () => {
    const wrapped = wrapAsyncHandler("label", async () => {
      throw new Error("boom");
    });
    const ret = await wrapped();
    assert.strictEqual(ret, undefined);
  });

  it("threads through args of different types", async () => {
    const received: unknown[] = [];
    const wrapped = wrapAsyncHandler(
      "label",
      async (a: number, b: string, c: { x: number }) => {
        received.push(a, b, c);
      },
    );
    await wrapped(1, "two", { x: 3 });
    assert.deepStrictEqual(received, [1, "two", { x: 3 }]);
  });
});
