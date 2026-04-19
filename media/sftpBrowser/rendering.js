// @ts-check
/**
 * Rendering the remote pane: `humanSize`, `render`, `renderRows`,
 * `buildRow`, and `openEntry` (double-click / Enter handler).
 *
 * Virtualized-mode branching lives here; `renderVirtualWindow` itself
 * is defined in `virtualization.js`. Selection class is applied both
 * at buildRow time (via `updateSelection` post-pass) and after the
 * virtual re-render, so the two code paths stay in sync.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  /** @param {number} n */
  ns.humanSize = function humanSize(n) {
    if (!Number.isFinite(n)) return "";
    if (n < 1024) return n + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return v.toFixed(v >= 10 ? 0 : 1) + " " + units[i];
  };

  /** @param {{ path: string, entries?: any[] }} listResult */
  ns.render = function render(listResult) {
    state.currentPath = listResult.path;
    state.currentEntries = listResult.entries || [];
    dom.pathInput.value = state.currentPath;
    ns.renderBreadcrumbs(state.currentPath);
    ns.post({ type: "persistPath", path: state.currentPath });
    ns.clearSelection();
    ns.renderRows();
  };

  ns.renderRows = function renderRows() {
    const hasParent = state.currentPath !== "/" && state.currentPath !== "~";

    state.displayList = ns.applySort(
      ns
        .applyFilter(state.currentEntries)
        .filter((/** @type {any} */ e) => e.name !== ".."),
    );
    state.virtualActive = state.displayList.length > ns.VIRTUAL_THRESHOLD;

    dom.rowsEl.replaceChildren();

    if (hasParent) {
      const tr = ns.buildRow(
        { name: "..", kind: "dir", size: 0, perms: "", mtime: "" },
        true,
      );
      dom.rowsEl.appendChild(tr);
    }

    if (state.virtualActive) {
      ns.renderVirtualWindow();
    } else {
      for (const entry of state.displayList) {
        dom.rowsEl.appendChild(ns.buildRow(entry, false));
      }
    }

    if (state.displayList.length === 0 && !hasParent) {
      dom.emptyEl.textContent = state.filter ? "(no matches)" : "(empty directory)";
      dom.emptyEl.style.display = "";
      dom.listingScroll.style.display = "none";
    } else {
      dom.emptyEl.style.display = "none";
      dom.listingScroll.style.display = "";
    }
    const count = state.displayList.length;
    const filterNote = state.filter
      ? ` (filtered from ${state.currentEntries.length - 1})`
      : "";
    const virtualNote = state.virtualActive ? " · windowed" : "";
    // Count dotfiles filtered out by the Hidden toggle so users
    // notice when a "near-empty" directory is actually full of them.
    const hiddenCount = !state.showHidden
      ? state.currentEntries.filter(
          (/** @type {any} */ e) =>
            e.name.startsWith(".") && e.name !== ".." && e.name !== ".",
        ).length
      : 0;
    const hiddenNote =
      hiddenCount > 0
        ? ` · ${hiddenCount} hidden (toggle Hidden to show)`
        : "";
    ns.setStatus(
      `${count} ${count === 1 ? "entry" : "entries"}${filterNote}${virtualNote}${hiddenNote}`,
    );
    ns.updateSortIndicators();
    ns.updateSelection();
  };

  /** @param {any} entry @param {boolean} isParentRow */
  ns.buildRow = function buildRow(entry, isParentRow) {
    const tr = document.createElement("tr");
    tr.className = entry.kind;
    tr.dataset.name = entry.name;
    tr.dataset.kind = entry.kind;
    tr.tabIndex = 0;

    const nameCell = document.createElement("td");
    nameCell.className = "name";
    nameCell.textContent =
      entry.name + (entry.linkTarget ? " → " + entry.linkTarget : "");

    const sizeCell = document.createElement("td");
    sizeCell.className = "num";
    sizeCell.textContent =
      entry.kind === "dir" || isParentRow ? "" : ns.humanSize(entry.size);

    const mtimeCell = document.createElement("td");
    mtimeCell.className = "mtime";
    mtimeCell.textContent = isParentRow ? "" : (entry.mtime ?? "");

    const permsCell = document.createElement("td");
    permsCell.className = "perms";
    permsCell.textContent = isParentRow ? "" : (entry.perms ?? "");

    tr.appendChild(nameCell);
    tr.appendChild(sizeCell);
    tr.appendChild(mtimeCell);
    tr.appendChild(permsCell);

    if (isParentRow) {
      tr.addEventListener("click", () => ns.goUp());
      tr.addEventListener("keydown", ns.onRowKeydown);
      return tr;
    }

    /** @param {MouseEvent} ev */
    const onClick = (ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod) {
        ns.toggleSelect(entry.name);
      } else if (ev.shiftKey) {
        ns.rangeSelect(entry.name);
      } else {
        ns.singleSelect(entry.name);
      }
      ns.updateSelection();
    };

    if (entry.kind === "dir") {
      tr.addEventListener("click", onClick);
      tr.addEventListener("dblclick", () => ns.openEntry(entry));
    } else {
      tr.addEventListener("dblclick", () => ns.openEntry(entry));
      tr.addEventListener("click", onClick);
    }

    // Remote → local drag: only files (sftp `get` doesn't recurse
    // without `-r`, and dragging a symlink is ambiguous). Uses a
    // custom MIME so OS-file drags (`Files`) still route to the
    // upload pipeline in `dragDrop/osDrop.js`.
    if (entry.kind === "file") {
      tr.setAttribute("draggable", "true");
      tr.addEventListener("dragstart", (ev) => {
        // If this row is part of a multi-select, drag every selected
        // file (skipping dirs/symlinks); else drag just this row.
        /** @type {string[]} */
        let remotePaths;
        if (state.selectedNames.has(entry.name) && state.selectedNames.size > 1) {
          remotePaths = [];
          for (const n of state.selectedNames) {
            const e = state.currentEntries.find(
              (/** @type {any} */ ee) => ee.name === n,
            );
            if (e && e.kind === "file") {
              remotePaths.push(ns.joinPath(state.currentPath, e.name));
            }
          }
        } else {
          remotePaths = [ns.joinPath(state.currentPath, entry.name)];
        }
        console.log("[vsCRT] remote dragstart:", entry.name, remotePaths);
        ev.dataTransfer?.setData(
          "application/x-vscrt-remote-paths",
          JSON.stringify(remotePaths),
        );
        ev.dataTransfer?.setData("text/plain", remotePaths.join("\n"));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
      });
    }
    tr.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      // Only replace the single-selection if the clicked row wasn't
      // already part of a multi-select; multi-select context menu
      // shows bulk operations instead.
      if (!state.selectedNames.has(entry.name)) {
        ns.singleSelect(entry.name);
        ns.updateSelection();
      }
      ns.showContextMenu(ev.clientX, ev.clientY, entry);
    });
    tr.addEventListener("keydown", ns.onRowKeydown);
    return tr;
  };

  /** @param {any} entry */
  ns.openEntry = function openEntry(entry) {
    if (entry.kind === "dir") {
      ns.navigate(ns.joinPath(state.currentPath, entry.name));
    } else if (entry.kind === "symlink") {
      ns.post({
        type: "followSymlink",
        path: ns.joinPath(state.currentPath, entry.name),
      });
    } else if (entry.kind === "file") {
      // Default double-click on a file = preview. Opens read-only in editor.
      ns.post({
        type: "preview",
        path: ns.joinPath(state.currentPath, entry.name),
        size: entry.size,
      });
    }
  };
})();
