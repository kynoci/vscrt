import * as assert from "assert";
import {
  classifyStoredPassword,
  isPassphraseBlob,
  isSecretRef,
  parseSecretRef,
} from "../config/vscrtSecret";

describe("isSecretRef", () => {
  it("accepts canonical v4 UUID refs", () => {
    assert.strictEqual(
      isSecretRef("@secret:12345678-1234-4234-8234-123456789abc"),
      true,
    );
  });

  it("accepts uppercase hex digits", () => {
    assert.strictEqual(
      isSecretRef("@secret:12345678-1234-4234-8234-123456789ABC"),
      true,
    );
  });

  it("rejects missing prefix", () => {
    assert.strictEqual(
      isSecretRef("12345678-1234-4234-8234-123456789abc"),
      false,
    );
  });

  it("rejects empty string", () => {
    assert.strictEqual(isSecretRef(""), false);
  });

  it("rejects plaintext passwords", () => {
    assert.strictEqual(isSecretRef("hunter2"), false);
    assert.strictEqual(isSecretRef("my password"), false);
  });

  it("rejects the enc:v3 / enc:v4 forms", () => {
    assert.strictEqual(isSecretRef("enc:v3:xyz:abc"), false);
    assert.strictEqual(isSecretRef("enc:v4:t=3,m=65536,p=1:xyz:abc"), false);
  });

  it("rejects malformed UUID bodies", () => {
    assert.strictEqual(isSecretRef("@secret:not-a-uuid"), false);
    assert.strictEqual(isSecretRef("@secret:12345678"), false);
    assert.strictEqual(
      isSecretRef("@secret:12345678-1234-6234-8234-123456789abc"), // bad version (6)
      false,
    );
  });

  it("rejects trailing garbage", () => {
    assert.strictEqual(
      isSecretRef("@secret:12345678-1234-4234-8234-123456789abc EXTRA"),
      false,
    );
  });
});

describe("parseSecretRef", () => {
  it("returns the UUID portion for valid refs", () => {
    assert.strictEqual(
      parseSecretRef("@secret:12345678-1234-4234-8234-123456789abc"),
      "12345678-1234-4234-8234-123456789abc",
    );
  });

  it("returns null for invalid input", () => {
    assert.strictEqual(parseSecretRef("@secret:bogus"), null);
    assert.strictEqual(parseSecretRef(""), null);
    assert.strictEqual(parseSecretRef("plaintext"), null);
  });
});

describe("isPassphraseBlob", () => {
  it("accepts enc:v3:", () => {
    assert.strictEqual(isPassphraseBlob("enc:v3:IV:CT"), true);
  });

  it("accepts enc:v4:", () => {
    assert.strictEqual(
      isPassphraseBlob("enc:v4:t=3,m=65536,p=1:IV:CT"),
      true,
    );
  });

  it("rejects secret refs", () => {
    assert.strictEqual(
      isPassphraseBlob("@secret:12345678-1234-4234-8234-123456789abc"),
      false,
    );
  });

  it("rejects plaintext", () => {
    assert.strictEqual(isPassphraseBlob("hunter2"), false);
    assert.strictEqual(isPassphraseBlob(""), false);
  });

  it("rejects enc:v5: and other future prefixes (current scope is v3/v4)", () => {
    // If we add v5 later, this test needs to come along for the ride — the
    // helper should grow with the format set, not silently include unknowns.
    assert.strictEqual(isPassphraseBlob("enc:v5:something"), false);
    assert.strictEqual(isPassphraseBlob("enc:experimental:"), false);
  });
});

describe("classifyStoredPassword", () => {
  it("labels undefined and empty as 'empty'", () => {
    assert.strictEqual(classifyStoredPassword(undefined), "empty");
    assert.strictEqual(classifyStoredPassword(""), "empty");
  });

  it("labels canonical secret refs as 'secretRef'", () => {
    assert.strictEqual(
      classifyStoredPassword("@secret:12345678-1234-4234-8234-123456789abc"),
      "secretRef",
    );
  });

  it("labels enc:v4 blobs as 'cipher-v4'", () => {
    assert.strictEqual(
      classifyStoredPassword("enc:v4:t=3,m=65536,p=1:aaaa:bbbb"),
      "cipher-v4",
    );
  });

  it("labels enc:v3 blobs as 'cipher-v3'", () => {
    assert.strictEqual(
      classifyStoredPassword("enc:v3:aaaa:bbbb"),
      "cipher-v3",
    );
  });

  it("labels everything else as 'plaintext' (worst-case)", () => {
    assert.strictEqual(classifyStoredPassword("hunter2"), "plaintext");
    assert.strictEqual(
      classifyStoredPassword("@secret:not-a-uuid"),
      "plaintext",
    );
  });

  it("labels values starting with enc: but malformed as cipher-v3/v4 (opaque)", () => {
    // We don't try to *validate* the blob — we only classify by prefix.
    // Validation is the cipher-parser's job.
    assert.strictEqual(classifyStoredPassword("enc:v3:"), "cipher-v3");
    assert.strictEqual(
      classifyStoredPassword("enc:v4:malformed"),
      "cipher-v4",
    );
  });

  it("treats whitespace-only as plaintext (not empty)", () => {
    // `classifyStoredPassword` checks truthy-ness of the string as a
    // whole; whitespace-only strings are truthy in JS. Documenting so
    // future refactors keep the behaviour consistent.
    assert.strictEqual(classifyStoredPassword("   "), "plaintext");
  });
});
