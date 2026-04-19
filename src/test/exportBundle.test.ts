import * as assert from "assert";
import {
  BUNDLE_FORMAT,
  ExportBundle,
  assembleBundle,
  bundleParams,
  deriveNewBundleKey,
  mapNodePasswords,
  makeBundleCheckToken,
  stripMachineSpecificFields,
  validateBundleShape,
  verifyBundleCheckToken,
} from "../config/vscrtExportBundle";
import {
  deriveKeyWith,
  sealWithKey,
  unsealWithKey,
} from "../config/vscrtPassphrase";
import { CRTConfig } from "../config/vscrtConfig";
import { LIGHT_ARGON_PARAMS } from "./testUtils";

describe("validateBundleShape", () => {
  function goodBundle(): Record<string, unknown> {
    return {
      format: BUNDLE_FORMAT,
      createdAt: new Date().toISOString(),
      kdf: {
        alg: "argon2id",
        t: 4,
        m: 65536,
        p: 1,
        salt: "aGVsbG8=",
      },
      checkToken: "enc:v4:t=4,m=65536,p=1:aaaa:bbbb",
      passwordsIncluded: true,
      config: { folder: [] },
    };
  }

  it("accepts a well-formed bundle", () => {
    const out = validateBundleShape(goodBundle());
    assert.ok("bundle" in out);
  });

  it("rejects a wrong format version", () => {
    const b = goodBundle();
    b.format = "vscrt-bundle/v0";
    const out = validateBundleShape(b);
    assert.ok("error" in out);
  });

  it("rejects when kdf is missing", () => {
    const b = goodBundle();
    delete (b as Record<string, unknown>).kdf;
    assert.ok("error" in validateBundleShape(b));
  });

  it("rejects when kdf.alg is unknown", () => {
    const b = goodBundle();
    (b.kdf as Record<string, unknown>).alg = "scrypt";
    assert.ok("error" in validateBundleShape(b));
  });

  it("rejects non-integer kdf params", () => {
    const b = goodBundle();
    (b.kdf as Record<string, unknown>).t = 0;
    assert.ok("error" in validateBundleShape(b));
  });

  it("rejects a missing checkToken", () => {
    const b = goodBundle();
    delete (b as Record<string, unknown>).checkToken;
    assert.ok("error" in validateBundleShape(b));
  });

  it("rejects a missing passwordsIncluded flag", () => {
    const b = goodBundle();
    delete (b as Record<string, unknown>).passwordsIncluded;
    assert.ok("error" in validateBundleShape(b));
  });

  it("rejects non-object root", () => {
    assert.ok("error" in validateBundleShape(null));
    assert.ok("error" in validateBundleShape([]));
    assert.ok("error" in validateBundleShape("oops"));
  });
});

describe("bundle check token", () => {
  it("round-trips with the correct key and rejects the wrong key", async () => {
    const { key, params } = await deriveNewBundleKey(
      "correct-horse-battery",
      LIGHT_ARGON_PARAMS,
    );
    const token = makeBundleCheckToken(key, params);
    assert.strictEqual(verifyBundleCheckToken(key, token), true);

    const wrong = await deriveKeyWith(
      "wrong-horse-battery",
      Buffer.from("0123456789abcdef", "utf-8"),
      LIGHT_ARGON_PARAMS,
    );
    assert.strictEqual(verifyBundleCheckToken(wrong, token), false);
  });

  it("returns false on garbage token", () => {
    const key = Buffer.alloc(32, 1);
    assert.strictEqual(verifyBundleCheckToken(key, "not-a-cipher"), false);
  });
});

describe("mapNodePasswords", () => {
  const cfg: CRTConfig = {
    folder: [
      {
        name: "Prod",
        nodes: [
          { name: "A", endpoint: "u@a", password: "secretA" },
          { name: "B", endpoint: "u@b" }, // no password
        ],
        subfolder: [
          {
            name: "DB",
            nodes: [
              { name: "C", endpoint: "u@c", password: "secretC" },
            ],
          },
        ],
      },
    ],
  };

  it("counts every node that HAD a password", async () => {
    const { count } = await mapNodePasswords(cfg, async (pw) => pw);
    assert.strictEqual(count, 2);
  });

  it("returns a clone — the original is untouched", async () => {
    const { config } = await mapNodePasswords(cfg, async () => "CHANGED");
    assert.strictEqual(cfg.folder![0].nodes![0].password, "secretA");
    assert.strictEqual(config.folder![0].nodes![0].password, "CHANGED");
  });

  it("strip (returning undefined) removes the password field", async () => {
    const { config } = await mapNodePasswords(cfg, async () => undefined);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(config.folder![0].nodes![0], "password"),
      false,
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        config.folder![0].subfolder![0].nodes![0],
        "password",
      ),
      false,
    );
  });
});

describe("stripMachineSpecificFields", () => {
  it("removes passwordStorage from every node", () => {
    const cfg: CRTConfig = {
      folder: [
        {
          name: "X",
          nodes: [
            {
              name: "n",
              endpoint: "u@h",
              passwordStorage: "passphrase",
              password: "enc:v4:...",
            },
          ],
          subfolder: [
            {
              name: "Y",
              nodes: [
                {
                  name: "m",
                  endpoint: "u@h2",
                  passwordStorage: "secretstorage",
                },
              ],
            },
          ],
        },
      ],
    };
    const stripped = stripMachineSpecificFields(cfg);
    assert.strictEqual(stripped.folder![0].nodes![0].passwordStorage, undefined);
    assert.strictEqual(
      stripped.folder![0].subfolder![0].nodes![0].passwordStorage,
      undefined,
    );
    // Password itself is unchanged by strip.
    assert.strictEqual(stripped.folder![0].nodes![0].password, "enc:v4:...");
    // Original untouched.
    assert.strictEqual(cfg.folder![0].nodes![0].passwordStorage, "passphrase");
  });
});

describe("export → import round trip", () => {
  it("re-keys passwords and the receiver can decrypt with the same passphrase", async () => {
    const passphrase = "correct-horse-battery";

    // --- SENDING SIDE ---
    const { key, salt, params } = await deriveNewBundleKey(
      passphrase,
      LIGHT_ARGON_PARAMS,
    );
    const plaintextPasswords = new Map<string, string>([
      ["Prod/Web", "pw-web-42"],
      ["Prod/DB/Primary", "pg-primary-secret"],
    ]);
    const cfg: CRTConfig = {
      folder: [
        {
          name: "Prod",
          nodes: [{ name: "Web", endpoint: "u@w", password: "SESSION-BLOB-1" }],
          subfolder: [
            {
              name: "DB",
              nodes: [
                { name: "Primary", endpoint: "p@d", password: "SESSION-BLOB-2" },
              ],
            },
          ],
        },
      ],
    };
    // Simulate the "unseal then re-key under bundle key" step: we use the
    // plaintextPasswords map as a stand-in for the session's SecretService.
    const { config: rekeyed, count } = await mapNodePasswords(cfg, async (pw) => {
      const pt =
        pw === "SESSION-BLOB-1"
          ? plaintextPasswords.get("Prod/Web")!
          : plaintextPasswords.get("Prod/DB/Primary")!;
      return sealWithKey(key, params, pt);
    });
    assert.strictEqual(count, 2);
    const bundle = assembleBundle(key, salt, params, true, rekeyed);
    assert.strictEqual(bundle.format, BUNDLE_FORMAT);
    assert.strictEqual(bundle.passwordsIncluded, true);

    // --- RECEIVING SIDE (fresh key derivation, same passphrase) ---
    const receiverKey = await deriveKeyWith(
      passphrase,
      Buffer.from(bundle.kdf.salt, "base64"),
      bundleParams(bundle),
    );
    assert.strictEqual(
      verifyBundleCheckToken(receiverKey, bundle.checkToken),
      true,
    );

    const webBlob = bundle.config.folder![0].nodes![0].password!;
    const primaryBlob =
      bundle.config.folder![0].subfolder![0].nodes![0].password!;
    assert.strictEqual(unsealWithKey(receiverKey, webBlob), "pw-web-42");
    assert.strictEqual(
      unsealWithKey(receiverKey, primaryBlob),
      "pg-primary-secret",
    );
  });

  it("rejects a wrong passphrase on the receiving side", async () => {
    const { key, salt, params } = await deriveNewBundleKey(
      "export-pass",
      LIGHT_ARGON_PARAMS,
    );
    const bundle: ExportBundle = assembleBundle(key, salt, params, true, {
      folder: [],
    });

    const wrongKey = await deriveKeyWith(
      "wrong-pass",
      Buffer.from(bundle.kdf.salt, "base64"),
      bundleParams(bundle),
    );
    assert.strictEqual(
      verifyBundleCheckToken(wrongKey, bundle.checkToken),
      false,
    );
  });

  it("strip-mode bundle keeps passwordsIncluded=false and emits passwordless nodes", async () => {
    const { key, salt, params } = await deriveNewBundleKey(
      "x".repeat(12),
      LIGHT_ARGON_PARAMS,
    );
    const cfg: CRTConfig = {
      folder: [
        {
          name: "P",
          nodes: [
            { name: "n", endpoint: "u@h", password: "any" },
          ],
        },
      ],
    };
    const { config: stripped } = await mapNodePasswords(cfg, async () => undefined);
    const bundle = assembleBundle(key, salt, params, false, stripped);
    assert.strictEqual(bundle.passwordsIncluded, false);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        bundle.config.folder![0].nodes![0],
        "password",
      ),
      false,
    );
  });
});
