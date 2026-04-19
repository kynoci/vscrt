import * as assert from "assert";
import { randomBytes } from "crypto";
import {
  CIPHER_PREFIX_V3,
  CIPHER_PREFIX_V4,
  DEFAULT_PARAMS,
  V3_PARAMS,
  encodeCiphertextV4,
  parseCiphertext,
} from "../config/vscrtPassphrase";

describe("ciphertext format", () => {
  describe("DEFAULT_PARAMS", () => {
    it("bumps t above the v3 default (4 vs 3) while keeping m and p sane", () => {
      // Lock-in: if someone bumps these, tests should break so we review.
      assert.strictEqual(DEFAULT_PARAMS.t, 4);
      assert.strictEqual(DEFAULT_PARAMS.m, 65536);
      assert.strictEqual(DEFAULT_PARAMS.p, 1);
      assert.ok(DEFAULT_PARAMS.t > V3_PARAMS.t, "t bump is the whole point");
    });
  });

  describe("encodeCiphertextV4", () => {
    it("produces an enc:v4 string that parses back to the same params/iv/payload", () => {
      const iv = Buffer.alloc(12, 0xaa);
      const payload = Buffer.alloc(32, 0xbb);
      const params = { t: 4, m: 65536, p: 2 };
      const s = encodeCiphertextV4(params, iv, payload);
      assert.ok(s.startsWith(`${CIPHER_PREFIX_V4}t=4,m=65536,p=2:`));
      const parsed = parseCiphertext(s);
      assert.deepStrictEqual(parsed.params, params);
      assert.ok(parsed.iv.equals(iv));
      assert.ok(parsed.payload.equals(payload));
    });

    it("round-trips through parseCiphertext", () => {
      const iv = randomBytes(12);
      const payload = randomBytes(48);
      const params = { t: 3, m: 131072, p: 4 };
      const parsed = parseCiphertext(encodeCiphertextV4(params, iv, payload));
      assert.strictEqual(parsed.version, "v4");
      assert.deepStrictEqual(parsed.params, params);
      assert.ok(parsed.iv.equals(iv));
      assert.ok(parsed.payload.equals(payload));
    });
  });

  describe("parseCiphertext — v3", () => {
    it("treats the absence of a params block as V3_PARAMS", () => {
      const iv = randomBytes(12);
      const payload = randomBytes(32);
      const s = `${CIPHER_PREFIX_V3}${iv.toString("base64")}:${payload.toString("base64")}`;
      const parsed = parseCiphertext(s);
      assert.strictEqual(parsed.version, "v3");
      assert.deepStrictEqual(parsed.params, V3_PARAMS);
      assert.ok(parsed.iv.equals(iv));
      assert.ok(parsed.payload.equals(payload));
    });

    it("rejects malformed v3 bodies", () => {
      assert.throws(
        () => parseCiphertext(`${CIPHER_PREFIX_V3}not-base64`),
        /malformed enc:v3 ciphertext/,
      );
      assert.throws(
        () => parseCiphertext(`${CIPHER_PREFIX_V3}AAAA:AAAA`),
        /malformed enc:v3 ciphertext/,
      );
    });
  });

  describe("parseCiphertext — v4", () => {
    it("rejects the wrong number of colon-separated parts", () => {
      assert.throws(
        () => parseCiphertext(`${CIPHER_PREFIX_V4}onlyparams`),
        /malformed enc:v4 ciphertext/,
      );
      assert.throws(
        () => parseCiphertext(`${CIPHER_PREFIX_V4}t=4,m=65536,p=1:aa`),
        /malformed enc:v4 ciphertext/,
      );
    });

    it("rejects missing params", () => {
      const iv = randomBytes(12).toString("base64");
      const payload = randomBytes(32).toString("base64");
      assert.throws(
        () => parseCiphertext(`${CIPHER_PREFIX_V4}t=4,m=65536:${iv}:${payload}`),
        /missing Argon2id params/,
      );
    });

    it("rejects non-integer or non-positive params", () => {
      const iv = randomBytes(12).toString("base64");
      const payload = randomBytes(32).toString("base64");
      assert.throws(
        () =>
          parseCiphertext(
            `${CIPHER_PREFIX_V4}t=0,m=65536,p=1:${iv}:${payload}`,
          ),
        /bad Argon2id param 't'/,
      );
      assert.throws(
        () =>
          parseCiphertext(
            `${CIPHER_PREFIX_V4}t=4,m=abc,p=1:${iv}:${payload}`,
          ),
        /bad Argon2id param 'm'/,
      );
    });

    it("rejects unknown params keys", () => {
      const iv = randomBytes(12).toString("base64");
      const payload = randomBytes(32).toString("base64");
      assert.throws(
        () =>
          parseCiphertext(
            `${CIPHER_PREFIX_V4}t=4,m=65536,p=1,z=9:${iv}:${payload}`,
          ),
        /unknown Argon2id param 'z'/,
      );
    });

    it("rejects undersized IV or payload", () => {
      const tinyIv = Buffer.alloc(4).toString("base64");
      const okPayload = randomBytes(32).toString("base64");
      assert.throws(
        () =>
          parseCiphertext(
            `${CIPHER_PREFIX_V4}t=4,m=65536,p=1:${tinyIv}:${okPayload}`,
          ),
        /malformed enc:v4 ciphertext/,
      );
      const okIv = randomBytes(12).toString("base64");
      const tinyPayload = Buffer.alloc(4).toString("base64");
      assert.throws(
        () =>
          parseCiphertext(
            `${CIPHER_PREFIX_V4}t=4,m=65536,p=1:${okIv}:${tinyPayload}`,
          ),
        /malformed enc:v4 ciphertext/,
      );
    });
  });

  describe("parseCiphertext — unknown prefix", () => {
    it("throws a helpful error", () => {
      assert.throws(
        () => parseCiphertext("enc:v9:whatever"),
        /not an enc:v3 or enc:v4 ciphertext/,
      );
      assert.throws(
        () => parseCiphertext("plain-text"),
        /not an enc:v3 or enc:v4 ciphertext/,
      );
    });
  });
});
