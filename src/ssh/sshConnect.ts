import * as vscode from "vscode";
import { CRTConfigNode, CRTPasswordDelivery } from "../config/vscrtConfig";
import { CRTSecretService } from "../config/vscrtSecret";
import {
  buildBaseSshArgs,
  escapeForDoubleQuotes,
  expandTilde,
  getSshCommand,
  getSshpassCommand,
  resolveEndpoint,
  runInTerminal,
} from "./sshHelpers";
import { resolveAuthMode } from "./sshAuth";
import {
  associateTerminal,
  buildBashPipeCommand,
  buildBashSshpassCommand,
  buildPowerShellPipeCommand,
  buildPowerShellSshpassCommand,
  servePasswordViaLoopback,
  servePasswordViaPipe,
  writeSecurePasswordFile,
} from "./sshPasswordDelivery";

const WINDOWS_SHELL = "powershell.exe";
const UNIX_SHELL = "/bin/bash";

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

export class CRTSshService {
  constructor(private readonly secretService?: CRTSecretService) {}

  async connectFromConfig(
    node: CRTConfigNode,
    location: "panel" | "editor" = "panel",
  ): Promise<void> {
    const { target, port } = resolveEndpoint(node);
    const mode = resolveAuthMode(node);
    const sshCmd = getSshCommand();
    const sshArgs = buildBaseSshArgs(node, port);

    if (mode === "password-auto") {
      const delivery = resolveDelivery(node);
      const sshpassCmd = getSshpassCommand();

      let plaintext: string | undefined;
      try {
        plaintext = this.secretService
          ? await this.secretService.unseal(node.password)
          : node.password;
      } catch (err) {
        vscode.window.showErrorMessage(
          `vsCRT: could not read password for "${node.name}": ${String(err)}`,
        );
        return;
      }
      if (!plaintext) {
        vscode.window.showErrorMessage(
          `vsCRT: no password stored for "${node.name}". Use "Change Password" to set one.`,
        );
        return;
      }

      if (delivery === "tempfile") {
        try {
          const pwdFile = await writeSecurePasswordFile(plaintext);
          const isWindows = process.platform === "win32";
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
          const terminal = runInTerminal(node.name, cmd, {
            shellPath: isWindows ? WINDOWS_SHELL : UNIX_SHELL,
            location,
          });
          associateTerminal(terminal, { file: pwdFile });
          return;
        } catch (err) {
          vscode.window.showErrorMessage(
            `vsCRT: tempfile delivery failed, falling back to argv. ${String(err)}`,
          );
        }
      }

      if (delivery === "pipe") {
        try {
          const isWindows = process.platform === "win32";
          if (isWindows) {
            const handle = await servePasswordViaPipe(plaintext);
            const cmd = buildPowerShellPipeCommand({
              pipeName: handle.pipeName,
              token: handle.token,
              sshpassCmd,
              sshCmd,
              sshArgs,
              target,
            });
            const terminal = runInTerminal(node.name, cmd, {
              shellPath: WINDOWS_SHELL,
              location,
            });
            associateTerminal(terminal, { server: handle.server });
            return;
          }
          const handle = await servePasswordViaLoopback(plaintext);
          const cmd = buildBashPipeCommand({
            host: handle.host,
            port: handle.port,
            token: handle.token,
            sshpassCmd,
            sshCmd,
            sshArgs,
            target,
          });
          const terminal = runInTerminal(node.name, cmd, {
            shellPath: UNIX_SHELL,
            location,
          });
          associateTerminal(terminal, { server: handle.server });
          return;
        } catch (err) {
          vscode.window.showErrorMessage(
            `vsCRT: pipe delivery failed, falling back to argv. ${String(err)}`,
          );
        }
      }

      // argv fallback (legacy behavior)
      const safePassword = escapeForDoubleQuotes(plaintext);
      const finalCmd = `${sshpassCmd} -p "${safePassword}" ${sshCmd} ${sshArgs.join(" ")} "${target}"`;
      runInTerminal(node.name, finalCmd, { location });
      return;
    }

    if (mode === "password-manual") {
      const finalCmd = `${sshCmd} ${sshArgs.join(" ")} "${target}"`;
      runInTerminal(node.name, finalCmd, { location });
      return;
    }

    if (mode === "publickey") {
      if (!node.identityFile?.trim()) {
        vscode.window.showErrorMessage("vsCRT: identityFile missing.");
        return;
      }

      if (node.identityFile.trim().endsWith(".pub")) {
        vscode.window.showErrorMessage(
          "vsCRT: identityFile must be PRIVATE key (no .pub).",
        );
        return;
      }

      const keyPath = expandTilde(node.identityFile);
      const finalCmd = `${sshCmd} ${[...sshArgs, `-i "${keyPath}"`].join(" ")} "${target}"`;
      runInTerminal(node.name, finalCmd, { location });
      return;
    }

    vscode.window.showErrorMessage(`vsCRT: Unknown auth method: ${mode}`);
  }
}
