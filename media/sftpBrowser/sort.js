// @ts-check
/**
 * Sorting: `mtimeSortKey`, `applySort`, the aria-sort indicator sync,
 * and the click wiring for `#listing` column headers.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { state } = ns;

  /* Map mtime string → sortable number. Handles both GNU "Apr 17 10:00"
   * and long-iso "2026-04-17 10:00" formats. Falls back to string
   * comparison for anything else. */
  /** @param {string|undefined} mtime */
  ns.mtimeSortKey = function mtimeSortKey(mtime) {
    if (!mtime) return 0;
    // long-iso: ISO parse works directly.
    const iso = Date.parse(mtime.replace(" ", "T") + "Z");
    if (!Number.isNaN(iso)) return iso;
    // GNU default — has a month name.
    const gnu = Date.parse(mtime);
    if (!Number.isNaN(gnu)) return gnu;
    return 0;
  };

  /** @param {any[]} entries */
  ns.applySort = function applySort(entries) {
    const dirMult = state.sortDir === "asc" ? 1 : -1;
    const sorted = entries.slice().sort((a, b) => {
      // Folders always float above files regardless of sort.
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (a.kind !== "dir" && b.kind === "dir") return 1;
      switch (state.sortKey) {
        case "size":
          return (a.size - b.size) * dirMult;
        case "mtime":
          return (
            (ns.mtimeSortKey(a.mtime) - ns.mtimeSortKey(b.mtime)) * dirMult
          );
        case "name":
        default:
          return a.name.localeCompare(b.name) * dirMult;
      }
    });
    return sorted;
  };

  ns.updateSortIndicators = function updateSortIndicators() {
    const headers = document.querySelectorAll("#listing th.sortable");
    headers.forEach((th) => {
      const key = th.getAttribute("data-sort");
      th.setAttribute(
        "aria-sort",
        key === state.sortKey
          ? state.sortDir === "asc"
            ? "ascending"
            : "descending"
          : "none",
      );
    });
  };

  document.querySelectorAll("#listing th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort");
      if (!key) return;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = "asc";
      }
      ns.renderRows();
    });
  });
})();
