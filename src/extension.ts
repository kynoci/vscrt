// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import * as fs from "fs";
import { execSync } from "child_process";
import type { CRTTarget } from "./treeView/treeTarget";
import { CRTWebviewProvider } from "./treeView/webviewTree";
import { openServerForm, ServerFormData } from "./treeView/serverForm";
import {
  CRTConfig,
  CRTConfigNode,
  CRTConfigService,
} from "./config/vscrtConfig";
import { CRTSecretService } from "./config/vscrtSecret";
import { CRTPassphraseService } from "./config/vscrtPassphrase";
import { CRTSshService } from "./ssh/sshConnect";
import {
  cleanupAllNowSync,
  cleanupOrphanFiles,
  cleanupTerminal,
} from "./ssh/sshPasswordDelivery";
// import { pickWslDistroWithSshpassSync } from "./utils/wslSshpass";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "vsCRT" is now active!');

  const passphraseService = new CRTPassphraseService(context.secrets);
  const secretService = new CRTSecretService(context.secrets, passphraseService);
  const configManager = new CRTConfigService(secretService, context.extensionUri);
  const sshService = new CRTSshService(secretService);

  // CONNECTION view – webview-based cluster/server tree
  const connectionView = new CRTWebviewProvider(
    configManager,
    context.extensionUri,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "vscrt.connectionView",
      connectionView,
    ),
  );

  // STATUS view – shows WSL and sshpass availability
  const statusProvider = new StatusProvider();
  vscode.window.registerTreeDataProvider("vscrt.statusView", statusProvider);

  const openConfigCommand = vscode.commands.registerCommand(
    "vsCRT.openConfig",
    () => configManager.openConfigFile(),
  );
  const addServerCommand = vscode.commands.registerCommand(
    "vsCRT.addServer",
    async (target?: CRTTarget) => {
      let targetClusterName: string | null = null;
      if (
        target &&
        (target.item.type === "cluster" || target.item.type === "subcluster")
      ) {
        targetClusterName = target.item.label;
      }

      // No folder context (top-bar button / Command Palette) — ask which folder.
      if (!targetClusterName) {
        const folderPaths = await configManager.getAllFolderPaths();
        if (folderPaths.length === 0) {
          vscode.window.showErrorMessage(
            "vsCRT: create a folder first — servers must live inside a folder.",
          );
          return;
        }
        const pick = await vscode.window.showQuickPick(folderPaths, {
          title: "Add Server — pick a folder",
          placeHolder: "Which folder should the new server live in?",
          ignoreFocusOut: true,
        });
        if (!pick) {
          return;
        }
        targetClusterName = pick.split("/").pop() ?? pick;
      }

      const form = await openServerForm(context.extensionUri, {
        targetClusterName,
      });
      if (!form) {
        return;
      }

      const ok = await configManager.appendNode(targetClusterName, {
        name: form.name,
        endpoint: form.endpoint,
        icon: form.icon,
        terminalLocation: form.terminalLocation,
        preferredAuthentication: form.preferredAuthentication,
        identityFile: form.identityFile,
        password: form.password,
        passwordStorage:
          form.passwordStorage === "passphrase" ? "passphrase" : undefined,
      });

      if (!ok) {
        vscode.window.showErrorMessage(
          `vsCRT: Could not find folder "${targetClusterName}" in vscrtConfig.json`,
        );
        return;
      }

      await connectionView.reload();

      vscode.window.showInformationMessage(
        `vsCRT: Added server "${form.name}" under ${targetClusterName}.`,
      );
    },
  );

  const editServerCommand = vscode.commands.registerCommand(
    "vsCRT.editServer",
    async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage(
          "vsCRT: select a server node to edit.",
        );
        return;
      }
      const existing = target.item.config;
      const oldPath = target.item.path;
      const parentSegments = oldPath.split("/");
      const parentClusterName =
        parentSegments.length > 1
          ? parentSegments[parentSegments.length - 2]
          : null;

      const form = await openServerForm(context.extensionUri, {
        targetClusterName: parentClusterName,
        existing,
      });
      if (!form) {
        return;
      }

      try {
        const newNode = await buildUpdatedNode(form, existing, secretService);
        const ok = await configManager.updateNode(oldPath, newNode);
        if (!ok) {
          vscode.window.showErrorMessage(
            `vsCRT: could not find "${existing.name}" in vscrtConfig.json.`,
          );
          return;
        }
        await connectionView.reload();
        vscode.window.showInformationMessage(
          `vsCRT: updated server "${form.name}".`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`vsCRT: edit failed — ${String(err)}`);
      }
    },
  );

  const renameClusterCommand = vscode.commands.registerCommand(
    "vsCRT.renameCluster",
    async (target?: CRTTarget) => {
      if (
        !target ||
        (target.item.type !== "cluster" && target.item.type !== "subcluster")
      ) {
        vscode.window.showErrorMessage(
          "vsCRT: select a folder to rename.",
        );
        return;
      }
      const oldName = target.item.label;
      const kindLabel = target.item.type === "subcluster" ? "Subfolder" : "Folder";

      const input = await vscode.window.showInputBox({
        title: `Rename ${kindLabel}`,
        prompt: `Enter a new name for "${oldName}"`,
        value: oldName,
        valueSelection: [0, oldName.length],
        ignoreFocusOut: true,
        validateInput: (v) => {
          const s = v.trim();
          if (!s) {
            return "Name cannot be empty.";
          }
          if (s.includes("/")) {
            return "Name cannot contain '/'.";
          }
          return null;
        },
      });
      if (!input) {
        return;
      }
      const newName = input.trim();
      if (newName === oldName) {
        return;
      }

      const ok = await configManager.renameCluster(target.item.path, newName);
      if (!ok) {
        vscode.window.showErrorMessage(
          `vsCRT: could not rename "${oldName}" — a sibling with that name may already exist.`,
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        `vsCRT: renamed "${oldName}" to "${newName}".`,
      );
    },
  );

  const deleteNodeCommand = vscode.commands.registerCommand(
    "vsCRT.deleteNode",
    async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage("vsCRT: select a server to delete.");
        return;
      }
      const name = target.item.label;
      const choice = await vscode.window.showWarningMessage(
        `Delete server "${name}"?`,
        {
          modal: true,
          detail: "This removes the entry and forgets its stored password.",
        },
        "Delete",
      );
      if (choice !== "Delete") {
        return;
      }
      const ok = await configManager.deleteNode(target.item.path);
      if (!ok) {
        vscode.window.showErrorMessage(
          `vsCRT: could not delete "${name}" — not found in config.`,
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(`vsCRT: deleted server "${name}".`);
    },
  );

  const deleteClusterCommand = vscode.commands.registerCommand(
    "vsCRT.deleteCluster",
    async (target?: CRTTarget) => {
      if (
        !target ||
        (target.item.type !== "cluster" && target.item.type !== "subcluster")
      ) {
        vscode.window.showErrorMessage(
          "vsCRT: select a folder to delete.",
        );
        return;
      }
      const name = target.item.label;
      const kindLabel =
        target.item.type === "subcluster" ? "subfolder" : "folder";

      const counts = await configManager.countClusterContents(target.item.path);
      const detail =
        counts && (counts.nodes > 0 || counts.subfolder > 0)
          ? `This will also remove ${counts.subfolder} subfolder(s) and ${counts.nodes} server(s), and forget any stored passwords.`
          : "This folder is empty.";

      const choice = await vscode.window.showWarningMessage(
        `Delete ${kindLabel} "${name}"?`,
        { modal: true, detail },
        "Delete",
      );
      if (choice !== "Delete") {
        return;
      }
      const ok = await configManager.deleteCluster(target.item.path);
      if (!ok) {
        vscode.window.showErrorMessage(
          `vsCRT: could not delete "${name}" — not found in config.`,
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        `vsCRT: deleted ${kindLabel} "${name}".`,
      );
    },
  );

  // 🔹 Add Cluster (folder) command
  const addClusterCommand = vscode.commands.registerCommand(
    "vsCRT.addCluster",
    async (treeItem?: CRTTarget) => {
      const name = await vscode.window.showInputBox({
        title: "Add Folder",
        prompt: "Enter folder / subfolder name:",
        placeHolder: "e.g. Production-2 or DB-ReadOnly",
        ignoreFocusOut: true,
      });
      if (!name) {
        return;
      }

      let parentName: string | null = null;

      // If user clicked on a cluster/subcluster, add under that
      if (treeItem) {
        if (
          treeItem.item.type === "cluster" ||
          treeItem.item.type === "subcluster"
        ) {
          parentName = treeItem.item.label;
        }
      }

      const ok = await configManager.appendCluster(parentName, name);
      if (!ok) {
        vscode.window.showErrorMessage(
          `vsCRT: Could not find parent folder "${parentName}" in vscrtConfig.json`,
        );
        return;
      }

      await connectionView.reload();

      vscode.window.showInformationMessage(
        `vsCRT: Added ${parentName ? "subfolder" : "folder"} "${name}".`,
      );
    },
  );

  const connectCommand = vscode.commands.registerCommand(
    "vsCRT.connect",
    async (
      treeItem: CRTTarget,
      opts?: {
        trigger?: "dblclick" | "button";
        location?: "panel" | "editor";
      },
    ) => {
      // Only works on nodes
      if (!treeItem || treeItem.item.type !== "node") {
        return;
      }
      const node = treeItem.item.config;
      const trigger = opts?.trigger ?? "button";
      const cfg = await configManager.loadConfig();
      const location = resolveTerminalLocation(
        node,
        trigger,
        opts?.location,
        cfg ?? undefined,
      );
      sshService.connectFromConfig(node, location);
    },
  );

  const connectAllInFolderCommand = vscode.commands.registerCommand(
    "vsCRT.connectAllInFolder",
    async (
      target?: CRTTarget,
      opts?: { trigger?: "dblclick" | "button" },
    ) => {
      if (
        !target ||
        (target.item.type !== "cluster" && target.item.type !== "subcluster")
      ) {
        vscode.window.showErrorMessage(
          "vsCRT: select a folder to connect all servers.",
        );
        return;
      }
      const nodes = await configManager.getAllNodesInFolder(target.item.path);
      if (!nodes) {
        vscode.window.showErrorMessage(
          `vsCRT: could not find folder "${target.item.label}".`,
        );
        return;
      }
      if (nodes.length === 0) {
        vscode.window.showInformationMessage(
          `vsCRT: folder "${target.item.label}" has no servers.`,
        );
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `Connect to all ${nodes.length} server(s) in "${target.item.label}"?`,
        {
          modal: true,
          detail:
            "Each server opens in its own terminal. Password prompts may appear for several servers.",
        },
        "Connect",
      );
      if (choice !== "Connect") {
        return;
      }

      const trigger = opts?.trigger ?? "dblclick";
      const cfg = await configManager.loadConfig();
      for (const node of nodes) {
        const location = resolveTerminalLocation(
          node,
          trigger,
          undefined,
          cfg ?? undefined,
        );
        sshService.connectFromConfig(node, location);
      }
    },
  );

  const duplicateNodeCommand = vscode.commands.registerCommand(
    "vsCRT.duplicateNode",
    async (target?: CRTTarget) => {
      if (!target || target.item.type !== "node") {
        vscode.window.showErrorMessage(
          "vsCRT: select a server to duplicate.",
        );
        return;
      }
      const originalName = target.item.label;
      const newName = await configManager.duplicateNode(target.item.path);
      if (!newName) {
        vscode.window.showErrorMessage(
          `vsCRT: could not duplicate "${originalName}".`,
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        `vsCRT: duplicated "${originalName}" as "${newName}".`,
      );
    },
  );

  const changePasswordCommand = vscode.commands.registerCommand(
    "vsCRT.changePassword",
    async (treeItem?: CRTTarget) => {
      if (!treeItem || treeItem.item.type !== "node") {
        vscode.window.showErrorMessage(
          "vsCRT: select a server node to change its password.",
        );
        return;
      }
      const nodeName = treeItem.item.config.name;
      const newPassword = await vscode.window.showInputBox({
        title: `Change Password for "${nodeName}"`,
        prompt: "Enter the new SSH password (stored in secure storage).",
        password: true,
        ignoreFocusOut: true,
      });
      if (!newPassword) {
        return;
      }
      const ok = await configManager.updatePassword(nodeName, newPassword);
      if (!ok) {
        vscode.window.showErrorMessage(
          `vsCRT: could not update password for "${nodeName}".`,
        );
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        `vsCRT: updated password for "${nodeName}".`,
      );
    },
  );

  const setPasswordStorageCommand = vscode.commands.registerCommand(
    "vsCRT.setPasswordStorage",
    async (treeItem?: CRTTarget) => {
      if (!treeItem || treeItem.item.type !== "node") {
        vscode.window.showErrorMessage(
          "vsCRT: select a server node to change its password storage.",
        );
        return;
      }
      const node = treeItem.item.config;
      const current = node.passwordStorage ?? "secretstorage";
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: "SecretStorage",
            description:
              current === "secretstorage" ? "(current)" : "OS keychain reference",
            value: "secretstorage" as const,
          },
          {
            label: "Passphrase-encrypted",
            description:
              current === "passphrase"
                ? "(current)"
                : "Argon2id + AES-GCM ciphertext in config",
            value: "passphrase" as const,
          },
        ],
        {
          title: `Password Storage for "${node.name}"`,
          ignoreFocusOut: true,
        },
      );
      if (!pick || pick.value === current) {
        return;
      }
      try {
        const ok = await configManager.setPasswordStorage(node.name, pick.value);
        if (!ok) {
          vscode.window.showErrorMessage(
            `vsCRT: could not change storage for "${node.name}".`,
          );
          return;
        }
      } catch (err) {
        vscode.window.showErrorMessage(`vsCRT: ${String(err)}`);
        return;
      }
      await connectionView.reload();
      vscode.window.showInformationMessage(
        `vsCRT: "${node.name}" now uses ${pick.label}.`,
      );
    },
  );

  const changeIconCommand = vscode.commands.registerCommand(
    "vsCRT.changeIcon",
    async (target?: CRTTarget) => {
      if (!target) {
        vscode.window.showErrorMessage(
          "vsCRT: select a folder or server to change its icon.",
        );
        return;
      }

      type IconPick = vscode.QuickPickItem & { id: string };
      // OS-labeled entries at the top — they reuse codicons that also
      // appear in the generic preset list below (codicons has no dedicated
      // macOS/Unix glyph, so we map them to the closest terminal-* icon).
      const osPicks: IconPick[] = [
        {
          label: "$(terminal-powershell) Windows",
          description: "PowerShell logo",
          id: "terminal-powershell",
        },
        {
          label: "$(terminal-bash) macOS",
          description: "bash prompt (no dedicated Apple codicon)",
          id: "terminal-bash",
        },
        {
          label: "$(terminal-linux) Linux",
          description: "Tux penguin",
          id: "terminal-linux",
        },
        {
          label: "$(terminal) Unix",
          description: "generic terminal prompt",
          id: "terminal",
        },
      ];
      const presetIcons = [
        "folder",
        "folder-library",
        "folder-opened",
        "organization",
        "server",
        "server-environment",
        "server-process",
        "vm",
        "vm-active",
        "cloud",
        "database",
        "rocket",
        "globe",
        "shield",
        "lock",
        "key",
        "terminal",
        "terminal-bash",
        "terminal-linux",
        "terminal-powershell",
        "terminal-ubuntu",
        "chip",
        "circuit-board",
        "package",
        "account",
        "star",
        "heart",
        "flame",
        "tools",
      ];
      const picks: IconPick[] = [
        ...osPicks,
        ...presetIcons.map((id) => ({
          label: `$(${id}) ${id}`,
          id,
        })),
      ];
      picks.push(
        {
          label: "$(edit) Custom codicon\u2026",
          description: "Type a codicon name manually",
          id: "__custom__",
        },
        {
          label: "$(discard) Reset to default",
          description: "Clear the icon override",
          id: "__reset__",
        },
      );

      const pick = await vscode.window.showQuickPick(picks, {
        title: `Change Icon — ${target.item.label}`,
        placeHolder: "Pick a codicon",
        matchOnDescription: true,
        ignoreFocusOut: true,
      });
      if (!pick) {
        return;
      }

      let iconName: string | undefined;
      if (pick.id === "__custom__") {
        iconName = await vscode.window.showInputBox({
          title: "Custom codicon",
          prompt:
            "Enter a codicon name (without the 'codicon-' prefix). See https://microsoft.github.io/vscode-codicons/",
          placeHolder: "e.g. database, rocket, shield",
          ignoreFocusOut: true,
          validateInput: (value) =>
            /^[a-z0-9-]+$/i.test(value.trim())
              ? null
              : "Use only letters, digits, and hyphens.",
        });
        iconName = iconName?.trim();
        if (!iconName) {
          return;
        }
      } else if (pick.id === "__reset__") {
        iconName = undefined;
      } else {
        iconName = pick.id;
      }

      const ok = await configManager.setIcon(
        target.item.path,
        target.item.type,
        iconName,
      );
      if (!ok) {
        vscode.window.showErrorMessage(
          `vsCRT: could not update icon for "${target.item.label}".`,
        );
        return;
      }
      await connectionView.reload();
    },
  );

  const lockPassphraseCommand = vscode.commands.registerCommand(
    "vsCRT.lockPassphrase",
    () => {
      passphraseService.lock();
      vscode.window.showInformationMessage(
        "vsCRT: passphrase locked. Next use will prompt again.",
      );
    },
  );

  const resetPassphraseCommand = vscode.commands.registerCommand(
    "vsCRT.resetPassphrase",
    async () => {
      const typed = await vscode.window.showInputBox({
        title: "vsCRT: Reset Passphrase",
        prompt:
          'Type RESET to discard the current passphrase setup. Existing enc:v3 ciphertexts will become unreadable.',
        ignoreFocusOut: true,
      });
      if (typed !== "RESET") {
        vscode.window.showInformationMessage("vsCRT: reset cancelled.");
        return;
      }
      await passphraseService.resetSetup();
      vscode.window.showWarningMessage(
        "vsCRT: passphrase setup wiped. Re-enter a new one on next use.",
      );
    },
  );

  const clearAllSecretsCommand = vscode.commands.registerCommand(
    "vsCRT.clearAllSecrets",
    async () => {
      const typed = await vscode.window.showInputBox({
        title: "vsCRT: Clear All Secrets",
        prompt: 'Type CLEAR to delete every stored SSH password.',
        ignoreFocusOut: true,
      });
      if (typed !== "CLEAR") {
        vscode.window.showInformationMessage("vsCRT: clear cancelled.");
        return;
      }
      await secretService.clearAll();
      vscode.window.showWarningMessage(
        "vsCRT: cleared all stored SSH passwords. Nodes now require manual password entry.",
      );
    },
  );

  const refreshCommand = vscode.commands.registerCommand("vsCRT.refresh", () =>
    connectionView.reload(),
  );

  const refreshStatusCommand = vscode.commands.registerCommand(
    "vsCRT.refreshStatus",
    () => statusProvider.refresh(),
  );

  function showSshpassHelp(text: string) {
    vscode.window
      .showInformationMessage(text, { modal: true }, "Copy")
      .then((choice) => {
        if (choice === "Copy") {
          vscode.env.clipboard.writeText(text);
        }
      });
  }

  const sshpassLinuxHelpCommand = vscode.commands.registerCommand(
    "vsCRT.sshpassLinuxHelp",
    () => {
      showSshpassHelp(
        [
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
        ].join("\n"),
      );
    },
  );

  const sshpassMacHelpCommand = vscode.commands.registerCommand(
    "vsCRT.sshpassMacHelp",
    () => {
      showSshpassHelp(
        [
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
        ].join("\n"),
      );
    },
  );

  const sshpassWslHelpCommand = vscode.commands.registerCommand(
    "vsCRT.sshpassWslHelp",
    () => {
      showSshpassHelp(
        [
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
        ].join("\n"),
      );
    },
  );

  const wslHelpCommand = vscode.commands.registerCommand(
    "vsCRT.wslHelp",
    () => {
      const message = [
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
      vscode.window.showInformationMessage(message, { modal: true });
    },
  );

  const sshpassWinHelpCommand = vscode.commands.registerCommand(
    "vsCRT.sshpassWinHelp",
    () => {
      const message = [
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
      vscode.window
        .showInformationMessage(
          message,
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
    },
  );

  // Clean up password files / pipe servers when their terminal closes.
  const terminalCloseSub = vscode.window.onDidCloseTerminal((term) => {
    cleanupTerminal(term);
  });

  // Sweep orphaned password files left behind by crashes.
  cleanupOrphanFiles().catch((err) =>
    console.warn("[vsCRT] orphan sweep failed:", err),
  );

  context.subscriptions.push(
    openConfigCommand,
    addServerCommand,
    addClusterCommand,
    connectCommand,
    connectAllInFolderCommand,
    duplicateNodeCommand,
    changePasswordCommand,
    setPasswordStorageCommand,
    editServerCommand,
    renameClusterCommand,
    deleteNodeCommand,
    deleteClusterCommand,
    changeIconCommand,
    lockPassphraseCommand,
    resetPassphraseCommand,
    clearAllSecretsCommand,
    refreshCommand,
    refreshStatusCommand,
    sshpassLinuxHelpCommand,
    sshpassMacHelpCommand,
    sshpassWinHelpCommand,
    sshpassWslHelpCommand,
    wslHelpCommand,
    terminalCloseSub,
  );
}

// This method is called when your extension is deactivated
export function deactivate() {
  cleanupAllNowSync();
}

/**
 * Resolve where the SSH terminal should open for this connect invocation.
 * Precedence (higher wins):
 *   1. Explicit `override` (e.g. the inline "open in editor" button on a row).
 *   2. Per-node `terminalLocation` field in vscrtConfig.json.
 *   3. Top-level setting in vscrtConfig.json:
 *        dblclick → "vsCRT.doubleClickTerminalLocation"
 *        button   → "vsCRT.buttonClickTerminalLocation"
 *   4. VS Code user/workspace setting of the same name (no prefix key).
 *   5. Hardcoded fallback: dblclick → editor, button → panel.
 */
function resolveTerminalLocation(
  node: CRTConfigNode,
  trigger: "dblclick" | "button",
  override?: "panel" | "editor",
  fileConfig?: CRTConfig,
): "panel" | "editor" {
  if (override === "panel" || override === "editor") {
    return override;
  }
  if (node.terminalLocation === "panel" || node.terminalLocation === "editor") {
    return node.terminalLocation;
  }

  const fileKey =
    trigger === "dblclick"
      ? "vsCRT.doubleClickTerminalLocation"
      : "vsCRT.buttonClickTerminalLocation";
  const fromFile = fileConfig?.[fileKey];
  if (fromFile === "panel" || fromFile === "editor") {
    return fromFile;
  }

  const cfg = vscode.workspace.getConfiguration("vsCRT");
  const settingKey =
    trigger === "dblclick"
      ? "doubleClickTerminalLocation"
      : "buttonClickTerminalLocation";
  const fallback: "panel" | "editor" =
    trigger === "dblclick" ? "editor" : "panel";
  const v = cfg.get<string>(settingKey);
  return v === "editor" || v === "panel" ? v : fallback;
}

/**
 * Merge a form submission with the existing node config. Handles the
 * password / storage-mode transitions so secrets get re-sealed under the
 * right scheme (OS keychain vs. passphrase) and stale references get cleaned
 * up from SecretStorage.
 */
async function buildUpdatedNode(
  form: ServerFormData,
  existing: CRTConfigNode,
  secretService?: CRTSecretService,
): Promise<CRTConfigNode> {
  const newNode: CRTConfigNode = { ...existing };

  newNode.name = form.name;
  newNode.endpoint = form.endpoint;
  if (form.icon) {
    newNode.icon = form.icon;
  } else {
    delete newNode.icon;
  }
  if (form.terminalLocation === "panel" || form.terminalLocation === "editor") {
    newNode.terminalLocation = form.terminalLocation;
  } else {
    delete newNode.terminalLocation;
  }
  newNode.preferredAuthentication = form.preferredAuthentication;

  if (form.preferredAuthentication === "password") {
    delete newNode.identityFile;
    const newStorage =
      form.passwordStorage === "passphrase" ? "passphrase" : "secretstorage";

    if (form.password && secretService) {
      // User typed a new plaintext — drop old reference, seal the new one.
      if (existing.password) {
        await secretService.forget(existing.password);
      }
      newNode.password = await secretService.seal(form.password, newStorage);
    } else if (
      existing.password &&
      secretService &&
      (existing.passwordStorage ?? "secretstorage") !== newStorage
    ) {
      // Storage mode changed but password unchanged — re-seal under new mode.
      const plaintext = await secretService.unseal(existing.password);
      if (plaintext !== undefined) {
        await secretService.forget(existing.password);
        newNode.password = await secretService.seal(plaintext, newStorage);
      }
    }
    // else: keep the existing stored reference as-is.

    if (newStorage === "passphrase") {
      newNode.passwordStorage = "passphrase";
    } else {
      delete newNode.passwordStorage;
    }
  } else {
    // Switched to public key — drop password fields and clear any stored secret.
    if (existing.password && secretService) {
      await secretService.forget(existing.password);
    }
    delete newNode.password;
    delete newNode.passwordStorage;
    newNode.identityFile = form.identityFile;
  }

  return newNode;
}

/** Minimal tree provider that shows a single placeholder message */
const SSHPASS_PATH =
  process.platform === "win32"
    ? "C:\\Windows\\System32\\OpenSSH\\sshpass.exe"
    : process.platform === "darwin"
      ? "/usr/local/bin/sshpass"
      : "/usr/bin/sshpass";
const SSHPASS_DOWNLOAD = "https://www.kynoci.com/sshpass-windows";

/** TreeItem that can carry nested children for the STATUS view */
class StatusTreeItem extends vscode.TreeItem {
  children?: vscode.TreeItem[];
}

/** Shows WSL and sshpass availability in the STATUS view */
class StatusProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element && element instanceof StatusTreeItem && element.children) {
      return element.children;
    }
    return this.getRootItems();
  }

  private getRootItems(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];

    // OS check
    const platform = process.platform;
    const osLabel =
      platform === "win32"
        ? "Windows"
        : platform === "darwin"
          ? "macOS"
          : "Linux";
    const osIcon =
      platform === "win32"
        ? "window"
        : platform === "darwin"
          ? "device-desktop"
          : "terminal-linux";
    const osItem = new vscode.TreeItem(`OS: ${osLabel}`);
    osItem.iconPath = new vscode.ThemeIcon(osIcon);
    osItem.description = `${process.arch}, ${process.version}`;
    items.push(osItem);

    // WSL check (Windows only)
    let wslInstalled = false;
    let distros: string[] = [];
    let wslSshpassOk = false;
    let defaultDistro = "";
    if (platform === "win32") {
      try {
        const output = execSync("wsl --list --quiet", {
          encoding: "utf-8",
          timeout: 5000,
        }).replace(/\0/g, "").trim();
        distros = output.split(/\r?\n/).filter(Boolean);
        if (distros.length > 0) {
          wslInstalled = true;
        }
      } catch {
        // wsl command not found or failed
      }

      if (wslInstalled) {
        try {
          defaultDistro = execSync("wsl -- sh -c 'echo $WSL_DISTRO_NAME'", {
            encoding: "utf-8",
            timeout: 5000,
          }).replace(/\0/g, "").trim();
        } catch {
          // fall through; we'll still try the sshpass check
        }
        try {
          execSync("wsl -- command -v sshpass", {
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "ignore"],
          });
          wslSshpassOk = true;
        } catch {
          // sshpass not installed in default distro
        }
      }
    }

    const sshpassFoundPaths: string[] = [];
    if (fs.existsSync(SSHPASS_PATH)) {
      sshpassFoundPaths.push(SSHPASS_PATH);
    }
    if (platform === "win32") {
      // Also check PATH (catches winget installs like xhcoding.sshpass-win32)
      try {
        const out = execSync("where sshpass", {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        for (const line of out.split(/\r?\n/)) {
          const path = line.trim();
          if (path && !sshpassFoundPaths.includes(path)) {
            sshpassFoundPaths.push(path);
          }
        }
      } catch {
        // sshpass not on PATH
      }
    }
    const sshpassExists = sshpassFoundPaths.length > 0;

    // On Windows, sshpass and WSL sshpass are alternatives — when at least
    // one is available, downgrade the missing one's icon from red ✗ to a
    // softer orange ring (still visible, but not a hard failure).
    const downgradeMissing =
      platform === "win32" && (sshpassExists || wslSshpassOk);
    const missingIcon = (): vscode.ThemeIcon =>
      downgradeMissing
        ? new vscode.ThemeIcon(
            "circle-large-outline",
            new vscode.ThemeColor("notificationsWarningIcon.foreground"),
          )
        : new vscode.ThemeIcon(
            "close",
            new vscode.ThemeColor("testing.iconFailed"),
          );
    const okIcon = (): vscode.ThemeIcon =>
      new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("testing.iconPassed"),
      );

    if (platform === "win32") {
      const wslItem = new vscode.TreeItem(
        wslInstalled ? "WSL: Installed" : "WSL: Not found",
      );
      wslItem.iconPath = wslInstalled ? okIcon() : missingIcon();
      wslItem.description = wslInstalled
        ? distros.join(", ")
        : "Click for install instructions";
      if (!wslInstalled) {
        wslItem.command = {
          command: "vsCRT.wslHelp",
          title: "Install WSL",
        };
      }
      items.push(wslItem);

      if (wslInstalled) {
        const wslSshpassItem = new vscode.TreeItem(
          wslSshpassOk
            ? "WSL sshpass: Installed"
            : "WSL sshpass: Not found",
        );
        wslSshpassItem.iconPath = wslSshpassOk ? okIcon() : missingIcon();
        const distroLabel = defaultDistro || "default distro";
        wslSshpassItem.description = wslSshpassOk
          ? distroLabel
          : `Not in ${distroLabel} — click for install instructions`;
        if (!wslSshpassOk) {
          wslSshpassItem.command = {
            command: "vsCRT.sshpassWslHelp",
            title: "Install sshpass in WSL",
          };
        }
        items.push(wslSshpassItem);
      }
    }

    // sshpass check
    const sshpassItem = new StatusTreeItem(
      sshpassExists ? "sshpass: Installed" : "sshpass: Not found",
    );
    sshpassItem.iconPath = sshpassExists ? okIcon() : missingIcon();
    if (sshpassExists) {
      sshpassItem.description = `${sshpassFoundPaths.length} found`;
      sshpassItem.tooltip = sshpassFoundPaths.join("\n");
      sshpassItem.collapsibleState =
        vscode.TreeItemCollapsibleState.Expanded;
      sshpassItem.children = sshpassFoundPaths.map((path) => {
        const child = new vscode.TreeItem(path);
        child.iconPath = new vscode.ThemeIcon("file");
        child.tooltip = path;
        return child;
      });
    } else if (platform === "darwin") {
      sshpassItem.description = "Click for install instructions";
      sshpassItem.command = {
        command: "vsCRT.sshpassMacHelp",
        title: "Install sshpass",
      };
    } else if (platform === "linux") {
      sshpassItem.description = "Click for install instructions";
      sshpassItem.command = {
        command: "vsCRT.sshpassLinuxHelp",
        title: "Install sshpass",
      };
    } else {
      sshpassItem.description = "Click for install instructions";
      sshpassItem.command = {
        command: "vsCRT.sshpassWinHelp",
        title: "Install sshpass",
      };
    }
    items.push(sshpassItem);

    return items;
  }
}
