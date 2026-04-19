// @ts-check
/**
 * Row keyboard handling: ArrowUp/ArrowDown navigation, Enter = open,
 * Delete = remove (bulk-aware), F2 = rename. `triggerRename` lives
 * here too because it's only reachable from F2 / context-menu click.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { state } = ns;

  /** @param {KeyboardEvent} ev */
  ns.onRowKeydown = function onRowKeydown(ev) {
    const tr = /** @type {HTMLElement} */ (ev.currentTarget);
    state.lastFocusedName = tr.dataset.name || null;
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        ns.focusNeighbourRow(tr, +1);
        return;
      case "ArrowUp":
        ev.preventDefault();
        ns.focusNeighbourRow(tr, -1);
        return;
      case "Enter":
        ev.preventDefault();
        if (tr.dataset.name === "..") {
          ns.goUp();
        } else {
          const entry = state.currentEntries.find(
            (/** @type {any} */ e) => e.name === tr.dataset.name,
          );
          if (entry) ns.openEntry(entry);
        }
        return;
      case "Delete":
        ev.preventDefault();
        if (state.selectedNames.size > 1) {
          /** @type {{ path: string, kind: string }[]} */
          const items = [];
          for (const n of state.selectedNames) {
            const e = state.currentEntries.find(
              (/** @type {any} */ ee) => ee.name === n,
            );
            if (e)
              items.push({
                path: ns.joinPath(state.currentPath, e.name),
                kind: e.kind,
              });
          }
          if (items.length > 0) {
            ns.post({ type: "bulkDelete", items });
          }
        } else if (tr.dataset.name !== "..") {
          const entry = state.currentEntries.find(
            (/** @type {any} */ e) => e.name === tr.dataset.name,
          );
          if (entry) {
            ns.post({
              type: "delete",
              path: ns.joinPath(state.currentPath, entry.name),
              kind: entry.kind,
            });
          }
        }
        return;
      case "F2":
        ev.preventDefault();
        if (tr.dataset.name !== "..") ns.triggerRename(tr.dataset.name);
        return;
    }
  };

  /** @param {string|undefined} name */
  ns.triggerRename = async function triggerRename(name) {
    if (!name) return;
    const input = prompt("Rename to:", name);
    if (!input || input === name) return;
    ns.post({
      type: "rename",
      oldPath: ns.joinPath(state.currentPath, name),
      newName: input.trim(),
    });
  };
})();
