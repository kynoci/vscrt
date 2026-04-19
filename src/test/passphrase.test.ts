import * as assert from "assert";
import {
  ArgonParams,
  CIPHER_PREFIX_V3,
  CIPHER_PREFIX_V4,
  CRTPassphraseService,
  PASSPHRASE_CHECK_KEY,
  PASSPHRASE_SALT_KEY,
  PassphraseCancelled,
  V3_PARAMS,
  encodeCiphertextV4,
  parseCiphertext,
} from "../config/vscrtPassphrase";
import {
  InMemorySecretStorage,
  LIGHT_ARGON_PARAMS,
  queueInputBoxResponses,
  resetVscodeStub,
  setInputBoxResponse,
} from "./testUtils";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { argon2idAsync } from "@noble/hashes/argon2";

function svc(
  storage: InMemorySecretStorage,
  params: ArgonParams = LIGHT_ARGON_PARAMS,
): CRTPassphraseService {
  return new CRTPassphraseService(storage, params);
}

/**
 * Hand-construct an enc:v3 ciphertext (the pre-v4 format) so we can prove
 * CRTPassphraseService still reads blobs written by earlier versions.
 * Uses V3_PARAMS for the key derivation to match the implicit params.
 */
async function buildLegacyV3Ciphertext(
  passphrase: string,
  salt: Buffer,
  plaintext: string,
): Promise<string> {
  const derived = await argon2idAsync(passphrase, salt, {
    ...V3_PARAMS,
    dkLen: 32,
  });
  const key = Buffer.from(derived);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CIPHER_PREFIX_V3}${iv.toString("base64")}:${Buffer.concat([ct, tag]).toString("base64")}`;
}

describe("CRTPassphraseService", () => {
  const PASSPHRASE = "correct-horse-battery-staple";

  beforeEach(() => {
    resetVscodeStub();
  });

  describe("isInitialized", () => {
    it("returns false before any passphrase setup", async () => {
      const storage = new InMemorySecretStorage();
      assert.strictEqual(await svc(storage).isInitialized(), false);
    });

    it("returns true after a successful first seal", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await s.seal("secret");
      assert.strictEqual(await s.isInitialized(), true);
      assert.ok(await storage.get(PASSPHRASE_SALT_KEY));
      assert.ok(await storage.get(PASSPHRASE_CHECK_KEY));
    });
  });

  describe("seal / unseal", () => {
    it("round-trips plaintext through seal and unseal", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);

      const ciphertext = await s.seal("hunter2");
      assert.ok(
        ciphertext.startsWith(CIPHER_PREFIX_V4),
        `expected v4 prefix, got ${ciphertext.slice(0, 16)}`,
      );

      const plaintext = await s.unseal(ciphertext);
      assert.strictEqual(plaintext, "hunter2");
    });

    it("embeds the configured Argon2id parameters in the v4 ciphertext", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      const ciphertext = await s.seal("payload");
      const parsed = parseCiphertext(ciphertext);
      assert.strictEqual(parsed.version, "v4");
      assert.deepStrictEqual(parsed.params, LIGHT_ARGON_PARAMS);
    });

    it("produces different ciphertexts for the same plaintext (random IV)", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);

      const a = await s.seal("same");
      const b = await s.seal("same");
      assert.notStrictEqual(a, b);
      assert.strictEqual(await s.unseal(a), "same");
      assert.strictEqual(await s.unseal(b), "same");
    });

    it("shares ciphertext across service instances with the same passphrase", async () => {
      const storage = new InMemorySecretStorage();
      const first = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      const ciphertext = await first.seal("payload");

      const second = svc(storage);
      setInputBoxResponse(PASSPHRASE);
      const plaintext = await second.unseal(ciphertext);
      assert.strictEqual(plaintext, "payload");
    });

    it("rejects a wrong passphrase on a previously set up storage", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      const ciphertext = await s.seal("payload");

      const other = svc(storage);
      setInputBoxResponse("wrong-passphrase");
      await assert.rejects(
        () => other.unseal(ciphertext),
        /incorrect passphrase/i,
      );
    });

    it("rejects ciphertext without a recognised enc:v3/v4 prefix", async () => {
      const storage = new InMemorySecretStorage();
      await assert.rejects(
        () => svc(storage).unseal("plain-not-encrypted"),
        /not an enc:v3 or enc:v4 ciphertext/,
      );
    });

    it("rejects malformed enc:v3 ciphertext", async () => {
      const s = svc(new InMemorySecretStorage());
      await assert.rejects(
        () => s.unseal(`${CIPHER_PREFIX_V3}not-base64`),
        /malformed enc:v3 ciphertext/,
      );
      await assert.rejects(
        () => s.unseal(`${CIPHER_PREFIX_V3}AAAA:AA`),
        /malformed enc:v3 ciphertext/,
      );
    });

    it("rejects malformed enc:v4 ciphertext", async () => {
      const s = svc(new InMemorySecretStorage());
      await assert.rejects(
        () => s.unseal(`${CIPHER_PREFIX_V4}t=4,m=65536,p=1:AAAA`),
        /malformed enc:v4 ciphertext/,
      );
      await assert.rejects(
        () => s.unseal(`${CIPHER_PREFIX_V4}not-params:aa:bb`),
        /malformed Argon2id params/,
      );
    });

    it("rejects a tampered ciphertext (auth tag failure)", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      const ciphertext = await s.seal("payload");

      const flipped = tamper(ciphertext);
      await assert.rejects(() => s.unseal(flipped));
    });

    it("reads a hand-constructed enc:v3 ciphertext when session params match v3", async function () {
      // Three Argon2id derivations at V3_PARAMS (t=3, m=65536) ≈ 9 s.
      this.timeout(30_000);
      const storage = new InMemorySecretStorage();
      // Seed a session keyed to V3_PARAMS so the cached params match v3 blobs.
      const salt = randomBytes(16);
      const key = Buffer.from(
        await argon2idAsync(PASSPHRASE, salt, { ...V3_PARAMS, dkLen: 32 }),
      );
      // Pre-populate SecretStorage with a v3-style check token and salt.
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([
        cipher.update("vscrt-passphrase-ok", "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      const legacyCheckToken = `${iv.toString("base64")}:${Buffer.concat([ct, tag]).toString("base64")}`;
      await storage.store(PASSPHRASE_SALT_KEY, salt.toString("base64"));
      await storage.store(PASSPHRASE_CHECK_KEY, legacyCheckToken);

      const v3Blob = await buildLegacyV3Ciphertext(PASSPHRASE, salt, "legacy-payload");

      // svc(storage, V3_PARAMS) — in case it ever falls to defaultParams.
      const s = new CRTPassphraseService(storage, V3_PARAMS);
      setInputBoxResponse(PASSPHRASE);
      assert.strictEqual(await s.unseal(v3Blob), "legacy-payload");
    });

    it("throws a params-mismatch error when blob KDF differs from session", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      // Seal with session params (LIGHT_ARGON_PARAMS).
      const myBlob = await s.seal("payload");
      assert.strictEqual(await s.unseal(myBlob), "payload");

      // Hand-craft a blob that claims different params. Since the
      // ciphertext is gibberish we don't even need valid AES — the
      // params check fires before AES-GCM verification.
      const foreignParams: ArgonParams = { t: 99, m: 131072, p: 3 };
      const iv = randomBytes(12);
      const payload = Buffer.concat([randomBytes(4), randomBytes(16)]);
      const foreign = encodeCiphertextV4(foreignParams, iv, payload);

      await assert.rejects(
        () => s.unseal(foreign),
        /different KDF parameters/,
      );
    });
  });

  describe("cancellation", () => {
    it("throws PassphraseCancelled when the user dismisses the new-passphrase prompt", async () => {
      const s = svc(new InMemorySecretStorage());
      setInputBoxResponse(undefined);
      await assert.rejects(
        () => s.seal("payload"),
        (err: unknown) => err instanceof PassphraseCancelled,
      );
    });

    it("throws PassphraseCancelled when the user dismisses the confirm prompt", async () => {
      const s = svc(new InMemorySecretStorage());
      queueInputBoxResponses([PASSPHRASE, undefined]);
      await assert.rejects(
        () => s.seal("payload"),
        (err: unknown) => err instanceof PassphraseCancelled,
      );
    });

    it("throws PassphraseCancelled when the user dismisses the unlock prompt", async () => {
      const storage = new InMemorySecretStorage();
      const first = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      const ciphertext = await first.seal("payload");

      const second = svc(storage);
      setInputBoxResponse(undefined);
      await assert.rejects(
        () => second.unseal(ciphertext),
        (err: unknown) => err instanceof PassphraseCancelled,
      );
    });
  });

  describe("lock / resetSetup", () => {
    it("caches the derived key after first prompt", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      const ciphertext = await s.seal("payload");

      // Tell the stub to refuse further prompts — if the cache is live, unseal
      // still succeeds without prompting.
      setInputBoxResponse(undefined);
      const plaintext = await s.unseal(ciphertext);
      assert.strictEqual(plaintext, "payload");
    });

    it("lock() forces a re-prompt on the next operation", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      const ciphertext = await s.seal("payload");

      s.lock();
      setInputBoxResponse(undefined);
      await assert.rejects(
        () => s.unseal(ciphertext),
        (err: unknown) => err instanceof PassphraseCancelled,
      );
    });

    it("resetSetup clears salt, check token, and cached key", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await s.seal("payload");
      assert.strictEqual(await s.isInitialized(), true);

      await s.resetSetup();
      assert.strictEqual(await s.isInitialized(), false);
      assert.strictEqual(await storage.get(PASSPHRASE_SALT_KEY), undefined);
      assert.strictEqual(await storage.get(PASSPHRASE_CHECK_KEY), undefined);
    });

    it("can re-initialize with a new passphrase after resetSetup", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await s.seal("payload");
      await s.resetSetup();

      const newPassphrase = "different-passphrase";
      queueInputBoxResponses([newPassphrase, newPassphrase]);
      const ciphertext = await s.seal("new-payload");
      assert.strictEqual(await s.unseal(ciphertext), "new-payload");
    });
  });

  describe("legacy check-token upgrade", () => {
    it("rewrites a pre-v4 (no-prefix) check token as enc:v4 on first unlock", async function () {
      this.timeout(30_000);
      const storage = new InMemorySecretStorage();
      const salt = randomBytes(16);
      const key = Buffer.from(
        await argon2idAsync(PASSPHRASE, salt, { ...V3_PARAMS, dkLen: 32 }),
      );
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([
        cipher.update("vscrt-passphrase-ok", "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      const legacyCheckToken = `${iv.toString("base64")}:${Buffer.concat([ct, tag]).toString("base64")}`;
      await storage.store(PASSPHRASE_SALT_KEY, salt.toString("base64"));
      await storage.store(PASSPHRASE_CHECK_KEY, legacyCheckToken);

      // Unlock with a v3-params-aware service so derivation matches.
      const s = new CRTPassphraseService(storage, V3_PARAMS);
      setInputBoxResponse(PASSPHRASE);
      await s.seal("any"); // trigger unlock via seal()

      const upgraded = await storage.get(PASSPHRASE_CHECK_KEY);
      assert.ok(
        upgraded?.startsWith(CIPHER_PREFIX_V4),
        `expected v4 prefix, got ${upgraded?.slice(0, 16)}`,
      );
      const parsed = parseCiphertext(upgraded!);
      // Params preserved — same user, same derived key, just newer wrapper.
      assert.deepStrictEqual(parsed.params, V3_PARAMS);
    });
  });

  describe("new install check token", () => {
    it("is enc:v4 with the service's configured defaultParams", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage); // LIGHT_ARGON_PARAMS
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await s.seal("payload");

      const tok = await storage.get(PASSPHRASE_CHECK_KEY);
      assert.ok(tok?.startsWith(CIPHER_PREFIX_V4));
      const parsed = parseCiphertext(tok!);
      assert.deepStrictEqual(parsed.params, LIGHT_ARGON_PARAMS);
    });
  });

  describe("onDidChangeLockState event", () => {
    it("fires on the first unlock (first-time setup)", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      let fired = 0;
      s.onDidChangeLockState(() => {
        fired += 1;
      });
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await s.seal("payload");
      assert.strictEqual(fired, 1);
    });

    it("fires on lock() when previously unlocked", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await s.seal("payload");

      let fired = 0;
      s.onDidChangeLockState(() => {
        fired += 1;
      });
      s.lock();
      assert.strictEqual(fired, 1);
    });

    it("does NOT fire on lock() when already locked (no state change)", () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      let fired = 0;
      s.onDidChangeLockState(() => {
        fired += 1;
      });
      s.lock(); // already locked
      s.lock();
      assert.strictEqual(fired, 0);
    });

    it("fires on subsequent unlock (existing-setup path)", async () => {
      const storage = new InMemorySecretStorage();
      const first = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await first.seal("payload");

      const second = svc(storage);
      let fired = 0;
      second.onDidChangeLockState(() => {
        fired += 1;
      });
      setInputBoxResponse(PASSPHRASE);
      await second.seal("another");
      assert.strictEqual(fired, 1);
    });

    it("fires on resetSetup (surface the not-initialised transition)", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await s.seal("payload");

      let fired = 0;
      s.onDidChangeLockState(() => {
        fired += 1;
      });
      await s.resetSetup();
      // resetSetup calls lock() (fires once) then an explicit fire for the
      // not-initialised transition. The consumer only cares that the event
      // fired at least once.
      assert.ok(fired >= 1);
    });

    it("fires on commitRotation (new session key in play)", async () => {
      const storage = new InMemorySecretStorage();
      const s = svc(storage);
      queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
      await s.seal("enrol");

      let fired = 0;
      s.onDidChangeLockState(() => {
        fired += 1;
      });
      setInputBoxResponse(PASSPHRASE);
      const LIGHT_B = { t: 2, m: 8, p: 1 };
      const keys = await s.deriveKeysForRotation(LIGHT_B);
      await s.commitRotation(keys.newKey, keys.newParams);
      assert.strictEqual(fired, 1);
    });
  });
});

/** Flip one byte inside the base64-encoded payload portion of an enc:v4 blob. */
function tamper(ciphertext: string): string {
  const body = ciphertext.slice(CIPHER_PREFIX_V4.length);
  const [params, iv, payload] = body.split(":");
  const buf = Buffer.from(payload, "base64");
  buf[buf.length - 1] ^= 0x01;
  return `${CIPHER_PREFIX_V4}${params}:${iv}:${buf.toString("base64")}`;
}

// Silence the unused-in-this-file linter hint: createDecipheriv is
// imported for completeness parallel to createCipheriv but is used only
// in the legacy fixture helpers.
void createDecipheriv;
