#!/usr/bin/env node
/**
 * `vscrt-remote` — standalone CLI that reuses the same ssh/sshpass/
 * sftp code the VS Code extension runs. Reads server profiles from
 * `~/.vscrt/vscrtConfig.json`.
 *
 * Verbs:
 *   vscrt-remote connect     <profilePath>   [--password-stdin] [--yes]
 *                                           [--host-key-policy <p>]
 *                                           [--verbose]
 *   vscrt-remote test        <profilePath>   [--timeout N] [--verbose]
 *   vscrt-remote sftp        <profilePath>   [--password-stdin]
 *   vscrt-remote install-key <profilePath>   --public-key <path>
 *   vscrt-remote ls
 *   vscrt-remote diag
 *   vscrt-remote version | --version | -v
 *   vscrt-remote help    | --help    | -h
 *
 * Exit codes:
 *   0  connected / test passed / op succeeded
 *   1  generic error (command failed)
 *   2  usage error
 *   64 unknown verb (same class as 2)
 *   65 profile not found
 *   66 secret unavailable (e.g. @secret: under CLI without --password-stdin)
 */

import * as fs from "fs";
import { connect } from "../actions/connect";
import { sftp } from "../actions/sftp";
import { testConnection } from "../actions/test";
import { installPublicKey } from "../core/keyInstall";
import { CliUnsealer, NodeHostAdapter, CliSettings } from "../host/nodeHostAdapter";
import { HostKeyPolicy } from "../host/hostAdapter";
import {
  defaultConfigPath,
  listProfilePaths,
  readConfigFile,
  resolveProfile,
} from "../profile/readProfile";
import { parseRemoteArgs, ParsedRemoteArgs } from "./argParser";
import { detectSshAgent } from "../core/sshAgent";

type FlagMap = Record<string, string | true>;

function die(msg: string, code = 2): never {
  process.stderr.write(`vscrt-remote: ${msg}\n`);
  process.exit(code);
}

function boolFlag(flags: FlagMap, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

function strFlag(flags: FlagMap, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function parseHostKeyPolicyFlag(raw: string | undefined): HostKeyPolicy | undefined {
  if (raw === "auto-accept" || raw === "prompt-on-first" || raw === "strict") {
    return raw;
  }
  if (raw !== undefined) {
    die(`invalid --host-key-policy: ${raw}`);
  }
  return undefined;
}

async function readStdinToEnd(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/**
 * Build the unsealer the NodeHostAdapter hands stored passwords to.
 *
 * Precedence (first non-empty source wins, overriding stored form):
 *   1. `--password <VALUE>` / `--password=<VALUE>`        inline, argv-visible
 *   2. `--password-stdin=<VALUE>`                         argv-visible shorthand
 *   3. `--password-stdin` (boolean) + data on stdin       recommended
 *
 * Without any of the above, the stored form decides:
 *   - plaintext in vscrtConfig.json → used verbatim
 *   - `@secret:<uuid>` (VS Code SecretStorage)           → exit 66
 *   - `enc:v3:` / `enc:v4:` (Argon2id+AES-GCM)           → exit 66 for now
 */
async function buildUnsealer(flags: FlagMap): Promise<CliUnsealer> {
  let inlinePlaintext: string | undefined;

  // `--password VALUE` / `--password=VALUE`.
  const inlinePw = strFlag(flags, "password");
  if (inlinePw !== undefined) {
    inlinePlaintext = inlinePw;
    process.stderr.write(
      "warning: --password puts the password on argv (visible to `ps`). Prefer piping to --password-stdin.\n",
    );
  }

  // `--password-stdin` is a boolean that reads stdin, but tolerate
  // `--password-stdin=VALUE` as a shorthand — some users reach for
  // that naturally. It's still argv-exposed, so warn.
  const stdinFlag = flags["password-stdin"];
  if (typeof stdinFlag === "string") {
    if (inlinePlaintext === undefined) {
      inlinePlaintext = stdinFlag;
      process.stderr.write(
        "warning: --password-stdin=<value> exposes the password on argv. Use `echo … | … --password-stdin` or --password=<value>.\n",
      );
    }
  } else if (stdinFlag === true && inlinePlaintext === undefined) {
    inlinePlaintext = await readStdinToEnd();
  }

  return async (stored) => {
    if (!stored) {
      return undefined;
    }
    if (inlinePlaintext !== undefined) {
      return inlinePlaintext;
    }
    if (stored.startsWith("@secret:")) {
      // Exit 66 propagates from the core catch; throw here so the
      // message is crisp.
      const err = new Error(
        "Password is stored in VS Code SecretStorage, which isn't readable from the CLI. " +
          "Re-run with --password-stdin, or open the profile in VS Code once to migrate " +
          "it to passphrase storage.",
      );
      (err as { code?: string }).code = "SECRET_UNAVAILABLE";
      throw err;
    }
    if (stored.startsWith("enc:v3:") || stored.startsWith("enc:v4:")) {
      // Passphrase-decrypt support in the CLI requires reusing the
      // extension's CRTPassphraseService, which is VS Code-coupled via
      // `showInputBox`. That refactor is tracked as Phase 4 in
      // docs/PLAN_5_HEADLESS_REMOTE_CORE.md. For now, point users at
      // --password-stdin.
      const err = new Error(
        "Password is passphrase-encrypted (enc:v3/enc:v4). CLI passphrase prompting " +
          "isn't wired up yet — re-run with --password-stdin, or open the profile in " +
          "VS Code once so the stored plaintext can be read.",
      );
      (err as { code?: string }).code = "SECRET_UNAVAILABLE";
      throw err;
    }
    return stored;
  };
}

function resolveSettings(flags: FlagMap): CliSettings {
  const connectionLogMode = (() => {
    const s = strFlag(flags, "connection-log");
    if (s === "minimal" || s === "verbose" || s === "off") {
      return s;
    }
    return undefined;
  })();
  const sessionRecordingMode = (() => {
    const s = strFlag(flags, "session-recording");
    if (s === "minimal" || s === "full" || s === "off") {
      return s;
    }
    return undefined;
  })();
  return {
    hostKeyPolicy: parseHostKeyPolicyFlag(strFlag(flags, "host-key-policy")),
    connectionLogMode,
    sessionRecordingMode,
    assumeYes: boolFlag(flags, "yes"),
  };
}

function printUsage(): void {
  process.stdout.write(`vscrt-remote — unified SSH/SFTP launcher for vsCRT profiles.

Usage:
  vscrt-remote connect     <path>   [--password-stdin] [--yes]
                                    [--host-key-policy auto-accept|prompt-on-first|strict]
                                    [--verbose]
  vscrt-remote test        <path>   [--timeout N] [--verbose]
  vscrt-remote sftp        <path>   [--password-stdin]
  vscrt-remote install-key <path>   --public-key <file>
  vscrt-remote ls
  vscrt-remote diag
  vscrt-remote version
  vscrt-remote help

Common flags:
  --config <file>         Path to vscrtConfig.json (default: ~/.vscrt/vscrtConfig.json)
  --password-stdin        Read plaintext password from stdin (recommended — no argv exposure)
  --password <value>      Inline password (WARNING: visible to ps/argv)
  --yes                   Auto-accept host-key TOFU prompts

Exit codes:
  0  success · 2 usage · 65 profile not found · 66 secret unavailable
`);
}

async function loadProfile(flags: FlagMap, pathArg: string | undefined) {
  if (!pathArg) {
    die("missing <path> — try `vscrt-remote ls` to see available profiles.");
  }
  const configPath = strFlag(flags, "config") ?? defaultConfigPath();
  if (!fs.existsSync(configPath)) {
    die(`config not found: ${configPath}`, 65);
  }
  const cfg = readConfigFile(configPath);
  const node = resolveProfile(cfg, pathArg);
  if (!node) {
    const available = listProfilePaths(cfg);
    const hint = available.length > 0 ? `\n  Available: ${available.join(", ")}` : "";
    die(`profile not found: ${pathArg}${hint}`, 65);
  }
  return { cfg, node };
}

async function runConnect(args: ParsedRemoteArgs): Promise<number> {
  const { node } = await loadProfile(args.flags, args.positional[0]);
  const unsealer = await buildUnsealer(args.flags);
  const host = new NodeHostAdapter(resolveSettings(args.flags), unsealer);
  try {
    await connect(node, host);
    const exit = await host.waitForLastTerminal();
    return exit ?? 0;
  } catch (err) {
    return handleActionError(err);
  }
}

async function runSftp(args: ParsedRemoteArgs): Promise<number> {
  const { node } = await loadProfile(args.flags, args.positional[0]);
  const unsealer = await buildUnsealer(args.flags);
  const host = new NodeHostAdapter(resolveSettings(args.flags), unsealer);
  try {
    await sftp(node, host);
    const exit = await host.waitForLastTerminal();
    return exit ?? 0;
  } catch (err) {
    return handleActionError(err);
  }
}

async function runTest(args: ParsedRemoteArgs): Promise<number> {
  const { node } = await loadProfile(args.flags, args.positional[0]);
  const unsealer = await buildUnsealer(args.flags);
  const host = new NodeHostAdapter(resolveSettings(args.flags), unsealer);
  const timeoutS = Number(strFlag(args.flags, "timeout") ?? 5);
  try {
    const result = await testConnection(node, host, { timeoutSeconds: timeoutS });
    process.stdout.write(
      `${result.outcome} · ${result.durationMs}ms · ${result.message}\n`,
    );
    return result.outcome === "connected" ? 0 : 1;
  } catch (err) {
    return handleActionError(err);
  }
}

async function runLs(args: ParsedRemoteArgs): Promise<number> {
  const configPath = strFlag(args.flags, "config") ?? defaultConfigPath();
  if (!fs.existsSync(configPath)) {
    process.stderr.write(`config not found: ${configPath}\n`);
    return 65;
  }
  const cfg = readConfigFile(configPath);
  const paths = listProfilePaths(cfg);
  if (paths.length === 0) {
    process.stderr.write(`(no profiles in ${configPath})\n`);
    return 0;
  }
  for (const p of paths) {
    process.stdout.write(`${p}\n`);
  }
  return 0;
}

async function runDiag(_args: ParsedRemoteArgs): Promise<number> {
  const agent = await detectSshAgent();
  const lines: string[] = [
    `platform:       ${process.platform} ${process.arch}`,
    `node:           ${process.version}`,
    `SSH_AUTH_SOCK:  ${process.env.SSH_AUTH_SOCK ?? "(unset)"}`,
    `ssh-agent:      ${
      agent.keysLoaded
        ? `ok (${agent.keyCount} key${agent.keyCount === 1 ? "" : "s"})`
        : agent.message ?? "not ready"
    }`,
    `config:         ${defaultConfigPath()} (${fs.existsSync(defaultConfigPath()) ? "present" : "missing"})`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

async function runInstallKey(args: ParsedRemoteArgs): Promise<number> {
  const { node } = await loadProfile(args.flags, args.positional[0]);
  const pubKey = strFlag(args.flags, "public-key");
  if (!pubKey) {
    die("install-key requires --public-key <file>", 2);
  }
  const unsealer = await buildUnsealer(args.flags);
  // Password flows through the same unsealer + stdin path as connect.
  const plaintext = await unsealer(node.password);
  if (!plaintext) {
    die(
      "install-key needs a one-time password for the initial push — " +
        "supply via --password-stdin.",
      66,
    );
  }
  const result = await installPublicKey(node, plaintext);
  process.stdout.write(`${result.success ? "ok" : "fail"}: ${result.message}\n`);
  return result.success ? 0 : 1;
}

function handleActionError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code;
  if (code === "SECRET_UNAVAILABLE") {
    process.stderr.write(`vscrt-remote: ${msg}\n`);
    return 66;
  }
  process.stderr.write(`vscrt-remote: ${msg}\n`);
  return 1;
}

export async function main(rawArgv: readonly string[]): Promise<number> {
  const args = parseRemoteArgs(rawArgv);
  for (const w of args.warnings) {
    process.stderr.write(`warning: ${w}\n`);
  }
  switch (args.verb) {
    case "connect":
      return runConnect(args);
    case "test":
      return runTest(args);
    case "sftp":
      return runSftp(args);
    case "install-key":
      return runInstallKey(args);
    case "ls":
      return runLs(args);
    case "diag":
      return runDiag(args);
    case "version": {
      // The bundled build replaces this via esbuild's `define`;
      // the unbundled path (tsc → out/) falls back to a package.json
      // lookup so developers running `node out/remote/cli/main.js`
      // still see a real version.
      const baked = process.env.VSCRT_REMOTE_VERSION;
      if (baked) {
        process.stdout.write(`${baked}\n`);
      } else {
        try {
          const pkgPath = require.resolve("../../../package.json");
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
          process.stdout.write(`${pkg.version ?? "?"}\n`);
        } catch {
          process.stdout.write("unknown\n");
        }
      }
      return 0;
    }
    case "help":
    default:
      printUsage();
      return args.warnings.length > 0 ? 2 : 0;
  }
}

// When invoked directly (not imported by tests), kick off main.
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `vscrt-remote: fatal — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
