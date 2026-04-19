import * as assert from "assert";
import { formatError } from "../errorUtils";

describe("formatError", () => {
  it("returns Error.message when an Error is thrown", () => {
    assert.strictEqual(formatError(new Error("boom")), "boom");
  });

  it("coerces strings to themselves", () => {
    assert.strictEqual(formatError("raw string"), "raw string");
  });

  it("coerces numbers to their String() form", () => {
    assert.strictEqual(formatError(42), "42");
  });

  it("coerces objects to a sensible string", () => {
    const obj = { toString() { return "custom obj"; } };
    assert.strictEqual(formatError(obj), "custom obj");
  });

  it("returns a neutral fallback for undefined", () => {
    assert.strictEqual(formatError(undefined), "(unknown error)");
  });

  it("returns a neutral fallback for null", () => {
    assert.strictEqual(formatError(null), "(unknown error)");
  });

  it("returns a neutral fallback for Error with empty message", () => {
    const e = new Error("");
    assert.strictEqual(formatError(e), "Error");
  });

  it("tolerates an Error subclass instance", () => {
    class MyError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "MyError";
      }
    }
    assert.strictEqual(formatError(new MyError("sub-msg")), "sub-msg");
  });

  it("handles objects with a getter `message` that throws", () => {
    const obj = {
      get message() {
        throw new Error("never");
      },
      toString() {
        return "custom";
      },
    };
    // The function isn't a plain Error instance so the `Error.message`
    // branch isn't hit; the String() coercion uses toString().
    assert.strictEqual(formatError(obj), "custom");
  });

  it("handles symbols (String() coerces)", () => {
    const sym = Symbol("mysym");
    const out = formatError(sym);
    assert.ok(out.includes("Symbol"));
  });
});
