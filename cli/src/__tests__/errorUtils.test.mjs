import assert from "node:assert/strict";
import { test } from "node:test";

import { formatError } from "../../out/errorUtils.js";

test("formatError: Error with message", () => {
  assert.equal(formatError(new Error("boom")), "boom");
});

test("formatError: string", () => {
  assert.equal(formatError("raw"), "raw");
});

test("formatError: undefined returns fallback", () => {
  assert.equal(formatError(undefined), "(unknown error)");
});

test("formatError: null returns fallback", () => {
  assert.equal(formatError(null), "(unknown error)");
});

test("formatError: number coerces", () => {
  assert.equal(formatError(42), "42");
});

test("formatError: Error with empty message returns 'Error'", () => {
  assert.equal(formatError(new Error("")), "Error");
});
