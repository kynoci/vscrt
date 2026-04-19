import * as assert from "assert";
import {
  isMostlyRepeated,
  isSimpleSequence,
  scorePassphrase,
} from "../config/passwordStrength";

describe("scorePassphrase", () => {
  it("scores empty + very short as 0", () => {
    assert.strictEqual(scorePassphrase("").score, 0);
    assert.strictEqual(scorePassphrase("abc").score, 0);
    assert.strictEqual(scorePassphrase("1234567").score, 0);
  });

  it("scores 8-char mixed as 1 (weak)", () => {
    const r = scorePassphrase("abcd1234");
    assert.strictEqual(r.score, 1);
    assert.strictEqual(r.label, "weak");
  });

  it("scores a long 3-class passphrase as strong+", () => {
    const r = scorePassphrase("correct-horse-battery-3");
    assert.ok(r.score >= 3, `expected score ≥3, got ${r.score}`);
  });

  it("penalises 'password' + simple sequences", () => {
    assert.ok(scorePassphrase("passwordpassword").score <= 2);
    assert.ok(scorePassphrase("qwertyuiop").score <= 1);
    assert.ok(scorePassphrase("abcdefgh12345").score <= 2);
  });

  it("penalises known-weak passwords from the expanded blacklist", () => {
    assert.ok(scorePassphrase("hunter2strong!").score <= 2, "hunter2 should be flagged");
    assert.ok(scorePassphrase("changeme1234").score <= 2, "changeme should be flagged");
    assert.ok(scorePassphrase("TrustNo1--").score <= 2, "trustno1 should be flagged case-insensitively");
    assert.ok(scorePassphrase("root1234567").score <= 2, "root should be flagged");
  });

  it("penalises repetition", () => {
    assert.ok(scorePassphrase("aaaaaaaaaaaa").score <= 1);
    assert.ok(scorePassphrase("ababababab").score <= 1);
  });

  it("returns a suggestion when score < 3", () => {
    const r = scorePassphrase("short");
    assert.ok(r.suggestion && r.suggestion.length > 0);
  });

  it("does not return a suggestion when score ≥ 3", () => {
    const r = scorePassphrase("correct-horse-battery-3");
    assert.strictEqual(r.suggestion, undefined);
  });
});

describe("isMostlyRepeated", () => {
  it("flags same-char strings", () => {
    assert.strictEqual(isMostlyRepeated("aaaaaaaaaaaa"), true);
  });

  it("flags short-window repetitions", () => {
    assert.strictEqual(isMostlyRepeated("ababababab"), true);
  });

  it("does not flag natural passphrases", () => {
    assert.strictEqual(isMostlyRepeated("correct horse battery staple"), false);
  });

  it("does not flag short inputs", () => {
    assert.strictEqual(isMostlyRepeated("abc"), false);
  });
});

describe("isSimpleSequence", () => {
  it("detects alphabetic runs", () => {
    assert.strictEqual(isSimpleSequence("abcdefghij"), true);
    assert.strictEqual(isSimpleSequence("Abcdef-123"), true);
  });

  it("detects keyboard runs", () => {
    assert.strictEqual(isSimpleSequence("qwertyui"), true);
    assert.strictEqual(isSimpleSequence("asdfghjk"), true);
  });

  it("detects reverse runs", () => {
    assert.strictEqual(isSimpleSequence("fedcba12"), true);
  });

  it("does not flag natural passphrases", () => {
    assert.strictEqual(isSimpleSequence("correct horse battery"), false);
  });
});
