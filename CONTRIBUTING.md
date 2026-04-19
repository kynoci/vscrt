# Contributing to vsCRT

Thanks for considering a contribution! This guide covers the dev
environment, the test matrix, and what to expect from a PR review.

If you're reporting a bug, jump to
[filing an issue](#filing-an-issue) below instead.

## Development environment

Requirements:

- **Node.js 20 or 22** (the matrix CI runs both — stick to features
  available on 20).
- **VS Code ≥ 1.106.1** (set in `engines.vscode`).
- On Linux, `xvfb` if you want to run integration tests locally:
  `sudo apt install xvfb`.
- Optional but useful:
  - `sshpass` — for testing the password-delivery code paths.
  - `ssh-agent` — for testing the agent-auth path.

Clone and install:

```bash
git clone https://github.com/kynoci/vscrt.git
cd vscrt
npm ci
```

Open the folder in VS Code and press **F5** to launch an Extension
Development Host with your local build. The `watch` task rebuilds on
save via `esbuild`:

```bash
npm run watch
```

## Test matrix

Four suites, each with a dedicated npm script:

| Command | What it runs | Typical runtime |
|---|---|---|
| `npm run test:unit` | Pure mocha, stubbed `vscode` module (`src/test/stubs/vscode.ts`). Fastest; no display required. | ~15 s |
| `npm run test:integration` | Real Extension Development Host via `@vscode/test-cli`. Needs a display or `xvfb-run` on Linux. | ~60 s |
| `npm run test:perf` | Latency budgets on the tree walkers, export walker, and quickConnect pipeline. Linux-only in CI. | ~10 s |
| `npm run test:cli` | `node --test` on the `cli/` sibling package (pure-helper unit tests). | ~2 s |
| `npm run test:all` | Runs `test:unit` and `test:cli` sequentially — useful before opening a PR. | ~20 s |
| `npm test` | Alias for `npm run test:unit`. |  |

Every PR must pass `check-types`, `lint`, and the unit + CLI test suites:

```bash
npm run check-types
npm run lint
npm run test:all           # unit + CLI
npm run test:integration   # optional locally; CI runs it on ubuntu-node22
npm run test:perf          # optional locally; CI runs it on ubuntu-node22
```

## Project layout

```
src/
  commands/          # One file per command group; registered via index.ts
  config/            # CRTConfig service + Argon2id passphrase + secret bridge
  ssh/               # Connect orchestration, helpers, host-key mgmt
  status/            # Status view provider
  treeView/          # Connection webview + server form webview
  test/
    *.test.ts        # Unit tests (mocha + stubbed vscode)
    integration/     # Integration tests (real VS Code host)
    perf/            # Performance budget tests
    stubs/           # vscode module stub used by unit tests
media/               # Webview HTML/CSS/JS (real files, not template literals)
schemas/             # JSON Schema for vscrtConfig.json (Draft-07)
scripts/             # Release automation (bump-version, extract-changelog)
.github/workflows/   # ci.yml + release.yml
```

## Commit style

- Short, imperative subject line: `add X`, `fix Y`, `refactor Z`.
- Reference an issue when applicable: `fix #123: …`.
- Release commits are created by `npm run release:<level>` and look
  like `release: v0.9.4`.

## Changelog

Every user-visible change goes under the `## [Unreleased]` section of
`CHANGELOG.md`. On a release, `scripts/bump-version.mjs` renames that
section to the released version + date and inserts a fresh empty
`[Unreleased]` above it.

## Pull-request checklist

Before opening a PR:

- [ ] `npm run check-types` clean
- [ ] `npm run lint` clean (fix with `npm run lint -- --fix`)
- [ ] `npm run test:unit` green
- [ ] For UI/webview changes: tested by hand in the Extension
      Development Host (F5)
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] New features include at least one unit test; new commands
      include at least one integration test

CI runs on Linux/macOS/Windows × Node 20/22. Integration + perf tests
gate on Linux-Node22 only (to avoid platform-runtime jitter flakes).

## Adding a new command

1. Create the handler in `src/commands/<feature>Command.ts`. Export a
   `register<Feature>Command(deps: CommandDeps): vscode.Disposable`.
2. Register in `src/commands/index.ts`.
3. Declare in `package.json` under `contributes.commands` with a
   `vsCRT: <Action>` title. If it shouldn't appear in the Command
   Palette (context-only), add it to `commandPalette` with
   `"when": "false"`.
4. For webview-triggered commands, add the name to the `W2E.invoke`
   union in `src/treeView/webviewTreeModel.ts` and to the
   `COMMAND_IDS` map.
5. Add a test. For pure handlers, a `*.test.ts` under `src/test/`.
   For anything touching the webview or real file I/O, an integration
   test under `src/test/integration/`.

## Adding a new setting

1. Declare in `package.json` under
   `contributes.configuration.properties` with `enum`,
   `enumDescriptions`, and a sensible `default`.
2. If the setting should be re-applied without an extension reload,
   wire an `onDidChangeConfiguration` listener in
   `src/extension.ts`.
3. Mirror any config-file version of the setting (top-level key in
   `vscrtConfig.json`) into `schemas/vscrtConfig.schema.json`.

## Filing an issue

Use the issue templates — the bug template asks for OS, VS Code
version, extension version, reproduction steps, and an Output Log
excerpt. Those four fields resolve about 90% of triage ping-pong.

For vulnerability reports see [SECURITY.md](./SECURITY.md). Don't
open a public issue for a security bug.

## Code of conduct

We follow the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Be
kind, be specific, assume good faith.
