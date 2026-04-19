/**
 * Interactive SSH connect — host-agnostic version.
 *
 * Orchestrates the full connect flow (auth mode resolution, host-key
 * TOFU, password delivery) using a `HostAdapter` for every
 * user-facing or platform-specific concern. The argv/shell logic is
 * identical to the previous `CRTSshService.connectFromConfig`; the
 * only change is that modals, secrets, terminal creation, and
 * settings reads flow through the adapter.
 */

import { CRTConfigNode, CRTPasswordDelivery } from "../../config/vscrtConfigTypes";
import { PassphraseCancelled } from "../../config/vscrtPassphraseErrors";
import { formatError } from "../../errorUtils";
import { log } from "../../log";
import {
  recordConnectStart,
  recordSessionMetadata,
} from "../telemetry/sessionTelemetry";
import {
  appendKnownHostsLine,
  computeFingerprint,
  extractHost,
  isHostKnown,
  scanHostKey,
} from "../core/hostKey";
import {
  HostKeyCheckMode,
  buildBaseSshArgs,
  expandTilde,
  getSshCommand,
  getSshpassCommand,
  resolveEndpoint,
} from "../core/helpers";
import { resolveAuthMode } from "../core/authResolver";
import {
  buildBashArgvSshpassCommand,
  buildBashPipeCommand,
  buildBashSshpassCommand,
  buildPowerShellArgvSshpassCommand,
  buildPowerShellPipeCommand,
  buildPowerShellSshpassCommand,
  psSingleQuote,
  servePasswordViaLoopback,
  servePasswordViaPipe,
  shSingleQuote,
  writeSecurePasswordFile,
} from "../core/passwordDelivery";
import { HostAdapter, TerminalLocation } from "../host/hostAdapter";

const WINDOWS_SHELL = "powershell.exe";
const UNIX_SHELL = "/bin/bash";

export interface ConnectOptions {
  /** Panel vs editor split — only meaningful inside VS Code. */
  location?: TerminalLocation;
}

function resolveDelivery(node: CRTConfigNode): CRTPasswordDelivery {
  if (node.passwordDelivery) {
    return node.passwordDelivery;
  }
  if (
    process.platform === "win32" ||
    process.platform === "linux" ||
    process.platform === "darwin"
  ) {
    return "tempfile";
  }
  return "argv";
}

export async function connect(
  node: CRTConfigNode,
  host: HostAdapter,
  opts: ConnectOptions = {},
): Promise<void> {
  const location = opts.location ?? "panel";
  const { target, port } = resolveEndpoint(node);
  const mode = resolveAuthMode(node);
  const sshCmd = getSshCommand();
  log.info(
    `connect: "${node.name}" → ${target}:${port} (mode=${mode}, location=${location})`,
  );
  const hostKeyCheck = await log.timed(
    `hostKeyCheck for ${target}:${port}`,
    () => resolveHostKeyCheck(node, target, port, host),
    { slowMs: 500 },
  );
  if (hostKeyCheck === null) {
    log.info(`connect: "${node.name}" aborted at host-key step.`);
    return;
  }
  const sshArgs = buildBaseSshArgs(node, port, { hostKeyCheck });
  const isWindows = process.platform === "win32";

  void recordConnectStart(node, target, port, mode, host);
  void recordSessionMetadata(node, target, port, mode, host);
  const nodeEnv = node.env;

  if (mode === "password-auto") {
    const delivery = resolveDelivery(node);
    const sshpassCmd = getSshpassCommand();

    let plaintext: string | undefined;
    try {
      plaintext = await host.unsealPassword(node.password);
    } catch (err) {
      if (err instanceof PassphraseCancelled) {
        return;
      }
      host.error(
        `vsCRT: could not read password for "${node.name}": ${formatError(err)}`,
      );
      return;
    }
    if (!plaintext) {
      host.error(
        `vsCRT: no password stored for "${node.name}". Use "Change Password" to set one.`,
      );
      return;
    }

    if (delivery === "tempfile") {
      try {
        const pwdFile = await writeSecurePasswordFile(plaintext);
        const cmd = isWindows
          ? buildPowerShellSshpassCommand({
              sshpassCmd,
              pwdFile,
              sshCmd,
              sshArgs,
              target,
            })
          : buildBashSshpassCommand({
              sshpassCmd,
              pwdFile,
              sshCmd,
              sshArgs,
              target,
            });
        const handle = host.openTerminal({
          name: node.name,
          shellPath: isWindows ? WINDOWS_SHELL : UNIX_SHELL,
          command: cmd,
          env: nodeEnv,
          location,
        });
        handle.associateResources({ file: pwdFile });
        return;
      } catch (err) {
        host.error(
          `vsCRT: tempfile delivery failed, falling back to argv. ${formatError(err)}`,
        );
      }
    }

    if (delivery === "pipe") {
      try {
        if (isWindows) {
          const ph = await servePasswordViaPipe(plaintext);
          const cmd = buildPowerShellPipeCommand({
            pipeName: ph.pipeName,
            token: ph.token,
            sshpassCmd,
            sshCmd,
            sshArgs,
            target,
          });
          const handle = host.openTerminal({
            name: node.name,
            shellPath: WINDOWS_SHELL,
            command: cmd,
            env: nodeEnv,
            location,
          });
          handle.associateResources({ server: ph.server });
          return;
        }
        const lh = await servePasswordViaLoopback(plaintext);
        const cmd = buildBashPipeCommand({
          host: lh.host,
          port: lh.port,
          token: lh.token,
          sshpassCmd,
          sshCmd,
          sshArgs,
          target,
        });
        const handle = host.openTerminal({
          name: node.name,
          shellPath: UNIX_SHELL,
          command: cmd,
          env: nodeEnv,
          location,
        });
        handle.associateResources({ server: lh.server });
        return;
      } catch (err) {
        host.error(
          `vsCRT: pipe delivery failed, falling back to argv. ${formatError(err)}`,
        );
      }
    }

    const argvCmd = isWindows
      ? buildPowerShellArgvSshpassCommand({
          sshpassCmd,
          password: plaintext,
          sshCmd,
          sshArgs,
          target,
        })
      : buildBashArgvSshpassCommand({
          sshpassCmd,
          password: plaintext,
          sshCmd,
          sshArgs,
          target,
        });
    host.openTerminal({
      name: node.name,
      shellPath: isWindows ? WINDOWS_SHELL : UNIX_SHELL,
      command: argvCmd,
      env: nodeEnv,
      location,
    });
    return;
  }

  if (mode === "password-manual") {
    const cmd = isWindows
      ? `& { & ${psSingleQuote(sshCmd)} ${sshArgs.join(" ")} ${psSingleQuote(target)} }`
      : `${shSingleQuote(sshCmd)} ${sshArgs.join(" ")} ${shSingleQuote(target)}`;
    host.openTerminal({
      name: node.name,
      shellPath: isWindows ? WINDOWS_SHELL : UNIX_SHELL,
      command: cmd,
      env: nodeEnv,
      location,
    });
    return;
  }

  if (mode === "publickey") {
    if (!node.identityFile?.trim()) {
      host.error("vsCRT: identityFile missing.");
      return;
    }

    if (node.identityFile.trim().endsWith(".pub")) {
      host.error("vsCRT: identityFile must be PRIVATE key (no .pub).");
      return;
    }

    const keyPath = expandTilde(node.identityFile);
    const cmd = isWindows
      ? `& { & ${psSingleQuote(sshCmd)} ${sshArgs.join(" ")} -i ${psSingleQuote(keyPath)} ${psSingleQuote(target)} }`
      : `${shSingleQuote(sshCmd)} ${sshArgs.join(" ")} -i ${shSingleQuote(keyPath)} ${shSingleQuote(target)}`;
    host.openTerminal({
      name: node.name,
      shellPath: isWindows ? WINDOWS_SHELL : UNIX_SHELL,
      command: cmd,
      env: nodeEnv,
      location,
    });
    return;
  }

  if (mode === "agent") {
    const cmd = isWindows
      ? `& { & ${psSingleQuote(sshCmd)} ${sshArgs.join(" ")} ${psSingleQuote(target)} }`
      : `${shSingleQuote(sshCmd)} ${sshArgs.join(" ")} ${shSingleQuote(target)}`;
    host.openTerminal({
      name: node.name,
      shellPath: isWindows ? WINDOWS_SHELL : UNIX_SHELL,
      command: cmd,
      env: nodeEnv,
      location,
    });
    return;
  }

  host.error(
    `vsCRT: unknown auth mode "${mode}" resolved for "${node.name}" — please report this as a bug.`,
  );
}

/**
 * Decide the `StrictHostKeyChecking` mode for this connection based on the
 * host's `hostKeyPolicy` setting and, if needed, a TOFU prompt.
 *
 * Returns `null` when the user cancelled or strict mode refused the host —
 * the caller should abort the connect flow silently.
 */
export async function resolveHostKeyCheck(
  node: CRTConfigNode,
  target: string,
  port: number,
  host: HostAdapter,
): Promise<HostKeyCheckMode | null> {
  const policy = host.getHostKeyPolicy();
  if (policy === "auto-accept") {
    return "accept-new";
  }

  // ProxyJump chains can't be pre-scanned; defer to ssh's in-terminal
  // `ask` prompt when we can't verify ourselves.
  if (node.jumpHost?.trim()) {
    return policy === "strict" ? "strict" : "ask";
  }

  const hostname = extractHost(target);
  if (await isHostKnown(hostname, port)) {
    return "strict";
  }

  if (policy === "strict") {
    host.error(
      `vsCRT: host key for "${hostname}" is not in known_hosts. Strict policy refused the connection. Add the key manually or switch vsCRT.hostKeyPolicy to "prompt-on-first".`,
    );
    return null;
  }

  const scanned = await scanHostKey(hostname, port);
  if (!scanned) {
    host.error(
      `vsCRT: could not reach "${hostname}:${port}" to verify its host key. Check network or lower vsCRT.hostKeyPolicy to "auto-accept" to bypass.`,
    );
    return null;
  }

  const fingerprint =
    (await computeFingerprint(scanned.line)) ?? "(fingerprint unavailable)";
  const ok = await host.confirm({
    title: `Verify host key for "${hostname}:${port}"`,
    detail:
      `Key type: ${scanned.keyType}\nFingerprint: ${fingerprint}\n\n` +
      "If you trust this host, add the key to ~/.ssh/known_hosts and " +
      "proceed. This only needs to be done once per host.",
    trustLabel: "Trust & Connect",
  });
  if (!ok) {
    log.info(`Host-key verification cancelled for ${hostname}:${port}.`);
    return null;
  }

  try {
    await appendKnownHostsLine(scanned.line);
    log.info(
      `Added ${scanned.keyType} key for ${hostname}:${port} to known_hosts.`,
    );
  } catch (err) {
    host.error(`vsCRT: failed to write known_hosts: ${formatError(err)}`);
    return null;
  }
  return "strict";
}
