// @ts-check
/**
 * Row selection for the local pane — single / toggle / shift-range
 * selects, plus `updateLocalSelection` which syncs the `selected`
 * class onto the currently rendered rows. Mirrors `selection.js`
 * for the remote pane.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  ns.updateLocalSelection = function updateLocalSelection() {
    const all = dom.localRowsEl.querySelectorAll("tr");
    all.forEach((/** @type {HTMLElement} */ r) => {
      const name = r.dataset.name;
      r.classList.toggle(
        "selected",
        name ? state.localSelectedNames.has(name) : false,
      );
    });
  };

  ns.clearLocalSelection = function clearLocalSelection() {
    state.localSelectedNames.clear();
    state.localSelectionAnchor = null;
    ns.updateLocalSelection();
  };

  /** @param {string} name */
  ns.toggleLocalSelect = function toggleLocalSelect(name) {
    if (state.localSelectedNames.has(name)) {
      state.localSelectedNames.delete(name);
    } else {
      state.localSelectedNames.add(name);
    }
    state.localSelectionAnchor = name;
  };

  /** @param {string} name */
  ns.rangeLocalSelect = function rangeLocalSelect(name) {
    if (!state.localSelectionAnchor) {
      state.localSelectedNames.add(name);
      state.localSelectionAnchor = name;
      return;
    }
    // The local pane doesn't maintain a `displayList` so we walk the
    // currently-rendered rows instead — fine because the local pane
    // doesn't virtualize.
    const rows = Array.from(
      /** @type {NodeListOf<HTMLElement>} */ (
        dom.localRowsEl.querySelectorAll("tr")
      ),
    )
      .map((r) => r.dataset.name)
      .filter((/** @type {string | undefined} */ n) => n && n !== "..");
    const i = rows.indexOf(state.localSelectionAnchor);
    const j = rows.indexOf(name);
    if (i === -1 || j === -1) {
      state.localSelectedNames.add(name);
      return;
    }
    const [lo, hi] = i < j ? [i, j] : [j, i];
    for (let k = lo; k <= hi; k += 1) {
      const n = rows[k];
      if (n) state.localSelectedNames.add(n);
    }
  };

  /** @param {string} name */
  ns.singleLocalSelect = function singleLocalSelect(name) {
    state.localSelectedNames.clear();
    if (name !== "..") {
      state.localSelectedNames.add(name);
    }
    state.localSelectionAnchor = name;
  };
})();
