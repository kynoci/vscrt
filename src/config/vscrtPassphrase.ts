import * as vscode from "vscode";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { argon2idAsync } from "@noble/hashes/argon2";
import { log } from "../log";
import { scorePassphrase } from "./passwordStrength";

export const CIPHER_PREFIX_V3 = "enc:v3:";
export const CIPHER_PREFIX_V4 = "enc:v4:";
export const PASSPHRASE_SALT_KEY = "vscrt.passphrase.salt";
export const PASSPHRASE_CHECK_KEY = "vscrt.passphrase.check";

const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const MIN_PASSPHRASE_LENGTH = 12;
const CHECK_PLAINTEXT = "vscrt-passphrase-ok";

export interface ArgonParams {
  t: number;
  m: number;
  p: number;
}

/**
 * Argon2id parameters used for **first-time** enrolment on new installs.
 * Existing users stay on whatever params their original check token was
 * created with (embedded in the v4 ciphertext or implicit from v3) so the
 * cached session key continues to match their blobs. Rotating to new
 * params requires "vsCRT: Reset Passphrase Setup" (which wipes the check
 * token so the next unlock re-enrols at these defaults).
 */
export const DEFAULT_PARAMS: ArgonParams = { t: 4, m: 65536, p: 1 };

/**
 * Implicit Argon2id parameters for any ciphertext written under the v3
 * format (which never embedded parameters). Equal to the hardcoded values
 * the pre-v4 code used.
 */
export const V3_PARAMS: ArgonParams = { t: 3, m: 65536, p: 1 };

import { PassphraseCancelled } from "./vscrtPassphraseErrors";
export { PassphraseCancelled };

/* -----------------------------------------------------------------------
 *   AUTO-LOCK
 * --------------------------------------------------------------------- */

export type AutoLockMode =
  | "never"
  | "5min"
  | "15min"
  | "30min"
  | "1hour"
  | "onFocusLost";

const AUTO_LOCK_MODES: readonly AutoLockMode[] = [
  "never",
  "5min",
  "15min",
  "30min",
  "1hour",
  "onFocusLost",
];

/**
 * Coerce a settings string into a valid AutoLockMode, defaulting to
 * `"15min"` on unknown / undefined values. Used by both the extension
 * activator and tests that exercise the parse path.
 */
export function parseAutoLockMode(raw: string | undefined): AutoLockMode {
  return AUTO_LOCK_MODES.includes(raw as AutoLockMode)
    ? (raw as AutoLockMode)
    : "15min";
}

/**
 * Convert an AutoLockMode into its idle-timeout in milliseconds. Returns
 * `undefined` for modes that don't use the timer (`never`, `onFocusLost`).
 */
export function autoLockModeToMs(mode: AutoLockMode): number | undefined {
  switch (mode) {
    case "5min":
      return 5 * 60_000;
    case "15min":
      return 15 * 60_000;
    case "30min":
      return 30 * 60_000;
    case "1hour":
      return 60 * 60_000;
    default:
      return undefined;
  }
}

/**
 * Clock seam for the idle timer. The service defaults to Node's setTimeout
 * / clearTimeout; tests inject a fake clock to drive the timer without
 * real delays.
 */
export interface Clock {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_CLOCK: Clock = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface PassphraseServiceOptions {
  clock?: Clock;
}

export interface ParsedCiphertext {
  version: "v3" | "v4";
  params: ArgonParams;
  iv: Buffer;
  /** AES-GCM ciphertext followed by the 16-byte auth tag. */
  payload: Buffer;
}

/**
 * Parse either a v3 or v4 passphrase-encrypted ciphertext. v3 carries no
 * parameter block (they are implicit V3_PARAMS); v4 encodes t, m, and p.
 */
export function parseCiphertext(stored: string): ParsedCiphertext {
  if (stored.startsWith(CIPHER_PREFIX_V4)) {
    const body = stored.slice(CIPHER_PREFIX_V4.length);
    const parts = body.split(":");
    if (parts.length !== 3) {
      throw new Error("vsCRT: malformed enc:v4 ciphertext.");
    }
    const params = parseArgonParams(parts[0]);
    const iv = Buffer.from(parts[1], "base64");
    const payload = Buffer.from(parts[2], "base64");
    if (iv.length !== IV_LENGTH || payload.length < GCM_TAG_LENGTH) {
      throw new Error("vsCRT: malformed enc:v4 ciphertext.");
    }
    return { version: "v4", params, iv, payload };
  }
  if (stored.startsWith(CIPHER_PREFIX_V3)) {
    const body = stored.slice(CIPHER_PREFIX_V3.length);
    const parts = body.split(":");
    if (parts.length !== 2) {
      throw new Error("vsCRT: malformed enc:v3 ciphertext.");
    }
    const iv = Buffer.from(parts[0], "base64");
    const payload = Buffer.from(parts[1], "base64");
    if (iv.length !== IV_LENGTH || payload.length < GCM_TAG_LENGTH) {
      throw new Error("vsCRT: malformed enc:v3 ciphertext.");
    }
    return { version: "v3", params: V3_PARAMS, iv, payload };
  }
  throw new Error("vsCRT: not an enc:v3 or enc:v4 ciphertext.");
}

/**
 * Emit a v4 ciphertext string embedding the Argon2id parameters the key
 * was derived with. New seals always use this format; v3 is read-only.
 */
export function encodeCiphertextV4(
  params: ArgonParams,
  iv: Buffer,
  payload: Buffer,
): string {
  const paramStr = `t=${params.t},m=${params.m},p=${params.p}`;
  return `${CIPHER_PREFIX_V4}${paramStr}:${iv.toString("base64")}:${payload.toString("base64")}`;
}

function parseArgonParams(s: string): ArgonParams {
  let t: number | undefined;
  let m: number | undefined;
  let p: number | undefined;
  for (const field of s.split(",")) {
    const eq = field.indexOf("=");
    if (eq <= 0) {
      throw new Error("vsCRT: malformed Argon2id params.");
    }
    const key = field.slice(0, eq);
    const raw = field.slice(eq + 1);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`vsCRT: bad Argon2id param '${key}'.`);
    }
    if (key === "t") {
      t = value;
    } else if (key === "m") {
      m = value;
    } else if (key === "p") {
      p = value;
    } else {
      throw new Error(`vsCRT: unknown Argon2id param '${key}'.`);
    }
  }
  if (t === undefined || m === undefined || p === undefined) {
    throw new Error("vsCRT: missing Argon2id params.");
  }
  return { t, m, p };
}

export function argonParamsEqual(a: ArgonParams, b: ArgonParams): boolean {
  return a.t === b.t && a.m === b.m && a.p === b.p;
}

/** Read `vsCRT.passphraseMinStrength` from settings, clamped to 0..4. */
function readMinStrengthSetting(): number {
  const raw = vscode.workspace
    .getConfiguration("vsCRT")
    .get<number>("passphraseMinStrength");
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 3;
  }
  return Math.max(0, Math.min(4, Math.floor(raw)));
}

/**
 * Argon2id wrapper used both by the session service and by export bundles
 * that need to derive a key from an arbitrary user-supplied passphrase.
 */
export async function deriveKeyWith(
  passphrase: string,
  salt: Buffer,
  params: ArgonParams,
): Promise<Buffer> {
  const derived = await argon2idAsync(passphrase, salt, {
    t: params.t,
    m: params.m,
    p: params.p,
    dkLen: KEY_LENGTH,
  });
  return Buffer.from(derived);
}

/**
 * Seal a plaintext under an arbitrary key + params, returning an enc:v4
 * ciphertext string. Pure — no session state touched. The caller owns the
 * key and is responsible for its lifetime.
 */
export function sealWithKey(
  key: Buffer,
  params: ArgonParams,
  plaintext: string,
): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return encodeCiphertextV4(params, iv, Buffer.concat([ct, tag]));
}

/**
 * Unseal any v3 or v4 ciphertext under an arbitrary key. Throws when the
 * key is wrong (AES-GCM auth tag mismatch) or the format is malformed.
 * Pure — no session state touched.
 */
export function unsealWithKey(key: Buffer, stored: string): string {
  const parsed = parseCiphertext(stored);
  const tag = parsed.payload.subarray(parsed.payload.length - GCM_TAG_LENGTH);
  const ct = parsed.payload.subarray(
    0,
    parsed.payload.length - GCM_TAG_LENGTH,
  );
  const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// Retained internal alias so existing call sites keep reading naturally.
const paramsEqual = argonParamsEqual;

/** Keys and params involved in a KDF rotation. */
export interface RotationKeys {
  oldKey: Buffer;
  oldParams: ArgonParams;
  newKey: Buffer;
  newParams: ArgonParams;
}

/**
 * Re-encrypt an already-encrypted ciphertext under a new key + params.
 * Pure function: decrypts with `oldKey` (using the params embedded in
 * `stored`), re-encrypts with `newKey` + `newParams`, returns an enc:v4
 * string. AES-GCM auth on decrypt guards against a wrong oldKey.
 */
export function reencryptBlob(
  stored: string,
  oldKey: Buffer,
  newKey: Buffer,
  newParams: ArgonParams,
): string {
  const parsed = parseCiphertext(stored);
  const tag = parsed.payload.subarray(parsed.payload.length - GCM_TAG_LENGTH);
  const ct = parsed.payload.subarray(
    0,
    parsed.payload.length - GCM_TAG_LENGTH,
  );
  const decipher = createDecipheriv("aes-256-gcm", oldKey, parsed.iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ct),
    decipher.final(),
  ]).toString("utf8");

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", newKey, iv);
  const newCt = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const newTag = cipher.getAuthTag();
  return encodeCiphertextV4(
    newParams,
    iv,
    Buffer.concat([newCt, newTag]),
  );
}

/**
 * Manages a user-supplied passphrase for encrypting SSH passwords in
 * vscrtConfig.json. Argon2id derives a 32-byte key from the passphrase
 * and a salt held in SecretStorage; AES-256-GCM encrypts each password
 * with a random 12-byte IV. The derived key is cached in memory for the
 * life of the extension host (one prompt per VS Code session). Argon2id
 * parameters live in the ciphertext itself (enc:v4) so rotating them
 * doesn't break old blobs.
 */
export class CRTPassphraseService {
  private cachedKey: Buffer | undefined;
  private cachedParams: ArgonParams | undefined;
  private unlockPromise: Promise<Buffer> | undefined;

  /** Idle auto-lock timer. Undefined when no timer is scheduled. */
  private idleTimer: unknown | undefined;
  /** Current idle-lock timeout in ms, or undefined for "no time-based lock". */
  private idleTimeoutMs: number | undefined;
  private readonly clock: Clock;

  /**
   * Fires whenever the session transitions between locked and unlocked
   * (including initial first-time setup and resetSetup wipes). Consumers
   * like the status bar subscribe to re-read `isInitialized()` and
   * `getCachedParams()` without polling.
   */
  private readonly _onDidChangeLockState = new vscode.EventEmitter<void>();
  readonly onDidChangeLockState = this._onDidChangeLockState.event;

  /**
   * @param secrets VS Code SecretStorage instance for the salt + check token.
   * @param defaultParams Argon2id parameters to enrol new installs with.
   *   Existing users ignore this (their params come from the check token).
   *   Test-only: tests pass light params (t=1, m=8) to keep Argon2id fast.
   * @param options Optional injection seams. `options.clock` lets tests
   *   drive the idle timer deterministically.
   */
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly defaultParams: ArgonParams = DEFAULT_PARAMS,
    options: PassphraseServiceOptions = {},
  ) {
    this.clock = options.clock ?? DEFAULT_CLOCK;
  }

  /** Returns true if a passphrase has been set up for this installation. */
  async isInitialized(): Promise<boolean> {
    const check = await this.secrets.get(PASSPHRASE_CHECK_KEY);
    return !!check;
  }

  /**
   * Argon2id parameters the session key was derived with, or `undefined`
   * when the service is locked. Useful for UIs that want to decide
   * whether a rotation is needed without forcing an unlock prompt.
   */
  getCachedParams(): ArgonParams | undefined {
    return this.cachedParams;
  }

  /**
   * Argon2id parameters stored on disk (read from the check token) without
   * unlocking the session. Returns `undefined` if no passphrase is set up
   * or the check token is corrupt.
   */
  async getStoredParams(): Promise<ArgonParams | undefined> {
    const raw = await this.secrets.get(PASSPHRASE_CHECK_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return parseCheckToken(raw).params;
    } catch {
      return undefined;
    }
  }

  /** Forget the cached key; next seal/unseal will re-prompt. */
  lock(): void {
    const wasUnlocked = this.cachedKey !== undefined;
    this.cachedKey = undefined;
    this.cachedParams = undefined;
    this.unlockPromise = undefined;
    this.clearIdleTimer();
    if (wasUnlocked) {
      this._onDidChangeLockState.fire();
    }
  }

  /**
   * Configure the idle-based auto-lock. Pass `undefined` to disable
   * time-based auto-lock (e.g. when switching to `onFocusLost` mode or
   * `never`). Safe to call at any point — if the service is currently
   * unlocked, the new timeout takes effect immediately.
   */
  setIdleTimeout(ms: number | undefined): void {
    this.idleTimeoutMs = ms;
    if (ms === undefined) {
      this.clearIdleTimer();
      return;
    }
    // Start a fresh timer only if currently unlocked — otherwise wait
    // until the next successful unlock.
    if (this.cachedKey) {
      this.resetIdleTimer();
    }
  }

  private pokeActivity(): void {
    if (this.cachedKey && this.idleTimeoutMs !== undefined) {
      this.resetIdleTimer();
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    const ms = this.idleTimeoutMs;
    if (ms === undefined || !this.cachedKey) {
      return;
    }
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = undefined;
      // Capture the timeout value before lock() runs, since lock() clears it.
      const firedMs = ms;
      const wasUnlocked = !!this.cachedKey;
      this.lock();
      if (wasUnlocked) {
        const minutes = Math.round(firedMs / 60_000);
        const label = minutes === 1 ? "1 minute" : `${minutes} minutes`;
        log.info(
          `Passphrase auto-locked after ${label} of inactivity.`,
        );
        vscode.window.showInformationMessage(
          `vsCRT: passphrase auto-locked after ${label} of inactivity. Next use will prompt.`,
        );
      }
    }, ms);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      this.clock.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Wipe the passphrase setup (salt + check token). Does NOT touch node ciphertexts. */
  async resetSetup(): Promise<void> {
    await this.secrets.delete(PASSPHRASE_SALT_KEY);
    await this.secrets.delete(PASSPHRASE_CHECK_KEY);
    this.lock();
    // lock() fires the event only if it was unlocked; also fire to surface
    // the "not initialised" transition for the status bar.
    this._onDidChangeLockState.fire();
  }

  /**
   * Phase 1 of a KDF rotation. Prompts for the existing passphrase,
   * derives the current session key under the on-disk params (verified
   * against the check token), then derives a second key under
   * `newParams` from the same passphrase + salt. Does NOT write the
   * check token or mutate session state — the caller must walk the
   * config, re-encrypt blobs with the returned keys, and then call
   * `commitRotation`.
   *
   * Throws `PassphraseCancelled` if the user dismisses the prompt,
   * "incorrect passphrase" on a bad passphrase, or "not set up" if no
   * check token exists.
   */
  async deriveKeysForRotation(newParams: ArgonParams): Promise<RotationKeys> {
    const saltRaw = await this.secrets.get(PASSPHRASE_SALT_KEY);
    const checkTokenRaw = await this.secrets.get(PASSPHRASE_CHECK_KEY);
    if (!saltRaw || !checkTokenRaw) {
      throw new Error("vsCRT: passphrase not set up; nothing to rotate.");
    }
    const salt = Buffer.from(saltRaw, "base64");
    const parsedCheck = parseCheckToken(checkTokenRaw);
    const passphrase = await this.promptExistingPassphrase();
    const oldKey = await this.deriveKey(passphrase, salt, parsedCheck.params);
    verifyCheckToken(oldKey, parsedCheck);
    const newKey = await this.deriveKey(passphrase, salt, newParams);
    return {
      oldKey,
      oldParams: parsedCheck.params,
      newKey,
      newParams,
    };
  }

  /**
   * Phase 2 of a KDF rotation. Rewrites the check token under the new
   * key + params and swaps the in-memory session state so subsequent
   * seal/unseal operations use the new key. Call only after every blob
   * has been successfully re-encrypted and persisted.
   */
  async commitRotation(newKey: Buffer, newParams: ArgonParams): Promise<void> {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", newKey, iv);
    const ct = Buffer.concat([
      cipher.update(CHECK_PLAINTEXT, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const upgraded = encodeCiphertextV4(
      newParams,
      iv,
      Buffer.concat([ct, tag]),
    );
    await this.secrets.store(PASSPHRASE_CHECK_KEY, upgraded);
    this.cachedKey = newKey;
    this.cachedParams = newParams;
    this.unlockPromise = undefined;
    this.resetIdleTimer();
    this._onDidChangeLockState.fire();
  }

  async seal(plaintext: string): Promise<string> {
    const key = await this.ensureUnlocked();
    const params = this.cachedParams;
    if (!params) {
      // Should be unreachable: ensureUnlocked sets both key and params.
      throw new Error("vsCRT: passphrase not unlocked.");
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([ct, tag]);
    this.pokeActivity();
    return encodeCiphertextV4(params, iv, payload);
  }

  async unseal(stored: string): Promise<string> {
    const parsed = parseCiphertext(stored);
    const key = await this.ensureUnlocked();
    const sessionParams = this.cachedParams;
    if (!sessionParams || !paramsEqual(parsed.params, sessionParams)) {
      throw new Error(
        "vsCRT: ciphertext uses different KDF parameters than the current passphrase. Use 'vsCRT: Reset Passphrase Setup' to re-enrol at the new parameters.",
      );
    }
    const tag = parsed.payload.subarray(parsed.payload.length - GCM_TAG_LENGTH);
    const ct = parsed.payload.subarray(
      0,
      parsed.payload.length - GCM_TAG_LENGTH,
    );
    const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    this.pokeActivity();
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
    const checkTokenRaw = await this.secrets.get(PASSPHRASE_CHECK_KEY);
    const firstTime = !saltRaw || !checkTokenRaw;

    if (firstTime) {
      return this.unlockFirstTime();
    }
    return this.unlockExisting(saltRaw, checkTokenRaw);
  }

  private async unlockFirstTime(): Promise<Buffer> {
    const salt = randomBytes(SALT_LENGTH);
    const passphrase = await this.promptNewPassphrase();
    const params = this.defaultParams;
    const key = await this.deriveKey(passphrase, salt, params);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([
      cipher.update(CHECK_PLAINTEXT, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const checkToken = encodeCiphertextV4(
      params,
      iv,
      Buffer.concat([ct, tag]),
    );
    await this.secrets.store(PASSPHRASE_SALT_KEY, salt.toString("base64"));
    await this.secrets.store(PASSPHRASE_CHECK_KEY, checkToken);
    this.cachedParams = params;
    this.cachedKey = key;
    this.resetIdleTimer();
    this._onDidChangeLockState.fire();
    return key;
  }

  private async unlockExisting(
    saltRaw: string,
    checkTokenRaw: string,
  ): Promise<Buffer> {
    const salt = Buffer.from(saltRaw, "base64");
    const parsedCheck = parseCheckToken(checkTokenRaw);
    const passphrase = await this.promptExistingPassphrase();
    const key = await this.deriveKey(passphrase, salt, parsedCheck.params);
    verifyCheckToken(key, parsedCheck);
    this.cachedParams = parsedCheck.params;
    this.cachedKey = key;
    this.resetIdleTimer();
    this._onDidChangeLockState.fire();

    // Legacy (pre-v4) check tokens get rewritten in v4 format — same
    // params, just a richer wrapper — so subsequent unlocks can parse
    // params directly without the heuristic in parseCheckToken.
    if (parsedCheck.version === "v3") {
      await this.rewriteCheckTokenAsV4(key, parsedCheck.params);
    }

    return key;
  }

  private async rewriteCheckTokenAsV4(
    key: Buffer,
    params: ArgonParams,
  ): Promise<void> {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([
      cipher.update(CHECK_PLAINTEXT, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const upgraded = encodeCiphertextV4(
      params,
      iv,
      Buffer.concat([ct, tag]),
    );
    await this.secrets.store(PASSPHRASE_CHECK_KEY, upgraded);
  }

  private async promptNewPassphrase(): Promise<string> {
    const minStrength = readMinStrengthSetting();
    const first = await vscode.window.showInputBox({
      title: "vsCRT: Set Passphrase",
      prompt:
        "Set a passphrase to encrypt passwords stored in vscrtConfig.json (required once).",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (v.length < MIN_PASSPHRASE_LENGTH) {
          return `Minimum ${MIN_PASSPHRASE_LENGTH} characters.`;
        }
        const result = scorePassphrase(v);
        if (result.score < minStrength) {
          return `Strength: ${result.label}. ${result.suggestion ?? "Choose a stronger passphrase."}`;
        }
        // Show live feedback even when the password passes — validateInput
        // returning null suppresses the message, so surface scores ≥ min
        // via the items's own mechanism. VS Code renders the string as
        // a hint; returning null means "no problem". Below is a no-op
        // when the score is high enough.
        return null;
      },
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

  private async deriveKey(
    passphrase: string,
    salt: Buffer,
    params: ArgonParams,
  ): Promise<Buffer> {
    const derived = await argon2idAsync(passphrase, salt, {
      t: params.t,
      m: params.m,
      p: params.p,
      dkLen: KEY_LENGTH,
    });
    return Buffer.from(derived);
  }
}

/**
 * Parse a check token from SecretStorage. Handles three formats:
 *   1. `enc:v4:t=…,m=…,p=…:<iv>:<ct+tag>` — current format.
 *   2. `enc:v3:<iv>:<ct+tag>` — a v3 ciphertext stored as check token
 *      (never actually used by prior versions but parsed defensively).
 *   3. `<iv>:<ct+tag>` — the legacy pre-v4 format with no prefix.
 *      Implicit V3_PARAMS.
 */
function parseCheckToken(raw: string): ParsedCiphertext {
  if (
    raw.startsWith(CIPHER_PREFIX_V4) ||
    raw.startsWith(CIPHER_PREFIX_V3)
  ) {
    return parseCiphertext(raw);
  }
  const parts = raw.split(":");
  if (parts.length !== 2) {
    throw new Error("vsCRT: passphrase check token corrupted.");
  }
  const iv = Buffer.from(parts[0], "base64");
  const payload = Buffer.from(parts[1], "base64");
  if (iv.length !== IV_LENGTH || payload.length < GCM_TAG_LENGTH) {
    throw new Error("vsCRT: passphrase check token corrupted.");
  }
  return { version: "v3", params: V3_PARAMS, iv, payload };
}

function verifyCheckToken(key: Buffer, parsed: ParsedCiphertext): void {
  const tag = parsed.payload.subarray(parsed.payload.length - GCM_TAG_LENGTH);
  const ct = parsed.payload.subarray(
    0,
    parsed.payload.length - GCM_TAG_LENGTH,
  );
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8",
    );
    if (pt !== CHECK_PLAINTEXT) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error("vsCRT: incorrect passphrase.");
  }
}
