#!/usr/bin/env node
/**
 * Derive the in-extension Help panel's content from package.json
 * (commands + settings + keybindings) and the JSON schema. Runs at
 * build time so the panel stays in sync with the manifest without
 * manual editing.
 *
 * Output: media/help-content.json (consumed by media/help.js).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const pkgPath = join(repoRoot, "package.json");
const outPath = join(repoRoot, "media", "help-content.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

function groupKey(title) {
  // Group by prefix before the first colon. "vsCRT: Connect (SSH)" → "Connect".
  const stripped = title.replace(/^vsCRT:\s*/i, "");
  const first = stripped.split(" ")[0];
  if (/^(Connect|Quick|Test|Run)/i.test(first)) return "Connection";
  if (/^(Add|Edit|Duplicate|Rename|Delete)/i.test(first)) return "Server & folder management";
  if (/^(Change|Lock|Reset|Rotate|Generate|Remove)/i.test(first)) return "Credentials & crypto";
  if (/^(Open|Refresh|Show|Validate|Restore|Import|Export|Vault)/i.test(first)) return "Config & diagnostics";
  return "Other";
}

const commands = (pkg.contributes?.commands ?? []).map((c) => ({
  id: c.command,
  title: c.title,
  group: groupKey(c.title),
}));
const commandsByGroup = {};
for (const c of commands) {
  (commandsByGroup[c.group] ??= []).push(c);
}

const settings = Object.entries(
  pkg.contributes?.configuration?.properties ?? {},
).map(([id, spec]) => ({
  id,
  type: spec.type,
  defaultValue:
    spec.default !== undefined ? JSON.stringify(spec.default) : "",
  description: spec.description ?? "",
  enum: spec.enum ?? null,
  enumDescriptions: spec.enumDescriptions ?? null,
}));

const keybindings = (pkg.contributes?.keybindings ?? []).map((kb) => ({
  command: kb.command,
  key: kb.key,
  mac: kb.mac,
}));

const capabilities = [
  {
    feature: "SSH password auth",
    supported: true,
    notes: "OS-keychain or Argon2id-encrypted-in-file; never on argv.",
  },
  {
    feature: "SSH public-key auth",
    supported: true,
    notes: "With explicit identityFile, or via ssh-agent when no file is pinned.",
  },
  { feature: "ssh-agent", supported: true, notes: "Auto-detected via SSH_AUTH_SOCK." },
  { feature: "ssh-agent forwarding (-A)", supported: true, notes: "Per-node `agentForwarding`." },
  { feature: "ProxyJump", supported: true, notes: "Comma-separated for multi-hop chains." },
  { feature: "Port forwards (-L/-R/-D)", supported: true, notes: "Per-node `portForwards` array." },
  { feature: "Per-terminal env vars", supported: true, notes: "`env: {KEY: VALUE}` on a node." },
  {
    feature: "Host-key verification (TOFU)",
    supported: true,
    notes: "Three modes via `vsCRT.hostKeyPolicy`.",
  },
  {
    feature: "Saved shell snippets",
    supported: true,
    notes: "Per-node `commands` array — Run Command… in context menu.",
  },
  {
    feature: "Encrypted profile export/import",
    supported: true,
    notes: "vscrt-bundle/v1 with Argon2id key derivation or stripped audit mode.",
  },
  {
    feature: "Config backup + restore",
    supported: true,
    notes: "Rolling 10-backup cap under ~/.vscrt/backups/.",
  },
  {
    feature: "Connection audit log",
    supported: true,
    notes: "Opt-in via `vsCRT.connectionLogging`.",
  },
  {
    feature: "SFTP / file transfer",
    supported: true,
    notes: "Right-click a server → Open SFTP… for an interactive sftp terminal, or Open SFTP Browser (Preview)… for a read-only directory view with breadcrumbs and ls-style listings. Both share auth, ProxyJump, and host-key policy with the connect flow. For a full drag-and-drop uploader, pair with Remote-SSH.",
  },
  {
    feature: "Serial / Telnet / raw TCP",
    supported: false,
    notes: "On roadmap. Today vsCRT handles SSH only.",
  },
  {
    feature: "Session output recording",
    supported: false,
    notes: "Planned; `vsCRT.showConnectionHistory` logs start/end only today.",
  },
];

const troubleshooting = [
  {
    symptom: "Connect hangs or times out",
    diagnose: [
      "Run `vsCRT: Test Connection` — classifies as connected / auth-failed / timeout / refused / no-route.",
      "If the probe succeeds but the full connect hangs, check `vsCRT.hostKeyPolicy` — a modal fingerprint prompt may be blocked.",
      "Temporarily add `-vvv` to `extraArgs` for verbose SSH debug output in the terminal.",
    ],
  },
  {
    symptom: "Host key has changed / MITM warning",
    diagnose: [
      "Right-click the server → `Remove Host Key…` to clear the stale entry.",
      "Reconnect — the TOFU modal shows the new SHA-256 fingerprint for you to verify.",
      "For stricter environments, set `vsCRT.hostKeyPolicy` to `strict` and manage known_hosts externally.",
    ],
  },
  {
    symptom: "Permission denied on publickey auth",
    diagnose: [
      "Confirm the identityFile path is the PRIVATE key (no `.pub`).",
      "Status view shows whether ssh-agent is reachable — if so, leave `identityFile` blank to use agent keys.",
      "Run `vsCRT: Generate SSH Key Pair` and use `Install Public Key Now` on the server form.",
    ],
  },
  {
    symptom: "Passphrase vault won't unlock",
    diagnose: [
      "`vsCRT: Show Output Log` — look for Argon2id parameter mismatches.",
      "If the params shifted after an upgrade, `vsCRT: Rotate Passphrase KDF Parameters` will re-key every blob.",
      "Last resort: `vsCRT: Reset Passphrase Setup` — wipes the check token but leaves node ciphertexts; you'll re-enrol on next use.",
    ],
  },
  {
    symptom: "Config file won't parse",
    diagnose: [
      "`vsCRT: Validate Config` pinpoints the JSON error with a pointer path.",
      "`vsCRT: Restore Config from Backup…` rolls back to the most recent auto-saved backup (cap: 10).",
      "For schema drift: open `~/.vscrt/vscrtConfig.json` in the editor — VS Code surfaces squiggles against the published schema.",
    ],
  },
];

const output = {
  generatedAt: new Date().toISOString(),
  version: pkg.version,
  commandsByGroup,
  settings,
  keybindings,
  capabilities,
  troubleshooting,
};

writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf-8");
process.stdout.write(`wrote ${outPath}\n`);
