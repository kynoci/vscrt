import { CRTConfigNode } from "../config/vscrtConfig";

type ResolvedAuthMode = "publickey" | "password-auto" | "password-manual";
export function resolveAuthMode(node: CRTConfigNode): ResolvedAuthMode {
  const preferred = node.preferredAuthentication?.trim();
  const hasPassword = !!node.password?.trim();

  if (preferred === "publickey") {
    return "publickey";
  }

  if (preferred === "password") {
    return hasPassword ? "password-auto" : "password-manual";
  }

  return "password-manual";
}
