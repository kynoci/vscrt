/**
 * "How do I install …" commands shown from the Status view when a dependency
 * (WSL, sshpass) is missing. Each opens a modal with platform-specific
 * instructions and offers a "Copy" action.
 */

import * as vscode from "vscode";

export function registerHelpCommands(): vscode.Disposable[] {
  return [
    registerCopyableHelp("vsCRT.sshpassLinuxHelp", SSHPASS_LINUX),
    registerCopyableHelp("vsCRT.sshpassMacHelp", SSHPASS_MAC),
    registerCopyableHelp("vsCRT.sshpassWslHelp", SSHPASS_WSL),
    vscode.commands.registerCommand("vsCRT.wslHelp", () => {
      vscode.window.showInformationMessage(WSL_HELP, { modal: true });
    }),
    vscode.commands.registerCommand("vsCRT.sshpassWinHelp", () => {
      vscode.window
        .showInformationMessage(
          SSHPASS_WIN,
          { modal: true },
          "Open KYNOCI",
          "Open XHCODING",
        )
        .then((choice) => {
          if (choice === "Open KYNOCI") {
            vscode.env.openExternal(
              vscode.Uri.parse("https://www.kynoci.com/sshpass-windows"),
            );
          } else if (choice === "Open XHCODING") {
            vscode.env.openExternal(
              vscode.Uri.parse(
                "https://github.com/xhcoding/sshpass-win32/releases",
              ),
            );
          }
        });
    }),
  ];
}

/**
 * Factory for the three identical "here's the install command — want to copy
 * it?" commands. Returns a disposable that unregisters the command.
 */
function registerCopyableHelp(
  commandId: string,
  text: string,
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, () => {
    vscode.window
      .showInformationMessage(text, { modal: true }, "Copy")
      .then((choice) => {
        if (choice === "Copy") {
          vscode.env.clipboard.writeText(text);
        }
      });
  });
}

const SSHPASS_LINUX = [
  "Install sshpass on Linux:",
  "",
  "### Debian/Ubuntu:",
  "apt install sshpass",
  "sudo apt install sshpass",
  "",
  "### RHEL/CentOS/Fedora:",
  "sudo yum install sshpass",
  "sudo dnf install sshpass",
  "",
  "### Arch Linux:",
  "pacman -S sshpass",
  "",
  "### From source (if not in your repos):",
  "wget https://sourceforge.net/projects/sshpass/files/latest/download -O sshpass.tar.gz",
  "tar -xzf sshpass.tar.gz",
  "cd sshpass-*",
  "./configure",
  "make",
  "sudo make install",
].join("\n");

const SSHPASS_MAC = [
  "Install sshpass on macOS:",
  "",
  "### Homebrew:",
  "brew install sshpass",
  "brew install hudochenkov/sshpass/sshpass",
  "",
  "### MacPorts:",
  "sudo port install sshpass",
  "",
  "### Build from source:",
  "curl -LO https://sourceforge.net/projects/sshpass/files/sshpass/1.10/sshpass-1.10.tar.gz",
  "tar -xzf sshpass-1.10.tar.gz",
  "cd sshpass-1.10",
  "./configure",
  "make",
  "sudo make install",
  "",
  "### Nix package manager:",
  "nix-env -iA nixpkgs.sshpass",
].join("\n");

const SSHPASS_WSL = [
  "Install sshpass inside WSL:",
  "",
  "run a WSL",
  "",
  "### WSL-Debian/Ubuntu:",
  "   apt install sshpass",
  "   sudo apt install sshpass",
  "",
  "#### WSL-RHEL/CentOS/Fedora:",
  "   sudo yum install sshpass",
  "   sudo dnf install sshpass",
  "",
  "### WSL-Arch Linux:",
  "   pacman -S sshpass",
  "",
  "### WSL-From source (if not in your repos):",
  "   wget https://sourceforge.net/projects/sshpass/files/latest/download -O sshpass.tar.gz",
  "   tar -xzf sshpass.tar.gz",
  "   cd sshpass-*",
  "   ./configure",
  "   make",
  "   sudo make install",
].join("\n");

const WSL_HELP = [
  "Install WSL on Windows:",
  "",
  "### Step 1 : Install Windows Subsystem for Linux (WSL)",
  "   wsl --install",
  "   reboot",
  "",
  "### Step 2 : Install a Linux Distribution",
  "   wsl --list --online",
  "   wsl --install -d Debian",
].join("\n");

const SSHPASS_WIN = [
  "Install sshpass on Windows:",
  "",
  "### Option 1 : KYNOCI-sshpass",
  "- A fork of XHCODING-sshpass with security and terminal fixes",
  "- Improved for Visual C++ 64-bit Runtime",
  "- Download and run the installer",
  "",
  "### Option 2 : XHCODING-sshpass",
  "- Original port of Linux sshpass to Windows",
  "- Install via :",
  "   winget install xhcoding.sshpass-win32",
  "- Restart VScode",
].join("\n");
