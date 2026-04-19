import * as assert from "assert";
import {
  isValidEntry,
  lookupFingerprint,
  sanitiseManifest,
} from "../remote";

const SAMPLE_FP_A = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SAMPLE_FP_B = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("isValidEntry", () => {
  it("accepts canonical entries", () => {
    assert.strictEqual(
      isValidEntry({ host: "h.example", sha256: SAMPLE_FP_A }),
      true,
    );
    assert.strictEqual(
      isValidEntry({
        host: "h.example",
        port: 2222,
        sha256: SAMPLE_FP_A,
        comment: "bastion",
      }),
      true,
    );
  });

  it("rejects missing or non-string host", () => {
    assert.strictEqual(isValidEntry({ sha256: SAMPLE_FP_A }), false);
    assert.strictEqual(isValidEntry({ host: 42, sha256: SAMPLE_FP_A }), false);
  });

  it("rejects malformed port", () => {
    assert.strictEqual(
      isValidEntry({ host: "x", port: 70000, sha256: SAMPLE_FP_A }),
      false,
    );
    assert.strictEqual(
      isValidEntry({ host: "x", port: 0, sha256: SAMPLE_FP_A }),
      false,
    );
    assert.strictEqual(
      isValidEntry({ host: "x", port: "22", sha256: SAMPLE_FP_A }),
      false,
    );
  });

  it("rejects invalid sha256 format", () => {
    assert.strictEqual(
      isValidEntry({ host: "x", sha256: "MD5:abc123" }),
      false,
    );
    assert.strictEqual(isValidEntry({ host: "x", sha256: "" }), false);
    assert.strictEqual(
      isValidEntry({ host: "x", sha256: "SHA256:" }),
      false,
    );
  });
});

describe("sanitiseManifest", () => {
  it("filters a mixed-validity array", () => {
    const raw = [
      { host: "good", sha256: SAMPLE_FP_A },
      { host: 42, sha256: SAMPLE_FP_A },
      null,
      "not-an-object",
      { host: "good2", port: 2222, sha256: SAMPLE_FP_B },
    ];
    const out = sanitiseManifest(raw);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].host, "good");
    assert.strictEqual(out[1].host, "good2");
  });

  it("returns [] for non-array input", () => {
    assert.deepStrictEqual(sanitiseManifest({}), []);
    assert.deepStrictEqual(sanitiseManifest(null), []);
  });
});

describe("lookupFingerprint", () => {
  const manifest = [
    { host: "alpha.example", sha256: SAMPLE_FP_A },
    { host: "beta.example", port: 2222, sha256: SAMPLE_FP_B },
  ];

  it("matches on host when port is unspecified in entry", () => {
    const r = lookupFingerprint(manifest, "alpha.example", 22, SAMPLE_FP_A);
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.entry?.host, "alpha.example");
  });

  it("matches on exact host:port when entry has port", () => {
    const r = lookupFingerprint(manifest, "beta.example", 2222, SAMPLE_FP_B);
    assert.strictEqual(r.matched, true);
  });

  it("returns matched=false when fingerprint differs", () => {
    const r = lookupFingerprint(manifest, "alpha.example", 22, SAMPLE_FP_B);
    assert.strictEqual(r.matched, false);
    assert.strictEqual(r.mismatchedEntry?.sha256, SAMPLE_FP_A);
  });

  it("returns matched=false when host isn't pinned at all", () => {
    const r = lookupFingerprint(manifest, "gamma.example", 22, SAMPLE_FP_A);
    assert.strictEqual(r.matched, false);
    assert.strictEqual(r.mismatchedEntry, undefined);
  });

  it("does not match a different port than the entry specifies", () => {
    const r = lookupFingerprint(manifest, "beta.example", 22, SAMPLE_FP_B);
    assert.strictEqual(r.matched, false);
  });
});
