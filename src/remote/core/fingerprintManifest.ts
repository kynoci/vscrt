/**
 * A fingerprint manifest is a top-level `knownFingerprints` array in
 * vscrtConfig.json (or a separate JSON file). Each entry pins a
 * known-good SHA-256 fingerprint for a host:port pair, so the
 * connect-path TOFU prompt can auto-accept when the live fingerprint
 * matches.
 *
 * Enterprise use case: IT ships a `fingerprints.json` alongside the
 * config, the first-time-TOFU clicks collapse to zero for audited
 * fleets.
 *
 * Pure: no VS Code imports, no I/O. File loading is the caller's
 * problem; the helpers here just validate shape + compare.
 */

export interface FingerprintEntry {
  host: string;
  port?: number;
  /** Full OpenSSH fingerprint including the `SHA256:` prefix. */
  sha256: string;
  comment?: string;
}

export interface ManifestLookupResult {
  matched: boolean;
  entry?: FingerprintEntry;
  /** When `matched` is false but the host IS in the manifest under a
   *  different fingerprint, this is the known-good fingerprint so the
   *  UI can warn the user "the manifest expected X; server presents Y". */
  mismatchedEntry?: FingerprintEntry;
}

/** Validate one entry's shape. Returns null on bad input. */
export function isValidEntry(raw: unknown): raw is FingerprintEntry {
  if (!raw || typeof raw !== "object") {return false;}
  const r = raw as Record<string, unknown>;
  if (typeof r.host !== "string" || r.host.length === 0) {return false;}
  if (r.port !== undefined) {
    if (typeof r.port !== "number" || !Number.isInteger(r.port)) {return false;}
    if (r.port < 1 || r.port > 65535) {return false;}
  }
  if (typeof r.sha256 !== "string" || !/^SHA256:[A-Za-z0-9+/=]+$/.test(r.sha256)) {
    return false;
  }
  if (r.comment !== undefined && typeof r.comment !== "string") {return false;}
  return true;
}

/** Filter a raw JSON-parsed array to valid entries. */
export function sanitiseManifest(raw: unknown): FingerprintEntry[] {
  if (!Array.isArray(raw)) {return [];}
  return raw.filter(isValidEntry);
}

/**
 * Look up a host:port pair against the manifest. Port match is loose:
 * entries with no port match any port (acts as a default), entries
 * with a port only match exactly. Returns the matched entry or the
 * host's different-fingerprint entry for caller-side "that changed"
 * messaging.
 */
export function lookupFingerprint(
  manifest: readonly FingerprintEntry[],
  host: string,
  port: number,
  liveFingerprint: string,
): ManifestLookupResult {
  const candidates = manifest.filter((e) => {
    if (e.host !== host) {return false;}
    if (e.port !== undefined && e.port !== port) {return false;}
    return true;
  });
  if (candidates.length === 0) {
    return { matched: false };
  }
  const exact = candidates.find((e) => e.sha256 === liveFingerprint);
  if (exact) {
    return { matched: true, entry: exact };
  }
  // Host is pinned but to a different fingerprint — deliberately do NOT
  // treat as "unknown". The caller should surface a MITM/rotation
  // warning rather than the plain TOFU prompt.
  return {
    matched: false,
    mismatchedEntry: candidates[0],
  };
}
