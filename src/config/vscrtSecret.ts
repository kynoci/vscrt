import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { CIPHER_PREFIX_V3, CRTPassphraseService } from "./vscrtPassphrase";

export const SECRET_PREFIX = "@secret:";
export const CIPHER_PREFIX = "enc:v1:"; // reserved for v2
export const SECRET_KEY_PREFIX = "vscrt.password.";
export const SECRET_INDEX_KEY = "vscrt.password._ids";

export type SealMode = "secretstorage" | "passphrase";

/**
 * Stores SSH passwords outside of vscrtConfig.json, in VS Code's
 * SecretStorage (backed by Windows Credential Manager, macOS Keychain,
 * or libsecret on Linux).  The JSON file only carries opaque references
 * of the form "@secret:<uuid>" after migration.
 */
export class CRTSecretService {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly passphrase?: CRTPassphraseService,
  ) {}

  /**
   * Store plaintext and return a reference/ciphertext.
   * `mode` defaults to "secretstorage" (produces "@secret:<uuid>").
   * "passphrase" produces "enc:v3:<iv>:<ct>" and requires a passphrase service.
   */
  async seal(plaintext: string, mode: SealMode = "secretstorage"): Promise<string> {
    if (mode === "passphrase") {
      if (!this.passphrase) {
        throw new Error("vsCRT: passphrase service not available.");
      }
      return this.passphrase.seal(plaintext);
    }
    const id = randomUUID();
    await this.secrets.store(SECRET_KEY_PREFIX + id, plaintext);
    await this.addToIndex(id);
    return SECRET_PREFIX + id;
  }

  /** Resolve any password form (ref / ciphertext / plaintext / undefined) to plaintext. */
  async unseal(stored: string | undefined): Promise<string | undefined> {
    if (!stored) {
      return undefined;
    }
    if (stored.startsWith(SECRET_PREFIX)) {
      const id = stored.slice(SECRET_PREFIX.length);
      return this.secrets.get(SECRET_KEY_PREFIX + id);
    }
    if (stored.startsWith(CIPHER_PREFIX_V3)) {
      if (!this.passphrase) {
        throw new Error(
          "vsCRT: passphrase service unavailable; cannot decrypt enc:v3.",
        );
      }
      return this.passphrase.unseal(stored);
    }
    if (stored.startsWith(CIPHER_PREFIX)) {
      throw new Error(
        "vsCRT: enc:v1 ciphertext form is reserved for a future version.",
      );
    }
    return stored;
  }

  isReference(stored: string | undefined): boolean {
    return !!stored && stored.startsWith(SECRET_PREFIX);
  }

  isPassphraseCiphertext(stored: string | undefined): boolean {
    return !!stored && stored.startsWith(CIPHER_PREFIX_V3);
  }

  isLegacyPlaintext(stored: string | undefined): boolean {
    if (!stored) {
      return false;
    }
    if (stored.startsWith(SECRET_PREFIX)) {
      return false;
    }
    if (stored.startsWith(CIPHER_PREFIX)) {
      return false;
    }
    if (stored.startsWith(CIPHER_PREFIX_V3)) {
      return false;
    }
    return true;
  }

  /** Delete the backing secret for a "@secret:<id>" reference. */
  async forget(stored: string | undefined): Promise<void> {
    if (!stored || !stored.startsWith(SECRET_PREFIX)) {
      return;
    }
    const id = stored.slice(SECRET_PREFIX.length);
    try {
      await this.secrets.delete(SECRET_KEY_PREFIX + id);
    } catch {
      // best-effort
    }
    await this.removeFromIndex(id);
  }

  /** Delete every vsCRT secret whose id is not in `keepRefs`. */
  async pruneOrphans(keepRefs: string[]): Promise<void> {
    const keepIds = new Set(
      keepRefs
        .filter((r) => r.startsWith(SECRET_PREFIX))
        .map((r) => r.slice(SECRET_PREFIX.length)),
    );
    const ids = await this.readIndex();
    const survivors: string[] = [];
    for (const id of ids) {
      if (keepIds.has(id)) {
        survivors.push(id);
        continue;
      }
      try {
        await this.secrets.delete(SECRET_KEY_PREFIX + id);
      } catch {
        // best-effort
      }
    }
    if (survivors.length !== ids.length) {
      await this.writeIndex(survivors);
    }
  }

  /** Emergency wipe of every vsCRT secret. */
  async clearAll(): Promise<void> {
    const ids = await this.readIndex();
    for (const id of ids) {
      try {
        await this.secrets.delete(SECRET_KEY_PREFIX + id);
      } catch {
        // best-effort
      }
    }
    await this.writeIndex([]);
  }

  private async readIndex(): Promise<string[]> {
    const raw = await this.secrets.get(SECRET_INDEX_KEY);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  }

  private async writeIndex(ids: string[]): Promise<void> {
    await this.secrets.store(SECRET_INDEX_KEY, JSON.stringify(ids));
  }

  private async addToIndex(id: string): Promise<void> {
    const ids = await this.readIndex();
    if (!ids.includes(id)) {
      ids.push(id);
      await this.writeIndex(ids);
    }
  }

  private async removeFromIndex(id: string): Promise<void> {
    const ids = await this.readIndex();
    const filtered = ids.filter((x) => x !== id);
    if (filtered.length !== ids.length) {
      await this.writeIndex(filtered);
    }
  }
}
