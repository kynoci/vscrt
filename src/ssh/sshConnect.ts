import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { CRTConfigNode } from "../ConfigSSH/crtConfig";
import { pickWslDistroWithSshpassSync } from "../utils/wslSshpass";

function hasUserAtHost(s: string): boolean {
  return /.+@.+/.test(s);
}

function buildTarget(node: CRTConfigNode): string {
  const ep = (node.endpoint ?? "").trim();
  // If endpoint already looks like user@host, use it directly
  if (ep && hasUserAtHost(ep)) {
    return ep;
  }

  const host = (node.hostName ?? ep).trim();
  const user = (node.user ?? "").trim();
  return user ? `${user}@${host}` : host;
}

// Expand "~" reliably (esp. Windows where ssh.exe won't do it)
function expandTilde(p: string): string {
  const s = p.trim();
  if (!s) {
    return s;
  }
  if (s === "~") {
    return os.homedir();
  }
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.join(os.homedir(), s.slice(2));
  }
  return s;
}

export class CRTSshService {
  connectFromConfig(node: CRTConfigNode): void {
    const target = buildTarget(node);

    const method =
      node.preferredAuthentication ??
      (node.identityFile
        ? "publickey"
        : node.password
        ? "password"
        : "publickey");

    const port = node.port ?? 22;

    // --------------------------
    // PUBLIC KEY MODE
    // --------------------------
    if (method === "publickey") {
      if (!node.identityFile?.trim()) {
        vscode.window.showErrorMessage("vsCRT: identityFile missing.");
        return;
      }
      if (node.identityFile.trim().endsWith(".pub")) {
        vscode.window.showErrorMessage(
          "vsCRT: identityFile must be PRIVATE key (no .pub)."
        );
        return;
      }

      const keyPath = expandTilde(node.identityFile);

      // base ssh command
      // (NOTE: don't add PasswordAuthentication=no unless you REALLY want to forbid fallback)
      const sshArgs = [
        `-p ${port}`,
        `-i "${keyPath}"`,
        // `-o IdentitiesOnly=yes`,
        // `-o PasswordAuthentication=no`,
      ];

      if (node.extraArgs?.trim()) {
        sshArgs.push(node.extraArgs.trim());
      }

      // IMPORTANT: on Windows, use ssh.exe through cmd.exe to avoid Git-Bash/MSYS path conversion
      // ✅ Always plain ssh (no cmd.exe wrapper)
      const finalCmd = `ssh ${sshArgs.join(" ")} "${target}"`;

      const terminal = vscode.window.createTerminal({
        name: `vsCRT: ${node.name}`,
      });
      terminal.show(true);
      terminal.sendText(finalCmd, true);
      return;
    }

    // --------------------------
    // PASSWORD MODE (sshp ass)
    // --------------------------
    if (method === "password") {
      if (!node.password?.trim()) {
        vscode.window.showErrorMessage("vsCRT: password missing.");
        return;
      }

      const escapedPassword = node.password.replace(/'/g, `'\"'\"'`);
      const baseSsh = `ssh -p ${port} "${target}"`;

      let finalCmd =
        process.platform === "win32"
          ? (() => {
              const picked = pickWslDistroWithSshpassSync();
              if (!picked.distro) {
                const found = picked.distros.length
                  ? picked.distros.join(", ")
                  : "(none)";
                vscode.window.showErrorMessage(
                  `vsCRT: No WSL distro with sshpass found. Distros detected: ${found}. Install sshpass in one distro (Debian/Ubuntu: sudo apt install sshpass).`
                );
                return "";
              }
              return `wsl -d "${picked.distro}" -- sshpass -p '${escapedPassword}' ${baseSsh}`;
            })()
          : `sshpass -p '${escapedPassword}' ${baseSsh}`;

      if (!finalCmd) {
        return;
      }

      const terminal = vscode.window.createTerminal({
        name: `vsCRT: ${node.name}`,
      });
      terminal.show(true);
      terminal.sendText(finalCmd, true);
      return;
    }

    vscode.window.showErrorMessage(`vsCRT: Unknown auth method: ${method}`);
  }
}
