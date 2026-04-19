/**
 * Portable encrypted profile bundle. A single JSON file packages the user's
 * vsCRT config so it can be moved between machines. Passwords are rekeyed
 * under a fresh Argon2id key derived from a bundle passphrase the user picks
 * at export time, so the receiving machine doesn't need the original
 * session passphrase or OS keychain.
 *
 * Bundle shape (vscrt-bundle/v1):
 * {
 *   "format":     "vscrt-bundle/v1",
 *   "createdAt":  "<ISO timestamp>",
 *   "kdf":        { "alg": "argon2id", "t": 4, "m": 65536, "p": 1, "salt": "<base64>" },
 *   "checkToken": "enc:v4:…",           // verifies the bundle passphrase
 *   "passwordsIncluded": true|false,    // false = secrets stripped (auditable)
 *   "config":     { folder: [...] }     // CRTConfig with passwords re-keyed or stripped
 * }
 *
 * All functions in this module are pure (no VS Code / filesystem I/O) so the
 * mocha suite can drive end-to-end round trips.
 */

import { randomBytes } from "crypto";
import {
  ArgonParams,
  DEFAULT_PARAMS,
  deriveKeyWith,
  sealWithKey,
  unsealWithKey,
} from "./vscrtPassphrase";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
} from "./vscrtConfigTypes";

export const BUNDLE_FORMAT = "vscrt-bundle/v1";
const CHECK_PLAINTEXT = "vscrt-bundle-ok";

export interface BundleKdf {
  alg: "argon2id";
  t: number;
  m: number;
  p: number;
  /** Base64. */
  salt: string;
}

export interface ExportBundle {
  format: typeof BUNDLE_FORMAT;
  createdAt: string;
  kdf: BundleKdf;
  /** enc:v4 ciphertext of CHECK_PLAINTEXT under the derived bundle key. */
  checkToken: string;
  passwordsIncluded: boolean;
  config: CRTConfig;
}

export interface BundleDeriveResult {
  key: Buffer;
  salt: Buffer;
  params: ArgonParams;
}

/**
 * Derive a fresh Argon2id key for a NEW export bundle. Generates a random
 * salt and uses `params` (defaults to DEFAULT_PARAMS from the session).
 */
export async function deriveNewBundleKey(
  passphrase: string,
  params: ArgonParams = DEFAULT_PARAMS,
): Promise<BundleDeriveResult> {
  const salt = randomBytes(16);
  const key = await deriveKeyWith(passphrase, salt, params);
  return { key, salt, params };
}

/**
 * Derive the bundle key on the RECEIVING side, using the salt + params that
 * travelled with the bundle.
 */
export async function deriveExistingBundleKey(
  passphrase: string,
  bundle: ExportBundle,
): Promise<Buffer> {
  const salt = Buffer.from(bundle.kdf.salt, "base64");
  return deriveKeyWith(passphrase, salt, bundleParams(bundle));
}

export function bundleParams(bundle: ExportBundle): ArgonParams {
  return { t: bundle.kdf.t, m: bundle.kdf.m, p: bundle.kdf.p };
}

/** Seal the fixed check plaintext so the receiver can verify the passphrase. */
export function makeBundleCheckToken(key: Buffer, params: ArgonParams): string {
  return sealWithKey(key, params, CHECK_PLAINTEXT);
}

export function verifyBundleCheckToken(key: Buffer, token: string): boolean {
  try {
    return unsealWithKey(key, token) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

/**
 * Loose shape check for a parsed JSON candidate. Returns the bundle when it
 * looks right, or an error string. Kept string-based (no throws) so the
 * caller can decide how to surface rejection in the UI.
 */
export function validateBundleShape(
  raw: unknown,
): { bundle: ExportBundle } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Bundle root must be a JSON object." };
  }
  const r = raw as Record<string, unknown>;
  if (r.format !== BUNDLE_FORMAT) {
    return {
      error: `Unsupported bundle format: ${String(r.format)}. Expected ${BUNDLE_FORMAT}.`,
    };
  }
  const kdf = r.kdf;
  if (!kdf || typeof kdf !== "object" || Array.isArray(kdf)) {
    return { error: "Bundle 'kdf' section is missing or not an object." };
  }
  const k = kdf as Record<string, unknown>;
  if (k.alg !== "argon2id") {
    return { error: `Unsupported KDF algorithm: ${String(k.alg)}.` };
  }
  const t = Number(k.t);
  const m = Number(k.m);
  const p = Number(k.p);
  if (!Number.isInteger(t) || t < 1) {
    return { error: "Bundle kdf.t must be a positive integer." };
  }
  if (!Number.isInteger(m) || m < 1) {
    return { error: "Bundle kdf.m must be a positive integer." };
  }
  if (!Number.isInteger(p) || p < 1) {
    return { error: "Bundle kdf.p must be a positive integer." };
  }
  if (typeof k.salt !== "string" || !k.salt) {
    return { error: "Bundle kdf.salt must be a non-empty base64 string." };
  }
  if (typeof r.checkToken !== "string" || !r.checkToken) {
    return { error: "Bundle checkToken is missing." };
  }
  if (typeof r.passwordsIncluded !== "boolean") {
    return { error: "Bundle passwordsIncluded must be a boolean." };
  }
  if (!r.config || typeof r.config !== "object" || Array.isArray(r.config)) {
    return { error: "Bundle config is missing or not an object." };
  }
  return { bundle: raw as ExportBundle };
}

/**
 * Walk every node in the config, invoking `transform` with the current
 * `password` string; the return value replaces it. A return of `undefined`
 * deletes the field (used by strip mode). Modifies a deep clone so the
 * caller's input is untouched; returns the clone plus a count of rekeyed
 * nodes. Non-node fields are left alone.
 */
export async function mapNodePasswords(
  cfg: CRTConfig,
  transform: (pw: string) => Promise<string | undefined>,
): Promise<{ config: CRTConfig; count: number }> {
  const clone: CRTConfig = JSON.parse(JSON.stringify(cfg));
  let count = 0;
  const walk = async (clusters: CRTConfigCluster[]): Promise<void> => {
    for (const c of clusters) {
      if (Array.isArray(c.nodes)) {
        for (const n of c.nodes) {
          if (typeof n.password === "string" && n.password) {
            const next = await transform(n.password);
            if (next === undefined) {
              delete n.password;
            } else if (next !== n.password) {
              n.password = next;
            }
            count += 1;
          }
        }
      }
      if (Array.isArray(c.subfolder)) {
        await walk(c.subfolder);
      }
    }
  };
  if (Array.isArray(clone.folder)) {
    await walk(clone.folder);
  }
  return { config: clone, count };
}

/**
 * Finalise an ExportBundle from already-rekeyed pieces. Small helper so
 * tests can snapshot the structure.
 */
export function assembleBundle(
  key: Buffer,
  salt: Buffer,
  params: ArgonParams,
  passwordsIncluded: boolean,
  config: CRTConfig,
): ExportBundle {
  return {
    format: BUNDLE_FORMAT,
    createdAt: new Date().toISOString(),
    kdf: {
      alg: "argon2id",
      t: params.t,
      m: params.m,
      p: params.p,
      salt: salt.toString("base64"),
    },
    checkToken: makeBundleCheckToken(key, params),
    passwordsIncluded,
    config,
  };
}

/**
 * Also clear out fields that are machine-specific and shouldn't travel —
 * e.g. the `passwordStorage` preference (the receiver decides that), and
 * `password` for nodes whose password wasn't sealable (passphrase session
 * was locked and the user chose strip mode). Kept separate from
 * `mapNodePasswords` so strip and rekey can share the walker but differ on
 * the storage field.
 */
export function stripMachineSpecificFields(cfg: CRTConfig): CRTConfig {
  const clone: CRTConfig = JSON.parse(JSON.stringify(cfg));
  const walk = (clusters: CRTConfigCluster[]): void => {
    for (const c of clusters) {
      if (Array.isArray(c.nodes)) {
        for (const n of c.nodes) {
          delete (n as CRTConfigNode).passwordStorage;
        }
      }
      if (Array.isArray(c.subfolder)) {
        walk(c.subfolder);
      }
    }
  };
  if (Array.isArray(clone.folder)) {
    walk(clone.folder);
  }
  return clone;
}
