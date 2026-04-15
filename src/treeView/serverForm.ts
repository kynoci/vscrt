import * as vscode from "vscode";
import { CRTConfigNode } from "../config/vscrtConfig";

export type ServerFormData = {
  name: string;
  endpoint: string;
  icon?: string;
  terminalLocation?: "panel" | "editor"; // per-node override; undefined = use user settings
  preferredAuthentication: "password" | "publickey";
  password?: string; // plaintext; omitted when editing and user left it blank
  passwordStorage?: "secretstorage" | "passphrase";
  identityFile?: string;
  installPublicKeyNow?: boolean;
  oneTimePassword?: string;
};

export interface ServerFormOptions {
  /** For add mode: the cluster the new server will live under. For edit mode: the cluster of the node being edited. */
  targetClusterName: string | null;
  /** When provided, the form opens in EDIT mode pre-filled from this node. */
  existing?: CRTConfigNode;
}

/**
 * Open a webview panel form for adding or editing a server. Returns the form
 * data on submit, or undefined if the user cancels or closes the panel.
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
        ],
      },
    );

    let resolved = false;
    const complete = (data: ServerFormData | undefined) => {
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

    panel.webview.html = getHtml(
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

function isValidData(
  data: unknown,
  existing: CRTConfigNode | undefined,
): data is ServerFormData {
  if (!data || typeof data !== "object") {
    return false;
  }
  const d = data as Partial<ServerFormData>;
  if (typeof d.name !== "string" || !d.name.trim()) {
    return false;
  }
  if (typeof d.endpoint !== "string" || !d.endpoint.trim()) {
    return false;
  }
  if (d.icon !== undefined) {
    if (typeof d.icon !== "string" || !/^[a-z0-9-]+$/i.test(d.icon)) {
      return false;
    }
  }
  if (d.terminalLocation !== undefined) {
    if (
      d.terminalLocation !== "panel" &&
      d.terminalLocation !== "editor"
    ) {
      return false;
    }
  }
  if (
    d.preferredAuthentication !== "password" &&
    d.preferredAuthentication !== "publickey"
  ) {
    return false;
  }
  if (d.preferredAuthentication === "password") {
    // Password required on add; optional on edit when user is keeping the existing one.
    const canReuseExistingPassword =
      !!existing &&
      existing.preferredAuthentication === "password" &&
      !!existing.password;
    if (typeof d.password !== "string" || !d.password) {
      if (!canReuseExistingPassword) {
        return false;
      }
      // password omitted on edit with existing secret is fine
    }
    if (
      d.passwordStorage !== "secretstorage" &&
      d.passwordStorage !== "passphrase"
    ) {
      return false;
    }
  } else {
    if (typeof d.identityFile !== "string" || !d.identityFile.trim()) {
      return false;
    }
    if (d.identityFile.trim().endsWith(".pub")) {
      return false;
    }
    if (
      d.installPublicKeyNow &&
      (typeof d.oneTimePassword !== "string" || !d.oneTimePassword)
    ) {
      return false;
    }
  }
  return true;
}

function generateNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  targetClusterName: string | null,
  existing: CRTConfigNode | undefined,
): string {
  const nonce = generateNonce();
  const codiconsCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "node_modules",
      "@vscode",
      "codicons",
      "dist",
      "codicon.css",
    ),
  );
  const csp = [
    "default-src 'none'",
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "img-src data:",
  ].join("; ");

  const isEdit = !!existing;
  const title = isEdit ? "Edit Server" : "Add Server";
  const submitLabel = isEdit ? "Save Changes" : "Add Server";
  const targetLabel = targetClusterName
    ? escapeHtml(targetClusterName)
    : "(root)";

  const v = {
    name: existing ? escapeHtml(existing.name) : "",
    endpoint: existing ? escapeHtml(existing.endpoint) : "",
    icon: existing?.icon ? escapeHtml(existing.icon) : "",
    identityFile: existing?.identityFile
      ? escapeHtml(existing.identityFile)
      : "",
  };
  const authIsPassword =
    !existing || existing.preferredAuthentication !== "publickey";
  const storageIsPassphrase = existing?.passwordStorage === "passphrase";
  const termLoc: "default" | "panel" | "editor" =
    existing?.terminalLocation === "panel"
      ? "panel"
      : existing?.terminalLocation === "editor"
        ? "editor"
        : "default";

  // Pass only booleans + strings that can't leak secrets to the client.
  const editFlags = {
    isEdit,
    hasExistingPassword:
      !!existing &&
      existing.preferredAuthentication === "password" &&
      !!existing.password,
    originalAuth: existing?.preferredAuthentication ?? "",
  };
  const editFlagsJson = JSON.stringify(editFlags);

  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${codiconsCssUri}" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  #wrap {
    max-width: 560px;
    margin: 24px auto;
    padding: 0 24px 48px;
  }
  h2 { margin: 0 0 4px; font-size: 1.4em; font-weight: 600; }
  .target { color: var(--vscode-descriptionForeground); margin-bottom: 24px; font-size: 0.95em; }
  .target .codicon { vertical-align: middle; margin-right: 4px; font-size: 14px; }
  .field { margin-bottom: 16px; }
  .field > label { display: block; margin-bottom: 4px; font-weight: 500; }
  .req { color: var(--vscode-errorForeground); margin-left: 2px; }
  input[type="text"], input[type="password"], input[type="number"] {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
    outline: none;
  }
  input:focus { border-color: var(--vscode-focusBorder); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .radio-group { display: flex; gap: 16px; flex-wrap: wrap; }
  .radio, .checkbox {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-weight: normal;
  }
  .radio input, .checkbox input {
    accent-color: var(--vscode-focusBorder);
  }
  fieldset {
    margin: 8px 0 16px;
    padding: 12px 16px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    border-radius: 4px;
  }
  fieldset legend {
    padding: 0 6px;
    color: var(--vscode-descriptionForeground);
    font-weight: 500;
  }
  .error {
    color: var(--vscode-errorForeground);
    font-size: 0.9em;
    margin-top: 4px;
  }
  .error:empty { display: none; }
  .hint {
    color: var(--vscode-descriptionForeground);
    font-size: 0.88em;
    margin-top: 4px;
  }
  #buttons {
    margin-top: 24px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  button {
    padding: 6px 16px;
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    border: 1px solid transparent;
  }
  button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border-color: var(--vscode-button-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  }
  button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  .hidden { display: none; }
</style>
</head>
<body>
<div id="wrap">
  <h2>${title}</h2>
  <div class="target">
    <i class="codicon codicon-folder"></i>
    <span>${isEdit ? "Location" : "Target"}:</span>
    <strong id="target-label">${targetLabel}</strong>
  </div>

  <div class="field">
    <label for="name">Name<span class="req">*</span></label>
    <input id="name" type="text" placeholder="e.g. Prod Web 2" value="${v.name}" autofocus />
    <div class="error" data-for="name"></div>
  </div>

  <div class="field">
    <label for="endpoint">SSH endpoint<span class="req">*</span></label>
    <input id="endpoint" type="text" placeholder="user@host or user@host:port" value="${v.endpoint}" />
    <div class="hint">Append <code>:port</code> to override the default port 22.</div>
    <div class="error" data-for="endpoint"></div>
  </div>

  <div class="field">
    <label for="icon">Icon</label>
    <input id="icon" type="text" placeholder="codicon name (e.g. database) \u2014 optional" value="${v.icon}" />
    <div class="hint">
      Codicon name without the <code>codicon-</code> prefix. Leave blank for the default terminal icon.
    </div>
    <div class="error" data-for="icon"></div>
  </div>

  <div class="field">
    <label>Terminal location</label>
    <div class="radio-group">
      <label class="radio"><input type="radio" name="termloc" value="default" ${termLoc === "default" ? "checked" : ""} /> Use user setting</label>
      <label class="radio"><input type="radio" name="termloc" value="panel"   ${termLoc === "panel" ? "checked" : ""} /> Panel (bottom)</label>
      <label class="radio"><input type="radio" name="termloc" value="editor"  ${termLoc === "editor" ? "checked" : ""} /> Editor (full tab)</label>
    </div>
    <div class="hint">
      Per-node override. "Use user setting" falls back to <code>vsCRT.doubleClickTerminalLocation</code> / <code>vsCRT.buttonClickTerminalLocation</code> based on how Connect is invoked.
    </div>
  </div>

  <div class="field">
    <label>Authentication<span class="req">*</span></label>
    <div class="radio-group">
      <label class="radio"><input type="radio" name="auth" value="password" ${authIsPassword ? "checked" : ""} /> Password</label>
      <label class="radio"><input type="radio" name="auth" value="publickey" ${authIsPassword ? "" : "checked"} /> Public Key</label>
    </div>
  </div>

  <fieldset id="sect-password" class="${authIsPassword ? "" : "hidden"}">
    <legend>Password</legend>
    <div class="field">
      <label for="password">Password<span class="req" id="password-req">*</span></label>
      <input id="password" type="password" autocomplete="new-password" placeholder="${isEdit ? "Leave blank to keep existing" : ""}" />
      <div class="error" data-for="password"></div>
    </div>
    <div class="field">
      <label>Storage</label>
      <div class="radio-group">
        <label class="radio"><input type="radio" name="storage" value="secretstorage" ${storageIsPassphrase ? "" : "checked"} /> OS keychain (recommended)</label>
        <label class="radio"><input type="radio" name="storage" value="passphrase" ${storageIsPassphrase ? "checked" : ""} /> Passphrase-encrypted in config</label>
      </div>
      <div class="hint">
        OS keychain: only a reference ID is stored in <code>vscrtConfig.json</code>. Passphrase: Argon2id + AES-GCM ciphertext stored inline, portable across machines.
      </div>
    </div>
  </fieldset>

  <fieldset id="sect-publickey" class="${authIsPassword ? "hidden" : ""}">
    <legend>Public Key</legend>
    <div class="field">
      <label for="identityFile">Private key path<span class="req">*</span></label>
      <input id="identityFile" type="text" placeholder="~/.ssh/id_ed25519" value="${v.identityFile}" />
      <div class="hint">Path to the PRIVATE key (not the <code>.pub</code> file).</div>
      <div class="error" data-for="identityFile"></div>
    </div>
    <div class="field ${isEdit ? "hidden" : ""}">
      <label class="checkbox">
        <input id="installPublicKeyNow" type="checkbox" />
        Install public key to the server now
      </label>
    </div>
    <div id="sect-otp" class="field hidden">
      <label for="oneTimePassword">One-time SSH password<span class="req">*</span></label>
      <input id="oneTimePassword" type="password" autocomplete="new-password" />
      <div class="hint">Used once to copy the public key to the server.</div>
      <div class="error" data-for="oneTimePassword"></div>
    </div>
  </fieldset>

  <div id="buttons">
    <button id="cancel" class="secondary" type="button">Cancel</button>
    <button id="submit" class="primary" type="button">${submitLabel}</button>
  </div>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = function (id) { return document.getElementById(id); };
  const editFlags = ${editFlagsJson};

  const nameEl = $('name');
  const endpointEl = $('endpoint');
  const iconEl = $('icon');
  const passwordEl = $('password');
  const identityFileEl = $('identityFile');
  const installEl = $('installPublicKeyNow');
  const otpEl = $('oneTimePassword');
  const otpSection = $('sect-otp');
  const sectPassword = $('sect-password');
  const sectPublicKey = $('sect-publickey');
  const submitBtn = $('submit');
  const cancelBtn = $('cancel');

  function currentAuth() {
    const nodes = document.querySelectorAll('input[name="auth"]');
    for (let i = 0; i < nodes.length; i++) if (nodes[i].checked) return nodes[i].value;
    return 'password';
  }
  function currentStorage() {
    const nodes = document.querySelectorAll('input[name="storage"]');
    for (let i = 0; i < nodes.length; i++) if (nodes[i].checked) return nodes[i].value;
    return 'secretstorage';
  }
  function currentTermLoc() {
    const nodes = document.querySelectorAll('input[name="termloc"]');
    for (let i = 0; i < nodes.length; i++) if (nodes[i].checked) return nodes[i].value;
    return 'default';
  }

  function updateAuthVisibility() {
    const a = currentAuth();
    sectPassword.classList.toggle('hidden', a !== 'password');
    sectPublicKey.classList.toggle('hidden', a !== 'publickey');
    // Hide the password "*" required marker when editing a node that already
    // has a stored password and the user has kept Password auth selected.
    const req = $('password-req');
    if (req) {
      const canReuse = editFlags.isEdit &&
                       editFlags.hasExistingPassword &&
                       editFlags.originalAuth === 'password' &&
                       a === 'password';
      req.style.display = canReuse ? 'none' : '';
    }
  }
  function updateInstallVisibility() {
    otpSection.classList.toggle('hidden', !installEl.checked);
  }

  const authRadios = document.querySelectorAll('input[name="auth"]');
  for (let i = 0; i < authRadios.length; i++) {
    authRadios[i].addEventListener('change', updateAuthVisibility);
  }
  installEl.addEventListener('change', updateInstallVisibility);

  function setError(forId, msg) {
    const el = document.querySelector('.error[data-for="' + forId + '"]');
    if (el) el.textContent = msg || '';
  }

  function validate() {
    let ok = true;
    const name = nameEl.value.trim();
    const endpoint = endpointEl.value.trim();
    const icon = iconEl.value.trim();
    const auth = currentAuth();

    setError('name', '');
    setError('endpoint', '');
    setError('icon', '');
    setError('password', '');
    setError('identityFile', '');
    setError('oneTimePassword', '');

    if (!name) { setError('name', 'Name is required.'); ok = false; }

    if (!endpoint) {
      setError('endpoint', 'Endpoint is required.');
      ok = false;
    } else {
      const at = endpoint.indexOf('@');
      if (at < 1 || at >= endpoint.length - 1) {
        setError('endpoint', 'Expected format: user@host or user@host:port');
        ok = false;
      } else {
        const portMatch = endpoint.match(/^(.*):(\\d+)$/);
        if (portMatch) {
          const n = parseInt(portMatch[2], 10);
          if (!isFinite(n) || n < 1 || n > 65535) {
            setError('endpoint', 'Port in user@host:port must be 1-65535.');
            ok = false;
          }
        }
      }
    }

    if (icon && !/^[a-z0-9-]+$/i.test(icon)) {
      setError('icon', 'Use only letters, digits, and hyphens.');
      ok = false;
    }

    if (auth === 'password') {
      const canReuse = editFlags.isEdit &&
                       editFlags.hasExistingPassword &&
                       editFlags.originalAuth === 'password';
      if (!passwordEl.value && !canReuse) {
        setError('password', 'Password is required.');
        ok = false;
      }
    } else {
      const idf = identityFileEl.value.trim();
      if (!idf) {
        setError('identityFile', 'Private key path is required.');
        ok = false;
      } else if (idf.endsWith('.pub')) {
        setError('identityFile', 'Enter the PRIVATE key file (not .pub).');
        ok = false;
      }
      if (installEl.checked && !otpEl.value) {
        setError('oneTimePassword', 'Required to install the public key.');
        ok = false;
      }
    }

    return ok;
  }

  function collectData() {
    const auth = currentAuth();
    const icon = iconEl.value.trim();
    const data = {
      name: nameEl.value.trim(),
      endpoint: endpointEl.value.trim(),
      preferredAuthentication: auth,
    };
    if (icon) data.icon = icon;
    const tl = currentTermLoc();
    if (tl === 'panel' || tl === 'editor') data.terminalLocation = tl;

    if (auth === 'password') {
      if (passwordEl.value) {
        // User typed a new password — replace the stored one.
        data.password = passwordEl.value;
      }
      // When editing and the field was left blank, we intentionally omit
      // 'password' so the handler preserves the existing stored reference.
      data.passwordStorage = currentStorage();
    } else {
      data.identityFile = identityFileEl.value.trim();
      if (installEl.checked) {
        data.installPublicKeyNow = true;
        data.oneTimePassword = otpEl.value;
      }
    }
    return data;
  }

  submitBtn.addEventListener('click', function () {
    if (!validate()) return;
    vscode.postMessage({ type: 'submit', data: collectData() });
  });
  cancelBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'cancel' });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      vscode.postMessage({ type: 'cancel' });
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (validate()) {
        vscode.postMessage({ type: 'submit', data: collectData() });
      }
    }
  });

  updateAuthVisibility();
  updateInstallVisibility();
  nameEl.focus();
})();
</script>
</body>
</html>`;
}
