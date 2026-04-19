# Security policy

vsCRT handles SSH credentials. We take that seriously and want to make
it easy to report issues privately before they affect other users.

## Reporting a vulnerability

**Please do NOT open a public GitHub issue** for a suspected security
bug. Use one of these channels instead:

- **Preferred**: [GitHub Security Advisories](https://github.com/kynoci/vscrt/security/advisories/new)
  (private, vendor-coordinated disclosure).
- **Fallback**: email the maintainer — see the `publisher` field in
  `package.json` for the Marketplace-listed contact.

Include in your report:

1. A clear description of the issue + impact.
2. Minimal reproduction steps (VS Code version, OS, vsCRT version, config
   excerpt with secrets redacted).
3. Any proof-of-concept you're comfortable sharing.
4. Your preferred credit text if/when we disclose (or "anonymous").

We aim to acknowledge within 72 hours and to ship a fix within 30 days
for confirmed vulnerabilities at or above Medium severity. Lower
severity items land in the next regular release.

## What counts as a security bug

**In scope** — report privately:

- Cryptographic flaws in the Argon2id + AES-256-GCM passphrase flow
  (`src/config/vscrtPassphrase.ts`, `src/config/vscrtExportBundle.ts`).
- Secret exposure paths: the `sshpass` temp-file / pipe / argv delivery
  mechanism (`src/ssh/sshPasswordDelivery.ts`), ACL handling on Windows,
  residue on crash.
- `known_hosts` manipulation (`src/ssh/hostKey.ts`) — TOCTOU, unsafe
  parsing, unintended key acceptance.
- Config-file corruption or confused-deputy writes through the
  backup/restore path (`src/config/vscrtConfigBackup.ts`).
- Shell injection via `extraArgs`, `endpoint`, `jumpHost`, `portForwards`,
  or `env` field values (the schema constrains most of these; escapes
  past that are vulnerabilities).
- Unintended telemetry, network traffic, or filesystem writes outside
  `~/.vscrt/` and `~/.ssh/`.

**Out of scope** — open a normal issue:

- UX bugs, crashes on malformed config (these trip the recovery modal
  but aren't security).
- Missing features (SFTP, serial, telnet, session recording — see
  README "Known limitations").
- Issues in dependencies that don't affect vsCRT's attack surface.
- VS Code itself — report upstream at
  <https://github.com/microsoft/vscode/issues>.
- SSH protocol or OpenSSH binary issues — report to upstream OpenSSH.

## Threat model (summary)

vsCRT assumes:

- **Trusted** — the local OS + VS Code process + the user's filesystem
  under `~/.vscrt/`, `~/.ssh/`, and tmpdir. Anything with read access
  to these paths sees everything vsCRT sees.
- **Trusted** — the OS keychain used by VS Code's SecretStorage (macOS
  Keychain, Windows Credential Manager, libsecret / gnome-keyring on
  Linux).
- **Adversarial** — the network between the user and each configured
  SSH host. The `vsCRT.hostKeyPolicy` setting (default
  `prompt-on-first`) is the line of defence against MITM: enforce
  `strict` in shared-infrastructure threat models.
- **Adversarial** — other users on the local machine reading
  `/proc/*/environ` or `ps auxe`. Our tempfile-with-chmod-0600 +
  sshpass `-f` delivery path avoids putting passwords on argv; on
  Windows we rely on `icacls` to restrict read access.

**Not in scope of the threat model** — a compromised local user who
can read the current user's home directory. Everything vsCRT stores
is designed for confidentiality-at-rest against other local users,
not against a full filesystem compromise of the current user.

## Hardening notes

The following are defence-in-depth already in place; don't rely on
them being the only barrier:

- Passphrase-vault mode uses **Argon2id** (Noble Hashes,
  audit-reviewed) with per-install salt and embedded KDF parameters
  (`enc:v4` format) so parameters can rotate without breaking old
  blobs.
- AES-256-GCM encryption with random 12-byte IVs and auth-tag
  verification.
- Auto-lock by idle timer (default 15 min) or on window focus loss.
- Atomic backup-then-write on every config save.
- `StrictHostKeyChecking=yes` emitted on the actual connect once the
  user has explicitly accepted the fingerprint.

## Disclosure

After we ship a fix, we publish a GitHub Security Advisory with a
CVE identifier (if assigned) and credit the reporter (unless they
asked for anonymity). The release notes for the fixed version will
link back to the advisory.
