import * as assert from "assert";
import {
  CIPHER_PREFIX_V4,
  CRTPassphraseService,
} from "../config/vscrtPassphrase";
import {
  CIPHER_PREFIX,
  CRTSecretService,
  SECRET_INDEX_KEY,
  SECRET_KEY_PREFIX,
  SECRET_PREFIX,
} from "../config/vscrtSecret";
import {
  InMemorySecretStorage,
  LIGHT_ARGON_PARAMS,
  queueInputBoxResponses,
  resetVscodeStub,
} from "./testUtils";

describe("CRTSecretService", () => {
  beforeEach(() => {
    resetVscodeStub();
  });

  describe("seal (secretstorage mode)", () => {
    it("returns an @secret: reference and stores plaintext in SecretStorage", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      const ref = await svc.seal("hunter2");

      assert.ok(ref.startsWith(SECRET_PREFIX));
      const id = ref.slice(SECRET_PREFIX.length);
      assert.ok(/^[0-9a-f-]{36}$/i.test(id), `expected uuid, got ${id}`);
      assert.strictEqual(await storage.get(SECRET_KEY_PREFIX + id), "hunter2");
    });

    it("registers the id in the index", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      const refA = await svc.seal("a");
      const refB = await svc.seal("b");

      const index = JSON.parse(
        (await storage.get(SECRET_INDEX_KEY)) ?? "[]",
      ) as string[];
      assert.deepStrictEqual(index.sort(), [
        refA.slice(SECRET_PREFIX.length),
        refB.slice(SECRET_PREFIX.length),
      ].sort());
    });
  });

  describe("seal (passphrase mode)", () => {
    it("throws if no passphrase service was supplied", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      await assert.rejects(
        () => svc.seal("hunter2", "passphrase"),
        /passphrase service not available/,
      );
    });

    it("delegates to the passphrase service and round-trips", async () => {
      const storage = new InMemorySecretStorage();
      const passphrase = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS);
      const svc = new CRTSecretService(storage, passphrase);
      queueInputBoxResponses(["strong-passphrase", "strong-passphrase"]);

      const ciphertext = await svc.seal("hunter2", "passphrase");
      assert.ok(
        ciphertext.startsWith(CIPHER_PREFIX_V4),
        `expected v4 prefix, got ${ciphertext.slice(0, 16)}`,
      );
      assert.strictEqual(await svc.unseal(ciphertext), "hunter2");
    });
  });

  describe("unseal", () => {
    it("returns undefined for undefined input", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      assert.strictEqual(await svc.unseal(undefined), undefined);
    });

    it("returns plaintext input unchanged (legacy path)", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      assert.strictEqual(await svc.unseal("legacy-plain"), "legacy-plain");
    });

    it("resolves an @secret: reference back to plaintext", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      const ref = await svc.seal("payload");
      assert.strictEqual(await svc.unseal(ref), "payload");
    });

    it("returns undefined for an @secret: reference whose backing entry was deleted", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      const ref = await svc.seal("payload");
      const id = ref.slice(SECRET_PREFIX.length);
      await storage.delete(SECRET_KEY_PREFIX + id);
      assert.strictEqual(await svc.unseal(ref), undefined);
    });

    it("throws for the reserved enc:v1 prefix", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      await assert.rejects(
        () => svc.unseal(`${CIPHER_PREFIX}reserved`),
        /enc:v1.*reserved/,
      );
    });

    it("throws for passphrase ciphertext without a passphrase service", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      await assert.rejects(
        () => svc.unseal("enc:v3:anything"),
        /passphrase service unavailable/,
      );
      await assert.rejects(
        () => svc.unseal("enc:v4:t=4,m=65536,p=1:aa:bb"),
        /passphrase service unavailable/,
      );
    });
  });

  describe("classifiers", () => {
    let svc: CRTSecretService;
    beforeEach(() => {
      svc = new CRTSecretService(new InMemorySecretStorage());
    });

    it("identifies references", () => {
      assert.strictEqual(svc.isReference(undefined), false);
      assert.strictEqual(svc.isReference(""), false);
      assert.strictEqual(svc.isReference("plain"), false);
      assert.strictEqual(svc.isReference("@secret:abc"), true);
      assert.strictEqual(svc.isReference("enc:v3:abc"), false);
      assert.strictEqual(svc.isReference("enc:v4:abc"), false);
    });

    it("identifies passphrase ciphertext in both v3 and v4 forms", () => {
      assert.strictEqual(svc.isPassphraseCiphertext(undefined), false);
      assert.strictEqual(svc.isPassphraseCiphertext("enc:v3:abc"), true);
      assert.strictEqual(svc.isPassphraseCiphertext("enc:v4:abc"), true);
      assert.strictEqual(svc.isPassphraseCiphertext("@secret:abc"), false);
      assert.strictEqual(svc.isPassphraseCiphertext("plain"), false);
    });

    it("identifies legacy plaintext", () => {
      assert.strictEqual(svc.isLegacyPlaintext(undefined), false);
      assert.strictEqual(svc.isLegacyPlaintext("@secret:abc"), false);
      assert.strictEqual(svc.isLegacyPlaintext("enc:v1:abc"), false);
      assert.strictEqual(svc.isLegacyPlaintext("enc:v3:abc"), false);
      assert.strictEqual(svc.isLegacyPlaintext("enc:v4:abc"), false);
      assert.strictEqual(svc.isLegacyPlaintext("hunter2"), true);
    });
  });

  describe("forget", () => {
    it("removes the backing secret and the index entry for a reference", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      const ref = await svc.seal("payload");
      const id = ref.slice(SECRET_PREFIX.length);

      await svc.forget(ref);
      assert.strictEqual(await storage.get(SECRET_KEY_PREFIX + id), undefined);
      const index = JSON.parse(
        (await storage.get(SECRET_INDEX_KEY)) ?? "[]",
      ) as string[];
      assert.deepStrictEqual(index, []);
    });

    it("is a no-op for non-reference inputs", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      await svc.forget(undefined);
      await svc.forget("plain");
      await svc.forget("enc:v3:whatever");
      assert.strictEqual(storage.size(), 0);
    });
  });

  describe("pruneOrphans", () => {
    it("removes entries whose ids are not in the keep list", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      const keep = await svc.seal("keep");
      const drop = await svc.seal("drop");
      const dropId = drop.slice(SECRET_PREFIX.length);

      await svc.pruneOrphans([keep]);

      assert.strictEqual(await svc.unseal(keep), "keep");
      assert.strictEqual(
        await storage.get(SECRET_KEY_PREFIX + dropId),
        undefined,
      );
      const index = JSON.parse(
        (await storage.get(SECRET_INDEX_KEY)) ?? "[]",
      ) as string[];
      assert.deepStrictEqual(index, [keep.slice(SECRET_PREFIX.length)]);
    });

    it("ignores non-reference strings in the keep list", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      const keep = await svc.seal("keep");

      await svc.pruneOrphans([keep, "plain", "enc:v3:abc"]);

      assert.strictEqual(await svc.unseal(keep), "keep");
    });

    it("does nothing when every id is already kept", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      const a = await svc.seal("a");
      const b = await svc.seal("b");
      const before = JSON.stringify(
        [...storage.snapshot().entries()].sort(),
      );

      await svc.pruneOrphans([a, b]);

      const after = JSON.stringify(
        [...storage.snapshot().entries()].sort(),
      );
      assert.strictEqual(before, after);
    });
  });

  describe("clearAll", () => {
    it("removes every tracked secret and empties the index", async () => {
      const storage = new InMemorySecretStorage();
      const svc = new CRTSecretService(storage);
      await svc.seal("a");
      await svc.seal("b");
      await svc.seal("c");

      await svc.clearAll();

      const index = JSON.parse(
        (await storage.get(SECRET_INDEX_KEY)) ?? "[]",
      ) as string[];
      assert.deepStrictEqual(index, []);
      // Only the (now-empty) index key may remain; no per-id secrets.
      for (const key of storage.snapshot().keys()) {
        if (key === SECRET_INDEX_KEY) {
          continue;
        }
        assert.ok(
          !key.startsWith(SECRET_KEY_PREFIX),
          `unexpected leftover secret: ${key}`,
        );
      }
    });
  });
});
