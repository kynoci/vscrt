import * as vscode from "vscode";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { argon2idAsync } from "@noble/hashes/argon2";

export const CIPHER_PREFIX_V3 = "enc:v3:";
export const PASSPHRASE_SALT_KEY = "vscrt.passphrase.salt";
export const PASSPHRASE_CHECK_KEY = "vscrt.passphrase.check";

const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const ARGON_OPTS = { t: 3, m: 65536, p: 1 } as const;
const CHECK_PLAINTEXT = "vscrt-passphrase-ok";

export class PassphraseCancelled extends Error {
  constructor() {
    super("vsCRT: passphrase entry cancelled.");
    this.name = "PassphraseCancelled";
  }
}

/**
 * Manages a user-supplied passphrase for encrypting SSH passwords in
 * vscrtConfig.json.  Argon2id derives a 32-byte key from the passphrase and
 * a salt held in SecretStorage; AES-256-GCM encrypts each password with a
 * random 12-byte IV.  The derived key is cached in memory for the life of
 * the extension host (one prompt per VS Code session).
 */
export class CRTPassphraseService {
  private cachedKey: Buffer | undefined;
  private unlockPromise: Promise<Buffer> | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Returns true if a passphrase has been set up for this installation. */
  async isInitialized(): Promise<boolean> {
    const check = await this.secrets.get(PASSPHRASE_CHECK_KEY);
    return !!check;
  }

  /** Forget the cached key; next seal/unseal will re-prompt. */
  lock(): void {
    this.cachedKey = undefined;
    this.unlockPromise = undefined;
  }

  /** Wipe the passphrase setup (salt + check token). Does NOT touch node ciphertexts. */
  async resetSetup(): Promise<void> {
    await this.secrets.delete(PASSPHRASE_SALT_KEY);
    await this.secrets.delete(PASSPHRASE_CHECK_KEY);
    this.lock();
  }

  async seal(plaintext: string): Promise<string> {
    const key = await this.ensureUnlocked();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([ct, tag]);
    return `${CIPHER_PREFIX_V3}${iv.toString("base64")}:${payload.toString("base64")}`;
  }

  async unseal(stored: string): Promise<string> {
    if (!stored.startsWith(CIPHER_PREFIX_V3)) {
      throw new Error("vsCRT: not an enc:v3 ciphertext.");
    }
    const body = stored.slice(CIPHER_PREFIX_V3.length);
    const parts = body.split(":");
    if (parts.length !== 2) {
      throw new Error("vsCRT: malformed enc:v3 ciphertext.");
    }
    const iv = Buffer.from(parts[0], "base64");
    const payload = Buffer.from(parts[1], "base64");
    if (iv.length !== IV_LENGTH || payload.length < 16) {
      throw new Error("vsCRT: malformed enc:v3 ciphertext.");
    }
    const tag = payload.subarray(payload.length - 16);
    const ct = payload.subarray(0, payload.length - 16);
    const key = await this.ensureUnlocked();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  }

  private ensureUnlocked(): Promise<Buffer> {
    if (this.cachedKey) {
      return Promise.resolve(this.cachedKey);
    }
    if (!this.unlockPromise) {
      this.unlockPromise = this.unlock().finally(() => {
        this.unlockPromise = undefined;
      });
    }
    return this.unlockPromise;
  }

  private async unlock(): Promise<Buffer> {
    const saltRaw = await this.secrets.get(PASSPHRASE_SALT_KEY);
    const checkToken = await this.secrets.get(PASSPHRASE_CHECK_KEY);
    const firstTime = !saltRaw || !checkToken;

    const salt = firstTime
      ? randomBytes(SALT_LENGTH)
      : Buffer.from(saltRaw, "base64");

    const passphrase = firstTime
      ? await this.promptNewPassphrase()
      : await this.promptExistingPassphrase();

    const key = await this.deriveKey(passphrase, salt);

    if (firstTime) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([
        cipher.update(CHECK_PLAINTEXT, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      const check = `${iv.toString("base64")}:${Buffer.concat([ct, tag]).toString("base64")}`;
      await this.secrets.store(PASSPHRASE_SALT_KEY, salt.toString("base64"));
      await this.secrets.store(PASSPHRASE_CHECK_KEY, check);
    } else {
      this.verifyCheckToken(key, checkToken!);
    }

    this.cachedKey = key;
    return key;
  }

  private verifyCheckToken(key: Buffer, token: string): void {
    const parts = token.split(":");
    if (parts.length !== 2) {
      throw new Error("vsCRT: passphrase check token corrupted.");
    }
    const iv = Buffer.from(parts[0], "base64");
    const payload = Buffer.from(parts[1], "base64");
    const tag = payload.subarray(payload.length - 16);
    const ct = payload.subarray(0, payload.length - 16);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
      if (pt !== CHECK_PLAINTEXT) {
        throw new Error("mismatch");
      }
    } catch {
      throw new Error("vsCRT: incorrect passphrase.");
    }
  }

  private async promptNewPassphrase(): Promise<string> {
    const first = await vscode.window.showInputBox({
      title: "vsCRT: Set Passphrase",
      prompt:
        "Set a passphrase to encrypt passwords stored in vscrtConfig.json (required once).",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.length < 8 ? "Minimum 8 characters." : null),
    });
    if (!first) {
      throw new PassphraseCancelled();
    }
    const second = await vscode.window.showInputBox({
      title: "vsCRT: Confirm Passphrase",
      prompt: "Re-enter the passphrase to confirm.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v === first ? null : "Passphrases do not match."),
    });
    if (second === undefined) {
      throw new PassphraseCancelled();
    }
    return first;
  }

  private async promptExistingPassphrase(): Promise<string> {
    const entry = await vscode.window.showInputBox({
      title: "vsCRT: Unlock Passphrase",
      prompt: "Enter your vsCRT passphrase to decrypt stored passwords.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!entry) {
      throw new PassphraseCancelled();
    }
    return entry;
  }

  private async deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
    const derived = await argon2idAsync(passphrase, salt, {
      ...ARGON_OPTS,
      dkLen: KEY_LENGTH,
    });
    return Buffer.from(derived);
  }
}
