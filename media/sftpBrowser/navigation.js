// @ts-check
/**
 * Remote-pane navigation: `navigate`, `goUp`, breadcrumb rendering +
 * the `joinPath` helper used by selection/keyboard/context-menu layers.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  /** @param {string} rawPath */
  ns.navigate = function navigate(rawPath) {
    if (!rawPath || rawPath.trim() === "") return;
    ns.post({ type: "list", path: rawPath });
    ns.setStatus("Loading " + rawPath + "…");
    dom.emptyEl.textContent = "Loading…";
    dom.emptyEl.style.display = "";
    dom.listingScroll.style.display = "none";
  };

  ns.goUp = function goUp() {
    if (state.currentPath === "/" || state.currentPath === "~") return;
    const parent =
      state.currentPath.replace(/\/[^/]+\/?$/, "") ||
      (state.currentPath.startsWith("/") ? "/" : "~");
    ns.navigate(parent);
  };

  /** @param {string} pathStr */
  ns.renderBreadcrumbs = function renderBreadcrumbs(pathStr) {
    dom.breadcrumbs.replaceChildren();
    const parts = pathStr.split("/").filter(Boolean);
    const isTilde = pathStr.startsWith("~");
    const root = isTilde ? "~" : "/";
    const rootEl = document.createElement("span");
    rootEl.className = "crumb";
    rootEl.tabIndex = 0;
    rootEl.textContent = root;
    rootEl.addEventListener("click", () => ns.navigate(root));
    rootEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        ns.navigate(root);
      }
    });
    dom.breadcrumbs.appendChild(rootEl);

    const crumbParts = isTilde ? parts.slice(1) : parts; // skip leading "~"
    let acc = root;
    for (const part of crumbParts) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      dom.breadcrumbs.appendChild(sep);
      acc =
        acc === "/"
          ? "/" + part
          : acc === "~"
            ? "~/" + part
            : acc + "/" + part;
      const el = document.createElement("span");
      el.className = "crumb";
      el.tabIndex = 0;
      el.textContent = part;
      const target = acc;
      el.addEventListener("click", () => ns.navigate(target));
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          ns.navigate(target);
        }
      });
      dom.breadcrumbs.appendChild(el);
    }
  };

  /** @param {string} dir @param {string} name */
  ns.joinPath = function joinPath(dir, name) {
    if (name === "..") {
      return (
        dir.replace(/\/[^/]+\/?$/, "") || (dir.startsWith("/") ? "/" : "~")
      );
    }
    return dir.endsWith("/") ? dir + name : dir + "/" + name;
  };
})();
