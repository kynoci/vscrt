// @ts-check
/**
 * E2 — OS-native drag-and-drop upload. Dropping from Finder/Explorer/
 * GNOME Files into the browser surfaces `dropUpload` messages. The
 * host side filters out directories & unreadable paths so we can
 * forward whatever `DataTransfer.files` reports.
 *
 * Attaches on `document.body` (not the table) so drops register
 * across the whole viewport — the listing only covers part of it when
 * a directory is short.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { state } = ns;

  const dropOverlay = document.createElement("div");
  dropOverlay.id = "drop-overlay";
  dropOverlay.setAttribute("aria-hidden", "true");
  dropOverlay.innerHTML =
    '<div class="drop-hint">Drop files to upload to <strong id="drop-target">' +
    "…</strong></div>";
  document.body.appendChild(dropOverlay);

  /** @param {boolean} show */
  function showDropOverlay(show) {
    dropOverlay.classList.toggle("active", !!show);
    const t = document.getElementById("drop-target");
    if (t) t.textContent = state.currentPath;
  }

  /** Only react to drags that actually carry files — not text, not
   *  tree-drags from the connection view, etc. */
  /** @param {DragEvent} ev */
  function hasFileDrag(ev) {
    const types = ev.dataTransfer && ev.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === "Files") return true;
    }
    return false;
  }

  ns.hasFileDrag = hasFileDrag;

  document.body.addEventListener("dragenter", (ev) => {
    if (!hasFileDrag(ev)) return;
    ev.preventDefault();
    state.dragDepth += 1;
    showDropOverlay(true);
  });
  document.body.addEventListener("dragover", (ev) => {
    if (!hasFileDrag(ev)) return;
    ev.preventDefault();
    // Force the "copy" cursor so the user understands dropping is
    // allowed (without this, Chromium shows "not allowed").
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });
  document.body.addEventListener("dragleave", (ev) => {
    if (!hasFileDrag(ev)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) showDropOverlay(false);
  });
  document.body.addEventListener("drop", (ev) => {
    if (!hasFileDrag(ev)) return;
    ev.preventDefault();
    state.dragDepth = 0;
    showDropOverlay(false);
    const files = ev.dataTransfer ? Array.from(ev.dataTransfer.files) : [];
    /** @type {string[]} */
    const paths = [];
    for (const f of files) {
      // Electron exposes the absolute path on File objects in webviews.
      // Fall back to f.name if missing (shouldn't happen in practice,
      // but we log + skip rather than sending a bare filename).
      const p = /** @type {any} */ (f).path;
      if (typeof p === "string" && p.length > 0) {
        paths.push(p);
      }
    }
    if (paths.length === 0) {
      ns.setStatus(
        "Drop rejected: no local paths on the dropped items.",
        "error",
      );
      return;
    }
    ns.post({
      type: "dropUpload",
      intoPath: state.currentPath,
      localPaths: paths,
    });
  });
})();
