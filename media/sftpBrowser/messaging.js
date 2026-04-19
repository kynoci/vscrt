// @ts-check
/* eslint-disable no-console */
/**
 * Host → webview message pump + the tiny `post` / `setStatus` / `setBusy`
 * helpers that every other file uses to talk back to the extension host.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom } = ns;

  /** @param {any} msg */
  ns.post = function post(msg) {
    ns.vscode.postMessage(msg);
  };

  /** @param {string} msg @param {string=} cls */
  ns.setStatus = function setStatus(msg, cls) {
    dom.statusBar.classList.remove("error", "success");
    if (cls) dom.statusBar.classList.add(cls);
    dom.statusBar.textContent = msg;
  };

  /** @param {boolean} busy */
  ns.setBusy = function setBusy(busy) {
    dom.spinner.classList.toggle("busy", !!busy);
  };

  // Primary host→webview dispatch. Phase-8 local-pane messages get a
  // second listener inside `localPane.js`; keeping the concerns apart
  // makes the failure modes easier to reason about.
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "init":
        document.title = "SFTP: " + msg.serverName;
        ns.state.currentPath = msg.initialPath || "~";
        dom.pathInput.value = ns.state.currentPath;
        break;
      case "listing":
        ns.render(msg);
        break;
      case "error":
        dom.statusBar.classList.add("error");
        dom.statusBar.textContent = msg.message || "Operation failed.";
        dom.emptyEl.textContent = "Failed — see status bar.";
        break;
      case "info":
        ns.setStatus(msg.message, "success");
        break;
      case "busy":
        ns.setBusy(msg.busy);
        break;
    }
  });
})();
