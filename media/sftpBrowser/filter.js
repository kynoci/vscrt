// @ts-check
/**
 * Filter: the `applyFilter` predicate shared by the remote and local
 * panes, plus the #filter-input wiring. Local pane re-renders via the
 * shared filter so both sides stay in lockstep.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  /** @param {any[]} entries */
  ns.applyFilter = function applyFilter(entries) {
    const q = state.filter.trim().toLowerCase();
    let list = entries.filter((e) => e.name !== ".");
    if (!state.showHidden) {
      list = list.filter((e) => !e.name.startsWith(".") || e.name === "..");
    }
    if (q) {
      list = list.filter((e) => e.name.toLowerCase().includes(q));
    }
    return list;
  };

  dom.filterInput.addEventListener("input", () => {
    state.filter = dom.filterInput.value;
    ns.renderRows();
    // Keep the local pane synchronised with the active filter.
    if (state.localEnabled && Array.isArray(state.localEntries)) {
      ns.renderLocal({ path: state.localPath, entries: state.localEntries });
    }
  });
})();
