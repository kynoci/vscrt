# Changelog

All notable changes to the `vsCRT` VS Code extension are documented in
this file. The format is loosely based on [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.5]

### Fixed

- **First-run bootstrap no longer seeds a fake Production/Staging
  tree.** `createDefaultConfig()` had drifted to return a populated
  demo tree, so a brand-new install wrote that tree to
  `~/.vscrt/vscrtConfig.json` and the Connection view showed phantom
  servers instead of the "No servers yet." empty state. Restored
  `createDefaultConfig()` to `{ folder: [] }`; the rich demo stays
  opt-in via the "Load Example" button (→ `vscrtConfigExample.json`).

## [1.0.4]

### Fixed

- **Published extension icons** — codicons CSS/TTF were excluded from
  the `.vsix` by `node_modules/**` in `.vscodeignore`, so the marketplace
  install rendered blank glyphs in the Connection view, Add/Edit Server
  form, and Help panel while dev hosts worked fine. Added targeted
  negations for `@vscode/codicons/dist/codicon.{css,ttf}` so only those
  two files ship from `node_modules/`.

## [1.0.3]

### Added

- **SFTP Browser** — full file manager webview: upload/download (single
  + bulk parallel queue with live bytes/ETA), OS drag-drop, two-pane
  local side, mkdir/rename/chmod/delete, text preview, symlink follow,
  multi-select, virtualized listing (>300 entries), sortable columns,
  hidden-files toggle, filter row, keyboard nav, right-click menu,
  audit log.
- **Commands**: `openSftp`, `openSftpBrowser`, `openSftpPick`,
  `openSftpBrowserPick`, `testConnection`, `importSshConfig`,
  `loadExample`, `generateKeypair`, `rotateKdfParams`,
  `vaultStatusMenu`, `showLog`, `showSessionHistory`.
- **Session history viewer** merges `~/.vscrt/sessions/*` metadata with
  `~/.vscrt/connections.log` into a time-sorted markdown report.
- **Team-shared config overlay** — `vsCRT.sharedConfigPaths` mounts
  additional JSON files as a read-only "Shared" folder (passwords
  stripped, workspace-trust gated).
- **Tree expand/collapse state** persists across reloads via
  `globalState`.
- **Native terminal profile** — vsCRT in the `+ ▾` dropdown.
- **Localization** — 155 strings routed through `vscode.l10n.t`; full
  Simplified Chinese (`zh-cn`) bundle.
- **A11y** — ARIA menus, radiogroups, live regions on connection view +
  server form.
- **Node fields** — `jumpHost`, `portForwards`, `env`.
- **Passphrase auto-lock** setting (`vsCRT.passphraseAutoLock`) with
  `never` / `5min` / ... / `onFocusLost`.
- **Status-bar vault indicator** with lock-state events.
- **Welcome walkthrough** (five steps) + empty-state onboarding.
- **JSON schema** contribution for `vscrtConfig.json`.
- **`enc:v4:` ciphertext** carrying Argon2id params per blob;
  `enc:v3:` remains read-compatible.
- **CI** — GitHub Actions across Ubuntu (Node 20/22), macOS, Windows;
  unit + integration suites.
- **Deep links** — `vscode://kynoci.vscrt/{sftp,sftpBrowser}` and CLI
  verb `vscrt sftp`.
- **Keybinding** `Ctrl+Alt+F` / `Cmd+Alt+F` — SFTP picker.

### Changed

- **Monolithic files split**: `extension.ts` 1,257 → ~120 LOC;
  `webviewTree.ts` 1,032 → 185; `vscrtConfig.ts` 1,218 → ~880;
  `serverForm.ts` 631 → 81. Webview HTML/CSS/JS extracted to `media/*`.
- **SFTP Browser modularized** — `sftpBrowserCommand.ts` 1,659 LOC →
  28-file tree under `src/commands/sftpBrowser/`.
- **Argon2id defaults** bumped to `{t:4, m:65536, p:1}`; minimum
  passphrase length 8 → 12.
- **First-run bootstrap** seeds an empty config; example ships
  on-demand via *Load Example*.
- **Structured logger** replaces all `console.*`; output channel
  `vsCRT` at activation.
- **Default terminal locations swapped** — double-click → `panel`,
  button → `editor`.
- TypeScript strictness tightened; ESLint bans `any` and non-null
  assertions.

### Fixed

- **SFTP Browser home dir** — `ls -la '~'` no longer fires; bare tilde
  preserved so `$HOME` expansion works.
- **SFTP Browser silent right-click fail** — `openSftpBrowser` was
  missing from `COMMAND_IDS`.
- **Opaque "Command failed"** now surfaces first stderr line.
- **Test Connection parity with Connect** — agent mode added,
  `IdentitiesOnly=yes` dropped, `password-auto` no longer under
  BatchMode, wall-clock budget expanded 7s → ≥30s.
- **Double-click connect** honours `doubleClickTerminalLocation` again
  after scroll-on-focus regression fix.
- **Shell injection in argv sshpass fallback** closed (all inputs
  single-quoted).

### Security

- Passphrase vault auto-locks after 15 min idle by default.
- KDF parameters travel per-ciphertext — rotation without format bump.
- ProxyJump and port-forward values constrained to shell-safe
  charsets.

### Removed

- 14 placeholder `"password": "password"` entries from
  `vscrtConfigExample.json`.
- Scaffold `helloWorld` / `mySecondCommand` demo commands.

## [0.9.2]

Converts vsCRT from scaffold to near-1.0 SSH manager.

### Added

- Webview server form with full CRUD (edit/duplicate/rename/delete/
  changePassword/changeIcon/connectAllInFolder/refresh) and DnD with
  cycle detection.
- Two secret backends: VS Code SecretStorage (OS keychain) and
  Argon2id + AES-GCM passphrase vault (`enc:v3:`).
- Secure `sshpass` delivery — temp file (0600 ACL), named pipe
  (Windows), or loopback TCP; argv is last-resort.
- `StrictHostKeyChecking=accept-new` by default (TOFU).
- Status view — OS/arch/Node/WSL/sshpass probes.
- Icon system — 30+ codicons + custom.
- Settings `doubleClickTerminalLocation`, `buttonClickTerminalLocation`.
- Publishable manifest: `kynoci` publisher, GPL-3.0-only.

### Changed

- Native `TreeDataProvider` replaced by webview (filter, highlight,
  row actions).
- Config moved: `~/.vsCRT/configSSH.json` → `~/.vscrt/vscrtConfig.json`.
- Schema renamed with auto-migration: `clusters` → `folder`,
  `subclusters` → `subfolder`, top-level `nodes` → `Unfiled`, `port`
  merged into `endpoint`.
- Windows password auth uses native `sshpass.exe` (no WSL shell-out).

### Removed

- `helloWorld` / `mySecondCommand` scaffold commands.
- `src/utils/wslSshpass.ts`.
- Plaintext `password` fields in config.

### Security

- Passwords never on the command line by default.
- OS-level ACLs on temp password file.
- Authenticated encryption (AES-GCM) for passphrase blobs.

## [0.0.1]

Initial scaffolded prototype: activity-bar sidebar with native tree,
`addCluster` / `addServer` / `connect` commands, `sshpass`-via-argv
password auth on Unix (WSL on Windows), `~/.vsCRT/configSSH.json`
config, esbuild bundling, Mocha test harness.
