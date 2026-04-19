// @ts-check
/* eslint-disable no-console */
/**
 * E1-glue — dropping a file from the local pane onto the remote pane
 * triggers the upload pipeline. We use a custom MIME type set at
 * `dragstart` (see `localPane.js`) so we don't clash with OS-native
 * drag events (which carry "Files" and are handled by `osDrop.js`).
 *
 * Loads after `localPane.js` because it references the same DOM refs,
 * and after `osDrop.js` so the priority on `Files` vs.
 * `application/x-vscrt-local-paths` is well-defined.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  /** @param {DragEvent} ev */
  function hasLocalPaneDrag(ev) {
    const types = ev.dataTransfer && ev.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === "application/x-vscrt-local-paths") return true;
    }
    return false;
  }

  ns.hasLocalPaneDrag = hasLocalPaneDrag;

  dom.remotePane.addEventListener("dragover", (ev) => {
    if (!hasLocalPaneDrag(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    dom.remotePane.classList.add("drop-target");
  });
  dom.remotePane.addEventListener("dragleave", () => {
    dom.remotePane.classList.remove("drop-target");
  });
  dom.remotePane.addEventListener("drop", (ev) => {
    dom.remotePane.classList.remove("drop-target");
    console.log(
      "[vsCRT] remote-pane drop, types:",
      ev.dataTransfer ? Array.from(ev.dataTransfer.types) : "(no dataTransfer)",
    );
    if (!hasLocalPaneDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const raw = ev.dataTransfer?.getData("application/x-vscrt-local-paths");
    console.log("[vsCRT] local-drag payload:", raw);
    if (!raw) {
      ns.setStatus("Drop failed: no local paths on the event.", "error");
      return;
    }
    try {
      const paths = JSON.parse(raw);
      if (Array.isArray(paths) && paths.length > 0) {
        ns.setStatus(
          `Uploading ${paths.length} file${paths.length === 1 ? "" : "s"} → ${state.currentPath}…`,
        );
        ns.post({
          type: "dropUpload",
          intoPath: state.currentPath,
          localPaths: paths,
        });
      } else {
        ns.setStatus("Drop failed: empty payload.", "error");
      }
    } catch (err) {
      ns.setStatus("Drop failed: bad payload format.", "error");
      console.warn("bad local-pane drop payload:", err);
    }
  });
})();
