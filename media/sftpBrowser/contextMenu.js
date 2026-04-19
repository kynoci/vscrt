// @ts-check
/**
 * Row right-click menu. Single-select menu shows per-entry ops
 * (Open / Preview / Rename / chmod / copy-path / delete); multi-select
 * menu shows bulk Download + Delete. Global click/Esc listeners hide
 * the menu when the user interacts elsewhere.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  ns.hideContextMenu = function hideContextMenu() {
    dom.ctxMenu.hidden = true;
    dom.ctxMenu.replaceChildren();
  };

  /** @param {number} x @param {number} y @param {any} entry */
  ns.showContextMenu = function showContextMenu(x, y, entry) {
    dom.ctxMenu.replaceChildren();
    const fullPath = ns.joinPath(state.currentPath, entry.name);
    /** @type {any[]} */
    const items = [];

    // Multi-select menu: show bulk operations only.
    if (state.selectedNames.size > 1) {
      /** @type {{ path: string, kind: string, name: string }[]} */
      const itemDescriptors = [];
      for (const n of state.selectedNames) {
        const e = state.currentEntries.find(
          (/** @type {any} */ ee) => ee.name === n,
        );
        if (!e) continue;
        itemDescriptors.push({
          path: ns.joinPath(state.currentPath, e.name),
          kind: e.kind,
          name: e.name,
        });
      }
      const onlyFiles = itemDescriptors.every((it) => it.kind !== "dir");
      if (onlyFiles) {
        items.push({
          label: `Download ${itemDescriptors.length} files…`,
          fn: () =>
            ns.post({
              type: "bulkDownload",
              remotePaths: itemDescriptors.map((it) => it.path),
            }),
        });
      }
      items.push({
        label: `Delete ${itemDescriptors.length} items…`,
        danger: true,
        fn: () =>
          ns.post({
            type: "bulkDelete",
            items: itemDescriptors.map((it) => ({
              path: it.path,
              kind: it.kind,
            })),
          }),
      });
    } else {
      if (entry.kind === "dir") {
        items.push({ label: "Open", fn: () => ns.openEntry(entry) });
      } else if (entry.kind === "file") {
        items.push({
          label: "Preview (read-only)",
          fn: () => ns.openEntry(entry),
        });
        items.push({
          label: "Download…",
          fn: () =>
            ns.post({
              type: "download",
              remotePath: fullPath,
              name: entry.name,
              sizeBytes:
                typeof entry.size === "number" && Number.isFinite(entry.size)
                  ? entry.size
                  : 0,
            }),
        });
      } else if (entry.kind === "symlink") {
        items.push({
          label: "Follow",
          fn: () => ns.post({ type: "followSymlink", path: fullPath }),
        });
      }
      items.push({ sep: true });
      items.push({
        label: "Rename…",
        fn: () => ns.triggerRename(entry.name),
      });
      items.push({
        label: "Change permissions…",
        fn: () =>
          ns.post({
            type: "chmod",
            path: fullPath,
            currentPerms: entry.perms ?? "",
          }),
      });
      items.push({
        label: "Copy remote path",
        fn: () => ns.post({ type: "copyPath", path: fullPath }),
      });
      items.push({
        label: "Copy as scp path",
        fn: () => ns.post({ type: "copyScpPath", path: fullPath }),
      });
      items.push({ sep: true });
      items.push({
        label: "Delete…",
        danger: true,
        fn: () => ns.post({ type: "delete", path: fullPath, kind: entry.kind }),
      });
    }

    for (const it of items) {
      if (it.sep) {
        const s = document.createElement("div");
        s.className = "sep";
        dom.ctxMenu.appendChild(s);
        continue;
      }
      const el = document.createElement("div");
      el.className = "item" + (it.danger ? " danger" : "");
      el.tabIndex = 0;
      el.setAttribute("role", "menuitem");
      el.textContent = it.label;
      el.addEventListener("click", () => {
        it.fn();
        ns.hideContextMenu();
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          it.fn();
          ns.hideContextMenu();
        } else if (ev.key === "Escape") {
          ns.hideContextMenu();
        }
      });
      dom.ctxMenu.appendChild(el);
    }
    // Position & clamp to viewport.
    const maxX = window.innerWidth - 200;
    const maxY = window.innerHeight - 260;
    dom.ctxMenu.style.left = Math.min(x, maxX) + "px";
    dom.ctxMenu.style.top = Math.min(y, maxY) + "px";
    dom.ctxMenu.hidden = false;
    const first = dom.ctxMenu.querySelector(".item");
    if (first) /** @type {HTMLElement} */ (first).focus();
  };

  document.addEventListener("click", (ev) => {
    if (!dom.ctxMenu.contains(/** @type {Node} */ (ev.target)))
      ns.hideContextMenu();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") ns.hideContextMenu();
  });
})();
