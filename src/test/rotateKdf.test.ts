import * as assert from "assert";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";
import {
  ArgonParams,
  CIPHER_PREFIX_V4,
  CRTPassphraseService,
  PASSPHRASE_CHECK_KEY,
  PASSPHRASE_SALT_KEY,
  PassphraseCancelled,
  argonParamsEqual,
  encodeCiphertextV4,
  parseCiphertext,
  reencryptBlob,
} from "../config/vscrtPassphrase";
import {
  InMemorySecretStorage,
  LIGHT_ARGON_PARAMS,
  queueInputBoxResponses,
  resetVscodeStub,
  setInputBoxResponse,
} from "./testUtils";

/** A second fast Argon2id param set, different from LIGHT_ARGON_PARAMS. */
const LIGHT_B: ArgonParams = { t: 2, m: 8, p: 1 };

const PASSPHRASE = "correct-horse-battery-staple";

describe("KDF rotation", () => {
  beforeEach(() => {
    resetVscodeStub();
  });

  describe("argonParamsEqual", () => {
    it("compares all three fields", () => {
      assert.strictEqual(
        argonParamsEqual({ t: 1, m: 8, p: 1 }, { t: 1, m: 8, p: 1 }),
        true,
      );
      assert.strictEqual(
        argonParamsEqual({ t: 1, m: 8, p: 1 }, { t: 2, m: 8, p: 1 }),
        false,
      );
      assert.strictEqual(
        argonParamsEqual({ t: 1, m: 8, p: 1 }, { t: 1, m: 65536, p: 1 }),
        false,
      );
      assert.strictEqual(
        argonParamsEqual({ t: 1, m: 8, p: 1 }, { t: 1, m: 8, p: 2 }),
        false,
      );
    });
  });

  describe("reencryptBlob", () => {
    it("decrypts with oldKey and re-encrypts with newKey + newParams", () => {
      const oldKey = randomBytes(32);
      const newKey = randomBytes(32);
      const blob = sealRaw(oldKey, LIGHT_ARGON_PARAMS, "secret-payload");

      const rotated = reencryptBlob(blob, oldKey, newKey, LIGHT_B);
      const parsed = parseCiphertext(rotated);
      assert.strictEqual(parsed.version, "v4");
      assert.deepStrictEqual(parsed.params, LIGHT_B);

      const decoded = unsealRaw(rotated, newKey);
      assert.strictEqual(decoded, "secret-payload");
    });

    it("refuses to decrypt when oldKey is wrong (AES-GCM auth fires)", () => {
      const oldKey = randomBytes(32);
      const newKey = randomBytes(32);
      const blob = sealRaw(oldKey, LIGHT_ARGON_PARAMS, "payload");

      const wrongKey = randomBytes(32);
      assert.throws(() => reencryptBlob(blob, wrongKey, newKey, LIGHT_B));
    });

    it("works for v3 blobs (promotes them to v4 with newParams)", () => {
      const oldKey = randomBytes(32);
      const newKey = randomBytes(32);
      // Hand-construct a v3 blob (no params block).
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", oldKey, iv);
      const ct = Buffer.concat([
        cipher.update("v3-payload", "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      const v3Blob = `enc:v3:${iv.toString("base64")}:${Buffer.concat([ct, tag]).toString("base64")}`;

      const rotated = reencryptBlob(v3Blob, oldKey, newKey, LIGHT_B);
      assert.ok(rotated.startsWith(CIPHER_PREFIX_V4));
      assert.strictEqual(unsealRaw(rotated, newKey), "v3-payload");
    });
  });

  describe("deriveKeysForRotation", () => {
    it("returns both keys and embeds the correct oldParams", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await svc.seal("enrol"); // write LIGHT_A check token + session

      setInputBoxResponse(PASSPHRASE);
      const keys = await svc.deriveKeysForRotation(LIGHT_B);

      assert.deepStrictEqual(keys.oldParams, LIGHT_ARGON_PARAMS);
      assert.deepStrictEqual(keys.newParams, LIGHT_B);
      assert.strictEqual(keys.oldKey.length, 32);
      assert.strictEqual(keys.newKey.length, 32);
      assert.ok(!keys.oldKey.equals(keys.newKey), "new key differs");
    });

    it("throws 'incorrect passphrase' on a bad re-entry", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await svc.seal("enrol");

      setInputBoxResponse("definitely-wrong");
      await assert.rejects(
        () => svc.deriveKeysForRotation(LIGHT_B),
        /incorrect passphrase/i,
      );
    });

    it("throws PassphraseCancelled when user dismisses the prompt", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await svc.seal("enrol");

      setInputBoxResponse(undefined);
      await assert.rejects(
        () => svc.deriveKeysForRotation(LIGHT_B),
        (err: unknown) => err instanceof PassphraseCancelled,
      );
    });

    it("throws 'not set up' when no check token exists", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS);
      await assert.rejects(
        () => svc.deriveKeysForRotation(LIGHT_B),
        /not set up/,
      );
    });
  });

  describe("commitRotation", () => {
    it("swaps session state so subsequent seal uses newParams", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      const beforeBlob = await svc.seal("pre-rotation");
      assert.deepStrictEqual(
        parseCiphertext(beforeBlob).params,
        LIGHT_ARGON_PARAMS,
      );

      setInputBoxResponse(PASSPHRASE);
      const keys = await svc.deriveKeysForRotation(LIGHT_B);
      await svc.commitRotation(keys.newKey, keys.newParams);

      // getCachedParams now reports the new params.
      assert.deepStrictEqual(svc.getCachedParams(), LIGHT_B);

      const afterBlob = await svc.seal("post-rotation");
      assert.deepStrictEqual(parseCiphertext(afterBlob).params, LIGHT_B);
    });

    it("writes a new check token in v4 format with the new params", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await svc.seal("enrol");

      setInputBoxResponse(PASSPHRASE);
      const keys = await svc.deriveKeysForRotation(LIGHT_B);
      await svc.commitRotation(keys.newKey, keys.newParams);

      const newToken = await storage.get(PASSPHRASE_CHECK_KEY);
      assert.ok(newToken?.startsWith(CIPHER_PREFIX_V4));
      assert.deepStrictEqual(parseCiphertext(newToken!).params, LIGHT_B);

      // Salt is unchanged by rotation — same passphrase + salt would still
      // derive the old key too.
      const saltStillThere = await storage.get(PASSPHRASE_SALT_KEY);
      assert.ok(saltStillThere, "salt retained");
    });
  });

  describe("end-to-end rotation", () => {
    it("rotates a blob and unseals it under the new session key", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      const oldBlob = await svc.seal("treasure");

      setInputBoxResponse(PASSPHRASE);
      const keys = await svc.deriveKeysForRotation(LIGHT_B);
      const rotatedBlob = reencryptBlob(
        oldBlob,
        keys.oldKey,
        keys.newKey,
        keys.newParams,
      );
      await svc.commitRotation(keys.newKey, keys.newParams);

      // The rotated blob round-trips under the new session.
      assert.strictEqual(await svc.unseal(rotatedBlob), "treasure");

      // The ORIGINAL (pre-rotation) blob now triggers params-mismatch,
      // which is the expected failure mode for unrotated ciphertext.
      await assert.rejects(
        () => svc.unseal(oldBlob),
        /different KDF parameters/,
      );
    });

    it("is a no-op-safe: deriving the same target params twice produces equal keys", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await svc.seal("enrol");

      setInputBoxResponse(PASSPHRASE);
      const k1 = await svc.deriveKeysForRotation(LIGHT_B);
      setInputBoxResponse(PASSPHRASE);
      const k2 = await svc.deriveKeysForRotation(LIGHT_B);

      assert.ok(k1.newKey.equals(k2.newKey), "same passphrase+salt+params → same key");
    });
  });
});

/* --- raw AES-GCM helpers (bypass Argon2id for pure-reencrypt tests) --- */

function sealRaw(key: Buffer, params: ArgonParams, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return encodeCiphertextV4(params, iv, Buffer.concat([ct, tag]));
}

function unsealRaw(blob: string, key: Buffer): string {
  const parsed = parseCiphertext(blob);
  const tag = parsed.payload.subarray(parsed.payload.length - 16);
  const ct = parsed.payload.subarray(0, parsed.payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
