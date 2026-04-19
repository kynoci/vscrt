/**
 * Per-render nonce for the webview CSP. Both the connection view and the
 * server form consume this — hoisted out of the per-view HTML loaders so
 * we only have one implementation of the randomness.
 */
export function generateNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
