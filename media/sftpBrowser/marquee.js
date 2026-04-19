// @ts-check
/**
 * Click-and-drag marquee (rubber-band) selection. Instantiated once per
 * pane — each side passes its own scroll container + rows + selection
 * Set/anchor accessors.
 *
 *   - plain drag on empty area  → replaces selection with every row
 *                                 the rectangle touches
 *   - Ctrl/Cmd+drag             → adds to the current selection
 *   - Shift+drag                → extends (same semantics as add)
 *   - drag that never moves     → plain empty-area click → clears
 *                                 the current selection
 *
 * Drag is only armed when mousedown lands outside any `<tr>` so the
 * HTML5 drag-and-drop used by file rows (remote → local download /
 * local → remote upload) keeps working unchanged. Virtualized rows
 * are fine — we intersect against whatever is currently rendered.
 *
 * @typedef {{
 *   scroll: HTMLElement,
 *   rowsEl: HTMLElement,
 *   getSelection: () => Set<string>,
 *   setSelection: (s: Set<string>) => void,
 *   getAnchor: () => string | null,
 *   setAnchor: (n: string | null) => void,
 *   refresh: () => void,
 * }} MarqueeConfig
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;

  /** Minimum cursor movement (in px) before a click becomes a drag. */
  const DRAG_THRESHOLD_PX = 4;

  /** @param {MarqueeConfig} cfg */
  ns.installMarquee = function installMarquee(cfg) {
    /** @type {HTMLDivElement | null} */
    let rect = null;
    /** @type {{ x: number; y: number } | null} */
    let anchor = null;
    /** @type {Set<string> | null} */
    let baseline = null;
    let additive = false;
    let active = false;

    cfg.scroll.addEventListener("mousedown", (/** @type {MouseEvent} */ ev) => {
      // Only left-button drags.
      if (ev.button !== 0) return;

      // Starting inside a row belongs to the click/drag-row paths —
      // leave those intact so file drag-to-local still works.
      const target = /** @type {HTMLElement | null} */ (ev.target);
      if (target && target.closest("tr")) return;

      anchor = { x: ev.clientX, y: ev.clientY };
      additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
      baseline = additive ? new Set(cfg.getSelection()) : null;
      active = false;
      // Don't let the browser start a text-selection drag.
      ev.preventDefault();
    });

    window.addEventListener("mousemove", (/** @type {MouseEvent} */ ev) => {
      if (!anchor) return;
      const dx = ev.clientX - anchor.x;
      const dy = ev.clientY - anchor.y;
      if (!active) {
        if (
          Math.abs(dx) < DRAG_THRESHOLD_PX &&
          Math.abs(dy) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        active = true;
        ensureRect();
      }
      updateRect(ev.clientX, ev.clientY);
      applySelection();
    });

    window.addEventListener("mouseup", () => {
      if (!anchor) return;
      const wasActive = active;
      disposeRect();
      anchor = null;
      baseline = null;
      active = false;
      if (!wasActive) {
        // A bare click on empty space clears the selection, matching
        // the behaviour of most file managers and the keyboard flow.
        cfg.setSelection(new Set());
        cfg.setAnchor(null);
        cfg.refresh();
      }
    });

    function ensureRect() {
      if (rect) return;
      rect = document.createElement("div");
      rect.className = "marquee";
      document.body.appendChild(rect);
    }

    /**
     * @param {number} x
     * @param {number} y
     */
    function updateRect(x, y) {
      if (!rect || !anchor) return;
      const left = Math.min(anchor.x, x);
      const top = Math.min(anchor.y, y);
      const width = Math.abs(x - anchor.x);
      const height = Math.abs(y - anchor.y);
      rect.style.left = left + "px";
      rect.style.top = top + "px";
      rect.style.width = width + "px";
      rect.style.height = height + "px";
    }

    function disposeRect() {
      if (rect) {
        rect.remove();
        rect = null;
      }
    }

    /**
     * Recompute the pane's selection from the baseline + whatever
     * rows intersect the current rectangle. Runs on every mousemove
     * while dragging; cheap because we only read `getBoundingClientRect`
     * for rendered rows.
     */
    function applySelection() {
      if (!rect) return;
      const r = rect.getBoundingClientRect();
      /** @type {Set<string>} */
      const next = baseline ? new Set(baseline) : new Set();
      const rows = cfg.rowsEl.querySelectorAll("tr");
      rows.forEach((/** @type {HTMLElement} */ tr) => {
        const name = tr.dataset.name;
        if (!name || name === "..") return;
        const b = tr.getBoundingClientRect();
        if (
          b.right >= r.left &&
          b.left <= r.right &&
          b.bottom >= r.top &&
          b.top <= r.bottom
        ) {
          next.add(name);
        }
      });
      cfg.setSelection(next);
      // Anchor the next shift-range from the first name we added —
      // without an anchor, a later shift+click would collapse.
      if (!cfg.getAnchor() && next.size > 0) {
        cfg.setAnchor(/** @type {string} */ (next.values().next().value));
      }
      cfg.refresh();
    }
  };

  // Install the marquee on the remote pane as soon as state is ready.
  // The local pane is installed from `localPane.js` once its rows
  // element and selection helpers are defined.
  const { dom, state } = ns;
  if (dom.listingScroll) {
    ns.installMarquee({
      scroll: dom.listingScroll,
      rowsEl: dom.rowsEl,
      getSelection: () => state.selectedNames,
      setSelection: (s) => {
        state.selectedNames = s;
      },
      getAnchor: () => state.selectionAnchor,
      setAnchor: (n) => {
        state.selectionAnchor = n;
      },
      refresh: () => ns.updateSelection(),
    });
  }
})();
