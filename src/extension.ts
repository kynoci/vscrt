// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import {
  CRTDragAndDropController,
  CRTProvider,
  CRTTreeItem,
} from "./TreeView/treeview";
import { CRTConfigService } from "./ConfigSSH/crtConfig";
import { CRTSshService } from "./ssh/sshConnect";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "vsCRT" is now active!');

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const disposable = vscode.commands.registerCommand("vsCRT.helloWorld", () => {
    // The code you place here will be executed every time your command is executed
    // Display a message box to the user
    vscode.window.showInformationMessage("Hello World from vsCRT!");
  });
  // Second command
  const secondCommand = vscode.commands.registerCommand(
    "vsCRT.mySecondCommand",
    () => {
      vscode.window.showInformationMessage("This is my second command!");
    }
  );
  const serverProvider = new CRTProvider();
  const configManager = new CRTConfigService();
  const sshService = new CRTSshService();

  vscode.window.createTreeView("vscrt.mainView", {
    treeDataProvider: serverProvider,
    dragAndDropController: new CRTDragAndDropController(
      configManager,
      serverProvider
    ),
  });

  const openConfigCommand = vscode.commands.registerCommand(
    "vsCRT.openConfig",
    () => configManager.openConfigFile()
  );
  const addServerCommand = vscode.commands.registerCommand(
    "vsCRT.addServer",
    async (treeItem?: CRTTreeItem) => {
      let targetClusterName: string | null = null;

      if (treeItem) {
        if (
          treeItem.item.type === "cluster" ||
          treeItem.item.type === "subcluster"
        ) {
          targetClusterName = treeItem.item.label;
        }
      }

      const name = await vscode.window.showInputBox({
        title: "Add Server",
        prompt: "Enter server name:",
        placeHolder: "Prod Web 2",
        ignoreFocusOut: true,
      });
      if (!name) {
        return;
      }

      const endpoint = await vscode.window.showInputBox({
        title: "Add Server",
        prompt: "Enter SSH endpoint (user@host):",
        placeHolder: "deploy@1.2.3.4",
        ignoreFocusOut: true,
      });
      if (!endpoint) {
        return;
      }

      const portStr = await vscode.window.showInputBox({
        title: "Add Server",
        prompt: "Enter SSH port (optional):",
        placeHolder: "22",
        ignoreFocusOut: true,
      });

      const port = portStr ? parseInt(portStr, 10) : undefined;

      const authPick = await vscode.window.showQuickPick(
        [
          {
            label: "Password",
            description: "Use sshpass (stored in config)",
            value: "password" as const,
          },
          {
            label: "Public Key (cert)",
            description:
              "Use SSH key + optionally install public key to server now",
            value: "publickey" as const,
          },
        ],
        { title: "SSH Authentication Method", ignoreFocusOut: true }
      );

      if (!authPick) {
        return;
      }

      let preferredAuthentication = authPick.value;
      let identityFile: string | undefined;
      let password: string | undefined;

      if (authPick.value === "password") {
        password = await vscode.window.showInputBox({
          title: "SSH Password",
          prompt: "Enter SSH password (stored in configSSH.json as plain text)",
          password: true,
          ignoreFocusOut: true,
        });
        if (!password) {
          return;
        }

        vscode.window.showWarningMessage(
          "vsCRT: Password will be stored in plain text in configSSH.json. Public key is recommended."
        );
      }
      if (authPick.value === "publickey") {
        identityFile = await vscode.window.showInputBox({
          title: "SSH Private Key",
          prompt:
            "Enter PRIVATE key path (NOT .pub). Example: ~/.ssh/id_ed25519",
          placeHolder: "~/.ssh/id_ed25519",
          ignoreFocusOut: true,
        });
        if (!identityFile) {
          return;
        }

        // ⚠ guard: user typed .pub
        if (identityFile.trim().endsWith(".pub")) {
          vscode.window.showErrorMessage(
            "vsCRT: Please enter the PRIVATE key file (no .pub)."
          );
          return;
        }

        // Ask if want to install public key now
        const installNow = await vscode.window.showQuickPick(
          [
            { label: "Yes, install public key now (recommended)", value: true },
            { label: "No, I already installed it", value: false },
          ],
          { title: "Install public key to server?", ignoreFocusOut: true }
        );
        if (!installNow) {
          return;
        }

        if (installNow.value === true) {
          // one-time password to install pubkey
          const oneTimePw = await vscode.window.showInputBox({
            title: "One-time password (for installing public key)",
            prompt: "Enter SSH password once to copy your public key to server",
            password: true,
            ignoreFocusOut: true,
          });
          if (!oneTimePw) {
            return;
          }
        }
      }

      const ok = await configManager.appendNode(targetClusterName, {
        name,
        endpoint,
        port,
        preferredAuthentication,
        identityFile,
        password,
      });

      if (!ok) {
        vscode.window.showErrorMessage(
          `vsCRT: Could not find cluster "${targetClusterName}" in configSSH.json`
        );
        return;
      }

      await serverProvider.reloadFromConfig();

      vscode.window.showInformationMessage(
        `vsCRT: Added server "${name}"${
          targetClusterName ? ` under ${targetClusterName}` : ""
        }.`
      );
    }
  );

  // 🔹 Add Cluster (folder) command
  const addClusterCommand = vscode.commands.registerCommand(
    "vsCRT.addCluster",
    async (treeItem?: CRTTreeItem) => {
      const name = await vscode.window.showInputBox({
        title: "Add Cluster",
        prompt: "Enter cluster / subcluster name:",
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
          `vsCRT: Could not find parent cluster "${parentName}" in configSSH.json`
        );
        return;
      }

      await serverProvider.reloadFromConfig();

      vscode.window.showInformationMessage(
        `vsCRT: Added ${parentName ? "subcluster" : "cluster"} "${name}".`
      );
    }
  );

  const connectCommand = vscode.commands.registerCommand(
    "vsCRT.connect",
    (treeItem: CRTTreeItem) => {
      // Only works on nodes
      if (!treeItem || treeItem.item.type !== "node") {
        return;
      }

      sshService.connectFromConfig(treeItem.item.config);
    }
  );

  context.subscriptions.push(
    disposable,
    secondCommand,
    openConfigCommand,
    addServerCommand,
    addClusterCommand,
    connectCommand
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}
