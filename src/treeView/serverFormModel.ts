/**
 * Types and validation for the add/edit-server form. Pure — no VS Code
 * runtime imports — so the panel lifecycle (serverForm.ts) and the HTML
 * template (serverFormHtml.ts) can share a single source of truth for the
 * shape that travels from webview → host.
 */

import { CRTConfigNode } from "../config/vscrtConfig";

export type ServerFormData = {
  name: string;
  endpoint: string;
  icon?: string;
  /** Per-node override; undefined falls back to user settings. */
  terminalLocation?: "panel" | "editor";
  /** Optional SSH ProxyJump spec: `[user@]host[:port]`, comma-separated for chains. */
  jumpHost?: string;
  /** SSH port-forward flags, each `-L|-R|-D <spec>`. */
  portForwards?: string[];
  /** Env vars for the spawned terminal, KEY → value. */
  env?: Record<string, string>;
  preferredAuthentication: "password" | "publickey";
  /** Plaintext; omitted when editing and the user left the field blank. */
  password?: string;
  passwordStorage?: "secretstorage" | "passphrase";
  identityFile?: string;
  installPublicKeyNow?: boolean;
  oneTimePassword?: string;
};

/**
 * Must match the JSON schema's `jumpHost.pattern` and the client-side
 * `JUMP_HOST_RE` in media/serverForm.js. Exported so the SSH-config
 * importer reuses the single authoritative regex.
 */
export const JUMP_HOST_PATTERN = /^[A-Za-z0-9._@:,[\]-]+$/;

/** Must match the JSON schema's `portForwards.items.pattern`. */
export const PORT_FORWARD_PATTERN = /^-[LRD] [0-9A-Za-z:.[\]/_-]+$/;

/** POSIX env-var name (letters/digits/underscore, can't start with digit). */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ServerFormOptions {
  /**
   * For add mode: the cluster the new server will live under.
   * For edit mode: the cluster of the node being edited.
   */
  targetClusterName: string | null;
  /** When provided, the form opens in EDIT mode pre-filled from this node. */
  existing?: CRTConfigNode;
}

/**
 * Narrow an untrusted payload from the webview into a ServerFormData. The
 * webview's own JavaScript validation runs first; this is the host-side
 * second line of defence so a bad message can't corrupt the config.
 */
export function isValidData(
  data: unknown,
  existing: CRTConfigNode | undefined,
): data is ServerFormData {
  if (!data || typeof data !== "object") {
    return false;
  }
  const d = data as Partial<ServerFormData>;
  if (typeof d.name !== "string" || !d.name.trim()) {
    return false;
  }
  if (typeof d.endpoint !== "string" || !d.endpoint.trim()) {
    return false;
  }
  if (d.icon !== undefined) {
    if (typeof d.icon !== "string" || !/^[a-z0-9-]+$/i.test(d.icon)) {
      return false;
    }
  }
  if (d.terminalLocation !== undefined) {
    if (d.terminalLocation !== "panel" && d.terminalLocation !== "editor") {
      return false;
    }
  }
  if (d.jumpHost !== undefined) {
    if (typeof d.jumpHost !== "string" || !JUMP_HOST_PATTERN.test(d.jumpHost)) {
      return false;
    }
  }
  if (d.portForwards !== undefined) {
    if (!Array.isArray(d.portForwards)) {
      return false;
    }
    for (const fwd of d.portForwards) {
      if (typeof fwd !== "string" || !PORT_FORWARD_PATTERN.test(fwd)) {
        return false;
      }
    }
  }
  if (d.env !== undefined) {
    if (!d.env || typeof d.env !== "object" || Array.isArray(d.env)) {
      return false;
    }
    for (const [k, v] of Object.entries(d.env)) {
      if (!ENV_KEY_PATTERN.test(k) || typeof v !== "string") {
        return false;
      }
    }
  }
  if (
    d.preferredAuthentication !== "password" &&
    d.preferredAuthentication !== "publickey"
  ) {
    return false;
  }
  if (d.preferredAuthentication === "password") {
    // Password is required when adding. On edit, an empty password is fine
    // as long as the node already had a stored one — the handler will keep
    // the existing reference.
    const canReuseExistingPassword =
      !!existing &&
      existing.preferredAuthentication === "password" &&
      !!existing.password;
    if (typeof d.password !== "string" || !d.password) {
      if (!canReuseExistingPassword) {
        return false;
      }
    }
    if (
      d.passwordStorage !== "secretstorage" &&
      d.passwordStorage !== "passphrase"
    ) {
      return false;
    }
  } else {
    if (typeof d.identityFile !== "string" || !d.identityFile.trim()) {
      return false;
    }
    if (d.identityFile.trim().endsWith(".pub")) {
      return false;
    }
    if (
      d.installPublicKeyNow &&
      (typeof d.oneTimePassword !== "string" || !d.oneTimePassword)
    ) {
      return false;
    }
  }
  return true;
}
