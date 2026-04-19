// @ts-check
/* eslint-disable no-console */
/**
 * Remote → local drag-and-drop download. Listens on `#local-pane` for
 * drops carrying `application/x-vscrt-remote-paths` (set by the file
 * rows in `rendering.js:buildRow`). The MIME type is custom so it
 * doesn't collide with OS-native `Files` drags (handled by
 * `dragDrop/osDrop.js`) or the local→remote drag in `localPaneDrop.js`.
 *
 * On drop, posts `{ type: "downloadToLocalDir", remotePaths,
 * intoLocalPath }` — the host-side op downloads each file into the
 * local pane's current directory, surfacing progress via the standard
 * transfer-progress bar, and re-lists the pane after completion.
 *
 * UX notes:
 *   - Drop is a "copy" gesture, not a "move"; the remote files are
 *     untouched. Matches file-manager intuition.
 *   - Dropping on the local pane ONLY accepts the remote MIME; OS
 *     drops onto the local pane fall through unhandled (local-pane
 *     refresh would happen through the regular filesystem anyway).
 *
 * This is the last file in the webview load chain, so it fires the
 * `{ type: "ready" }` handshake to the host after all listeners are
 * wired.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;
  console.log(
    "[vsCRT] remotePaneDrag.js loaded — remote→local drag/drop active",
  );

  /** @param {DragEvent} ev */
  function hasRemotePathsDrag(ev) {
    const types = ev.dataTransfer && ev.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === "application/x-vscrt-remote-paths") return true;
    }
    return false;
  }

  ns.hasRemotePathsDrag = hasRemotePathsDrag;

  dom.localPane.addEventListener("dragover", (ev) => {
    if (!hasRemotePathsDrag(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    dom.localPane.classList.add("drop-target");
  });
  dom.localPane.addEventListener("dragleave", () => {
    dom.localPane.classList.remove("drop-target");
  });
  dom.localPane.addEventListener("drop", (ev) => {
    dom.localPane.classList.remove("drop-target");
    console.log("[vsCRT] local-pane drop, types:", ev.dataTransfer?.types);
    if (!hasRemotePathsDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const raw = ev.dataTransfer?.getData("application/x-vscrt-remote-paths");
    console.log("[vsCRT] remote-drag payload:", raw);
    if (!raw) {
      ns.setStatus("Drop failed: no remote paths on the event.", "error");
      return;
    }
    try {
      const paths = JSON.parse(raw);
      if (!Array.isArray(paths) || paths.length === 0) {
        ns.setStatus("Drop failed: no paths in payload.", "error");
        return;
      }
      if (!state.localEnabled) {
        ns.setStatus(
          "Open the local pane first to choose a download destination.",
          "error",
        );
        return;
      }
      ns.setStatus(
        `Starting download of ${paths.length} file${paths.length === 1 ? "" : "s"} → ${state.localPath}…`,
      );
      ns.post({
        type: "downloadToLocalDir",
        remotePaths: paths,
        intoLocalPath: state.localPath,
      });
    } catch (err) {
      ns.setStatus("Drop failed: bad payload format.", "error");
      console.warn("bad remote-drag payload:", err);
    }
  });

  // Final handshake: tell the host we're ready for the initial listing.
  // Placed in the last-loaded script so every listener wired by earlier
  // files is attached by the time the host sends the initial `init` /
  // `listing` messages.
  ns.post({ type: "ready" });
})();
