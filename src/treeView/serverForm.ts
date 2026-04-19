import * as vscode from "vscode";
import {
  ServerFormData,
  ServerFormOptions,
  isValidData,
} from "./serverFormModel";
import { renderServerFormHtml } from "./serverFormHtml";

/** Re-exports so existing `import { ... } from "./serverForm"` stays valid. */
export { ServerFormData, ServerFormOptions } from "./serverFormModel";

/**
 * Open a webview panel form for adding or editing a server. Resolves with
 * the submitted form data, or `undefined` if the user cancels or closes the
 * panel.
 */
export function openServerForm(
  extensionUri: vscode.Uri,
  opts: ServerFormOptions,
): Promise<ServerFormData | undefined> {
  const { targetClusterName, existing } = opts;
  const isEdit = !!existing;
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      isEdit ? "vscrt.editServer" : "vscrt.addServer",
      isEdit
        ? `Edit Server \u2014 ${existing.name}`
        : targetClusterName
          ? `Add Server \u2014 ${targetClusterName}`
          : "Add Server",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(
            extensionUri,
            "node_modules",
            "@vscode",
            "codicons",
            "dist",
          ),
          vscode.Uri.joinPath(extensionUri, "media"),
        ],
      },
    );

    let resolved = false;
    const complete = (data: ServerFormData | undefined): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(data);
      try {
        panel.dispose();
      } catch {
        /* already disposed */
      }
    };

    panel.webview.html = renderServerFormHtml(
      panel.webview,
      extensionUri,
      targetClusterName,
      existing,
    );

    panel.webview.onDidReceiveMessage((msg) => {
      if (!msg || typeof msg !== "object") {
        return;
      }
      if (msg.type === "submit" && isValidData(msg.data, existing)) {
        complete(msg.data);
      } else if (msg.type === "cancel") {
        complete(undefined);
      }
    });

    panel.onDidDispose(() => complete(undefined));
  });
}
