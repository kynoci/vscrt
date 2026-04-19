/**
 * `vsCRT: Generate SSH Key Pair` — wraps ssh-keygen for users who don't
 * have a private key yet. Complements the "Install public key now"
 * flow in Add Server: you can now go from zero keys to working publickey
 * auth without leaving VS Code.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "../log";
import { formatError } from "./commandUtils";

const execFileAsync = promisify(execFile);

export function registerGenerateKeypairCommand(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.generateKeypair", async () => {
      await runGenerate();
    }),
  ];
}

async function runGenerate(): Promise<void> {
  const defaultPath = path.join(os.homedir(), ".ssh", "id_ed25519");

  const destInput = await vscode.window.showInputBox({
    title: "vsCRT: Generate SSH Key Pair",
    prompt: "Path for the PRIVATE key (.pub will be written alongside)",
    value: defaultPath,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : "Path cannot be empty."),
  });
  if (!destInput) {
    return;
  }
  const dest = expand(destInput.trim());

  if (fs.existsSync(dest)) {
    const choice = await vscode.window.showWarningMessage(
      `${dest} already exists. Overwrite?`,
      {
        modal: true,
        detail:
          "This replaces both the private key and its .pub companion. Existing authorized hosts will stop accepting the old key.",
      },
      "Overwrite",
    );
    if (choice !== "Overwrite") {
      return;
    }
    // ssh-keygen won't overwrite; delete first.
    try {
      fs.unlinkSync(dest);
      if (fs.existsSync(dest + ".pub")) {
        fs.unlinkSync(dest + ".pub");
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `vsCRT: could not remove existing key — ${formatError(err)}`,
      );
      return;
    }
  }

  // Ensure parent directory exists.
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  } catch (err) {
    vscode.window.showErrorMessage(
      `vsCRT: could not create key directory — ${formatError(err)}`,
    );
    return;
  }

  const args = ["-t", "ed25519", "-f", dest, "-N", "", "-C", `vscrt-${os.hostname()}`];
  try {
    log.debug("ssh-keygen", args.join(" "));
    await execFileAsync("ssh-keygen", args, {
      timeout: 10_000,
      encoding: "utf-8",
    });
  } catch (err) {
    const e = err as { code?: string | number };
    const msg =
      typeof e.code === "string" && e.code === "ENOENT"
        ? "ssh-keygen is not on PATH."
        : formatError(err);
    vscode.window.showErrorMessage(`vsCRT: ssh-keygen failed — ${msg}`);
    return;
  }

  const pubPath = dest + ".pub";
  let pubKey = "";
  try {
    pubKey = (await fs.promises.readFile(pubPath, "utf8")).trim();
  } catch {
    // Ignore — the generate itself succeeded.
  }

  const choice = await vscode.window.showInformationMessage(
    `vsCRT: generated SSH key pair at ${dest}.`,
    "Copy Public Key",
    "Reveal in File Explorer",
  );
  if (choice === "Copy Public Key" && pubKey) {
    await vscode.env.clipboard.writeText(pubKey);
    vscode.window.showInformationMessage(
      "vsCRT: public key copied to clipboard.",
    );
  } else if (choice === "Reveal in File Explorer") {
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(dest),
    );
  }
}

function expand(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
