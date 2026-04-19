// @ts-check
/**
 * Windowed-rendering for large directories. Entries below
 * VIRTUAL_THRESHOLD fall back to all-at-once render (handled in
 * rendering.js); beyond that, only rows that intersect the viewport
 * (plus BUFFER_ROWS above/below) land in the DOM, padded by two
 * spacer `<tr>`s that preserve the scrollbar's thumb proportion.
 *
 * CONTRACT: `ROW_HEIGHT_PX` **must** match `--sftp-row-height` in
 * `media/sftpBrowser.css` — mis-sizing here makes the scroll-top →
 * first-visible-index math drift, which the user sees as rows
 * snapping or overlapping on fast scrolls. Tests at
 * `src/test/sftpScrollContract.test.ts` lock this in.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  const VIRTUAL_THRESHOLD = 300;
  const ROW_HEIGHT_PX = 24;
  const BUFFER_ROWS = 12;

  ns.VIRTUAL_THRESHOLD = VIRTUAL_THRESHOLD;
  ns.ROW_HEIGHT_PX = ROW_HEIGHT_PX;
  ns.BUFFER_ROWS = BUFFER_ROWS;

  /** @param {string} s */
  ns.cssEscape = function cssEscape(s) {
    // Enough for the character set that can legally land in a remote
    // filename. Avoids pulling in the full CSS.escape polyfill.
    return String(s).replace(/(["\\])/g, "\\$1");
  };

  /** @param {number} heightPx */
  ns.buildSpacer = function buildSpacer(heightPx) {
    const spacer = document.createElement("tr");
    spacer.className = "virtual-spacer";
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.height = heightPx + "px";
    // Single full-width cell — browsers collapse rows without cells in
    // some table-layout modes, and we need the height to actually apply.
    const td = document.createElement("td");
    td.colSpan = 4;
    td.style.padding = "0";
    td.style.border = "0";
    spacer.appendChild(td);
    return spacer;
  };

  /**
   * Render only the rows that intersect the scroll viewport, padded by
   * BUFFER_ROWS above and below. Two spacer <tr>s keep the total
   * scrollable height accurate so the native scrollbar behaves.
   */
  ns.renderVirtualWindow = function renderVirtualWindow() {
    if (!state.virtualActive) return;
    // Drop any existing virtual rows (preserving the optional ".." row
    // at index 0 which is rendered once in renderRows).
    const hasParent =
      dom.rowsEl.firstElementChild &&
      /** @type {HTMLElement} */ (dom.rowsEl.firstElementChild).dataset.name ===
        "..";
    while (dom.rowsEl.childNodes.length > (hasParent ? 1 : 0)) {
      dom.rowsEl.removeChild(dom.rowsEl.lastChild);
    }

    const scrollTop = dom.listingScroll.scrollTop;
    const viewportHeight = dom.listingScroll.clientHeight || 400;
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT_PX);
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT_PX);
    const start = Math.max(0, firstVisible - BUFFER_ROWS);
    const end = Math.min(
      state.displayList.length,
      firstVisible + visibleCount + BUFFER_ROWS,
    );

    if (start > 0) {
      dom.rowsEl.appendChild(ns.buildSpacer(start * ROW_HEIGHT_PX));
    }
    for (let i = start; i < end; i += 1) {
      dom.rowsEl.appendChild(ns.buildRow(state.displayList[i], false));
    }
    if (end < state.displayList.length) {
      dom.rowsEl.appendChild(
        ns.buildSpacer((state.displayList.length - end) * ROW_HEIGHT_PX),
      );
    }

    // Re-apply the selected class to the rendered rows (selection state
    // lives in `state.selectedNames`, which survives windowing).
    for (const tr of dom.rowsEl.querySelectorAll("tr")) {
      const name = tr.dataset.name;
      if (name && state.selectedNames.has(name)) {
        tr.classList.add("selected");
      }
    }

    // Re-focus the previously-focused row if it fell into the new window.
    if (state.lastFocusedName) {
      const el = dom.rowsEl.querySelector(
        `tr[data-name="${ns.cssEscape(state.lastFocusedName)}"]`,
      );
      if (el) /** @type {HTMLElement} */ (el).focus({ preventScroll: true });
    }
  };

  /**
   * Move keyboard focus to the row next to `tr` in `delta` direction
   * (+1 / -1). Virtual-mode aware: if the target row isn't currently
   * rendered, scrolls the listing so it lands in the next window, then
   * re-renders and focuses it.
   */
  /** @param {HTMLElement} tr @param {number} delta */
  ns.focusNeighbourRow = function focusNeighbourRow(tr, delta) {
    const name = tr.dataset.name;
    if (!name) return;

    if (name === "..") {
      // The ".." parent row sits outside displayList. Stepping down
      // from it = first displayList entry; stepping up = no-op.
      if (delta > 0 && state.displayList.length > 0) {
        ns.focusByDisplayIndex(0);
      }
      return;
    }

    const idx = state.displayList.findIndex(
      (/** @type {any} */ e) => e.name === name,
    );
    if (idx === -1) return;
    const next = idx + delta;
    if (next < 0) {
      // Wrap up to the ".." row if it's rendered.
      const parent = dom.rowsEl.querySelector('tr[data-name=".."]');
      if (parent) /** @type {HTMLElement} */ (parent).focus();
      return;
    }
    if (next >= state.displayList.length) {
      return;
    }
    ns.focusByDisplayIndex(next);
  };

  /**
   * Focus `displayList[idx]`'s row, scrolling the listing if virtual-
   * mode's current window doesn't include it.
   */
  /** @param {number} idx */
  ns.focusByDisplayIndex = function focusByDisplayIndex(idx) {
    const target = state.displayList[idx];
    if (!target) return;
    state.lastFocusedName = target.name;
    let el = dom.rowsEl.querySelector(
      `tr[data-name="${ns.cssEscape(target.name)}"]`,
    );
    if (!el && state.virtualActive) {
      // Row isn't rendered — scroll so it would be, then re-render.
      const desiredScrollTop = Math.max(
        0,
        idx * ROW_HEIGHT_PX - dom.listingScroll.clientHeight / 2,
      );
      dom.listingScroll.scrollTop = desiredScrollTop;
      ns.renderVirtualWindow();
      el = dom.rowsEl.querySelector(
        `tr[data-name="${ns.cssEscape(target.name)}"]`,
      );
    }
    if (el) {
      /** @type {HTMLElement} */ (el).focus({ preventScroll: false });
    }
  };

  // Throttled scroll listener drives virtual-mode re-rendering. rAF
  // coalesces rapid scroll events into one paint.
  dom.listingScroll.addEventListener("scroll", () => {
    if (!state.virtualActive) return;
    if (state.virtualRafId) return;
    state.virtualRafId = requestAnimationFrame(() => {
      state.virtualRafId = 0;
      ns.renderVirtualWindow();
    });
  });
})();
