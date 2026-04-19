// @ts-check
/**
 * Row selection: single / toggle / shift-range selects + `updateSelection`
 * which syncs the `selected` class onto the currently rendered rows and
 * surfaces the multi-select count in the status bar.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  ns.updateSelection = function updateSelection() {
    const all = dom.rowsEl.querySelectorAll("tr");
    all.forEach((/** @type {HTMLElement} */ r) => {
      const name = r.dataset.name;
      r.classList.toggle(
        "selected",
        name ? state.selectedNames.has(name) : false,
      );
    });
    // Surface the multi-select count in the status bar so users know
    // the bulk actions will hit the right number of rows.
    if (state.selectedNames.size > 1) {
      ns.setStatus(
        state.selectedNames.size +
          " selected — Delete / right-click → Download",
      );
    }
  };

  ns.clearSelection = function clearSelection() {
    state.selectedNames.clear();
    state.selectionAnchor = null;
    ns.updateSelection();
  };

  /** @param {string} name */
  ns.toggleSelect = function toggleSelect(name) {
    if (state.selectedNames.has(name)) {
      state.selectedNames.delete(name);
    } else {
      state.selectedNames.add(name);
    }
    state.selectionAnchor = name;
  };

  /** @param {string} name */
  ns.rangeSelect = function rangeSelect(name) {
    if (!state.selectionAnchor) {
      state.selectedNames.add(name);
      state.selectionAnchor = name;
      return;
    }
    // Walk `displayList` (not the DOM) so virtual-mode range selects
    // hit un-rendered rows too. The ".." parent row isn't in
    // displayList and is excluded from bulk ops by design.
    const i = state.displayList.findIndex(
      (/** @type {any} */ e) => e.name === state.selectionAnchor,
    );
    const j = state.displayList.findIndex(
      (/** @type {any} */ e) => e.name === name,
    );
    if (i === -1 || j === -1) {
      state.selectedNames.add(name);
      return;
    }
    const [lo, hi] = i < j ? [i, j] : [j, i];
    for (let k = lo; k <= hi; k += 1) {
      state.selectedNames.add(state.displayList[k].name);
    }
  };

  /** @param {string} name */
  ns.singleSelect = function singleSelect(name) {
    state.selectedNames.clear();
    if (name !== "..") {
      state.selectedNames.add(name);
    }
    state.selectionAnchor = name;
  };
})();
