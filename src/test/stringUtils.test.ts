import * as assert from "assert";
import { isNonEmpty, pluralize, truncate } from "../stringUtils";

describe("isNonEmpty", () => {
  it("returns true for non-empty strings", () => {
    assert.strictEqual(isNonEmpty("a"), true);
    assert.strictEqual(isNonEmpty("  a  "), true);
  });

  it("returns false for empty/whitespace/undefined/null", () => {
    assert.strictEqual(isNonEmpty(""), false);
    assert.strictEqual(isNonEmpty("   "), false);
    assert.strictEqual(isNonEmpty(undefined), false);
    assert.strictEqual(isNonEmpty(null), false);
  });

  it("narrows the type (compile-time check)", () => {
    // This test's real purpose is the type-check — if isNonEmpty didn't
    // narrow, `x.length` wouldn't be allowed below without an extra guard.
    const x: string | undefined = "abc" as string | undefined;
    if (isNonEmpty(x)) {
      assert.strictEqual(x.length, 3);
    }
  });
});

describe("truncate", () => {
  it("returns input unchanged when under max", () => {
    assert.strictEqual(truncate("hello", 10), "hello");
  });

  it("returns input unchanged when at max", () => {
    assert.strictEqual(truncate("hello", 5), "hello");
  });

  it("truncates and appends ellipsis when over max", () => {
    assert.strictEqual(truncate("helloworld", 7), "hellow…");
    assert.strictEqual(truncate("helloworld", 7).length, 7);
  });

  it("accepts a custom ellipsis", () => {
    assert.strictEqual(truncate("helloworld", 8, "..."), "hello...");
  });

  it("returns empty string when max is 0 or negative", () => {
    assert.strictEqual(truncate("hello", 0), "");
    assert.strictEqual(truncate("hello", -1), "");
  });

  it("falls back to hard-slice when ellipsis wouldn't fit", () => {
    assert.strictEqual(truncate("hello", 2, "..."), "he");
  });
});

describe("truncate: additional edge cases", () => {
  it("returns exact input length when equal to max", () => {
    const s = "exact";
    assert.strictEqual(truncate(s, s.length), s);
  });

  it("handles empty input", () => {
    assert.strictEqual(truncate("", 10), "");
  });

  it("max equals ellipsis length hard-slices", () => {
    assert.strictEqual(truncate("helloworld", 3, "..."), "hel");
  });
});

describe("pluralize", () => {
  it("returns singular form for 1", () => {
    assert.strictEqual(pluralize(1, "server"), "1 server");
  });

  it("returns plural for 0, 2, 100", () => {
    assert.strictEqual(pluralize(0, "server"), "0 servers");
    assert.strictEqual(pluralize(2, "server"), "2 servers");
    assert.strictEqual(pluralize(100, "server"), "100 servers");
  });

  it("accepts an explicit plural for irregulars", () => {
    assert.strictEqual(pluralize(1, "entry", "entries"), "1 entry");
    assert.strictEqual(pluralize(3, "entry", "entries"), "3 entries");
  });

  it("treats negative counts as plural (documented quirk)", () => {
    // -1 is treated as not-exactly-one → plural. Negative counts are
    // unusual for pluralize use; ensure the behaviour is deterministic.
    assert.strictEqual(pluralize(-1, "server"), "-1 servers");
  });

  it("accepts decimals unchanged in the number portion", () => {
    // We don't round; callers do that. Just render what we got.
    assert.strictEqual(pluralize(1.5, "server"), "1.5 servers");
  });
});
