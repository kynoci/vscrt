/**
 * SFTP-browser scrollable-listing contract.
 *
 * The requirements S1–S8 below describe invariants that keep the
 * listing area scrolling *inside* its pane rather than pushing the
 * toolbar / status bar off-screen. Each is verified by grepping the
 * static webview assets — no JSDOM / webview host required.
 *
 * Run: `npm test -- --grep "sftp scroll contract"`
 */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

const MEDIA = path.join(__dirname, "..", "..", "media");

function readMedia(relPath: string): string {
  return fs.readFileSync(path.join(MEDIA, relPath), "utf8");
}

describe("sftp scroll contract", () => {
  const css = readMedia("sftpBrowser.css");
  const virtJs = readMedia("sftpBrowser/virtualization.js");
  const renderJs = readMedia("sftpBrowser/rendering.js");
  const sortJs = readMedia("sftpBrowser/sort.js");
  const filterJs = readMedia("sftpBrowser/filter.js");

  // Splits a selector block out of the CSS. Not exact, but fine for
  // assertion-grade matching — we're guarding against forgotten rules,
  // not reimplementing a parser.
  function block(sel: string): string {
    const i = css.indexOf(sel + " {");
    if (i === -1) {
      return "";
    }
    const j = css.indexOf("}", i);
    return j === -1 ? "" : css.slice(i, j);
  }

  describe("ROW_HEIGHT_PX ↔ --sftp-row-height drift guard", () => {
    it("declares --sftp-row-height in the CSS", () => {
      assert.match(css, /--sftp-row-height:\s*\d+px/);
    });

    it("pins body-row height to --sftp-row-height", () => {
      assert.match(
        css,
        /#listing tbody tr,\s*\n\s*#local-listing tbody tr\s*\{\s*\n\s*height:\s*var\(--sftp-row-height\)/,
      );
    });

    it("ROW_HEIGHT_PX in virtualization.js matches --sftp-row-height", () => {
      const cssMatch = css.match(/--sftp-row-height:\s*(\d+)px/);
      const jsMatch = virtJs.match(/ROW_HEIGHT_PX\s*=\s*(\d+)/);
      assert.ok(
        cssMatch && jsMatch,
        "both constants must be declared (CSS --sftp-row-height and JS ROW_HEIGHT_PX)",
      );
      assert.strictEqual(
        cssMatch![1],
        jsMatch![1],
        `CSS --sftp-row-height=${cssMatch![1]}px but JS ROW_HEIGHT_PX=${jsMatch![1]} — these must match (see CONTRACT comment in virtualization.js)`,
      );
    });
  });

  describe("R-S1 / S2 — listing scrolls internally, sticky thead", () => {
    it(".table-scroll wrapper declares overflow: auto (Chromium ignores it on <table>)", () => {
      // Both #listing-scroll and #local-listing-scroll use this class.
      // The wrapper-not-table pattern is what actually creates a
      // scroll container in Chromium — verified empirically via
      // `docs/scroll-verify.html`.
      assert.match(block(".table-scroll"), /overflow:\s*auto/);
    });

    it("tables themselves do NOT redeclare overflow (regression guard)", () => {
      // If someone re-adds `overflow: auto` to #listing they'll
      // re-introduce the silent-no-scroll bug on Chromium.
      const listingRule = block("#listing");
      assert.ok(
        !/overflow:\s*auto/.test(listingRule),
        "#listing must not redeclare overflow — scroll lives on the wrapper",
      );
      const localRule = block("#local-listing");
      assert.ok(
        !/overflow:\s*auto/.test(localRule),
        "#local-listing must not redeclare overflow — scroll lives on the wrapper",
      );
    });

    it("#listing thead is position: sticky; top: 0", () => {
      assert.match(
        css,
        /#listing thead\s*\{[\s\S]*?position:\s*sticky[\s\S]*?top:\s*0/,
      );
    });

    it("#local-listing thead is position: sticky; top: 0", () => {
      assert.match(
        css,
        /#local-listing thead\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/,
      );
    });

    it("buildHtml wraps both tables in .table-scroll divs", () => {
      const buildHtml = fs.readFileSync(
        path.join(
          __dirname,
          "..",
          "..",
          "src",
          "commands",
          "sftpBrowser",
          "panelHost",
          "buildHtml.ts",
        ),
        "utf8",
      );
      assert.match(buildHtml, /id="listing-scroll"[^>]*class="table-scroll"/);
      assert.match(
        buildHtml,
        /id="local-listing-scroll"[^>]*class="table-scroll"/,
      );
    });
  });

  describe("R-S3 — pane chain: flex column + min-height: 0", () => {
    it("#panes .pane is display: flex, flex-direction: column, min-height: 0", () => {
      const b = block("#panes .pane");
      assert.match(b, /display:\s*flex/);
      assert.match(b, /flex-direction:\s*column/);
      assert.match(b, /min-height:\s*0/);
    });
  });

  describe("R-S4 — panes isolate scroll: min-width: 0 + #panes overflow: hidden", () => {
    it("#panes has min-height: 0 and overflow: hidden", () => {
      const b = block("#panes");
      assert.match(b, /min-height:\s*0/);
      assert.match(b, /overflow:\s*hidden/);
    });

    it("#panes .pane has min-width: 0 so one pane's overflow doesn't leak", () => {
      assert.match(block("#panes .pane"), /min-width:\s*0/);
    });
  });

  describe("R-S5 — no min-height that would block scrolling on short panes", () => {
    it(".table-scroll wrapper declares min-height: 0, not a positive floor", () => {
      // A positive min-height (e.g. `min-height: 200px`) would leave
      // short panes unable to scroll because the wrapper would push
      // the pane taller than its container.
      assert.match(block(".table-scroll"), /min-height:\s*0/);
    });
  });

  describe("R-S6 — per-cell clip keeps row height pinned", () => {
    it("#listing tbody tr > td clips with overflow: hidden + text-overflow: ellipsis", () => {
      // The clip pair lives on the tbody td selector; `white-space:
      // nowrap` is declared on the generic #listing th,td selector.
      assert.match(
        css,
        /#listing tbody tr > td,\s*\n\s*#local-listing tbody tr > td\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/,
      );
    });

    it("#listing th,td declare white-space: nowrap (prevents wrap-based row growth)", () => {
      assert.match(
        css,
        /#listing th,\s*\n\s*#listing td\s*\{[^}]*white-space:\s*nowrap/,
      );
    });

    it("#local-listing th,td declare white-space: nowrap", () => {
      assert.match(
        css,
        /#local-listing th,\s*#local-listing td\s*\{[^}]*white-space:\s*nowrap/,
      );
    });
  });

  describe("R-S7 — virtualization spacers preserve scrollbar proportion", () => {
    it("buildSpacer renders a single full-width td with colSpan + zero padding/border", () => {
      assert.match(
        virtJs,
        /buildSpacer\s*=\s*function buildSpacer\(heightPx\)\s*\{[\s\S]*?td\.colSpan\s*=\s*4/,
      );
      assert.match(virtJs, /td\.style\.padding\s*=\s*["']0["']/);
      assert.match(virtJs, /td\.style\.border\s*=\s*["']0["']/);
    });

    it("virtual-spacer CSS strips hover/border chrome", () => {
      assert.match(
        css,
        /#listing tbody tr\.virtual-spacer\s*\{[^}]*cursor:\s*default[^}]*background:\s*transparent/,
      );
      assert.match(
        css,
        /#listing tbody tr\.virtual-spacer td\s*\{[^}]*padding:\s*0[^}]*border:\s*0/,
      );
    });
  });

  describe("R-S8 — filter/sort re-render preserves scrollTop", () => {
    it("applyFilter does not reset scrollTop", () => {
      // Regression guard: the previous monolith didn't zero scrollTop
      // on filter, and we want to keep it that way. Grep the filter
      // module for any scrollTop write.
      assert.ok(
        !/scrollTop\s*=/.test(filterJs),
        "filter.js must not reassign scrollTop — keep scroll position across filter changes",
      );
    });

    it("applySort does not reset scrollTop", () => {
      assert.ok(
        !/scrollTop\s*=/.test(sortJs),
        "sort.js must not reassign scrollTop — keep scroll position across sort changes",
      );
    });

    it("renderRows does not reset scrollTop on every render", () => {
      // renderRows is called on filter/sort/hidden changes; if it
      // blindly zeroed scrollTop the pane would snap to top on every
      // filter keystroke (painful for long listings).
      const rendersScrollReset = /\.scrollTop\s*=\s*0\b/.test(renderJs);
      assert.ok(
        !rendersScrollReset,
        "rendering.js must not force scrollTop = 0 — breaks S8",
      );
    });
  });

  describe("webview script layering — load order", () => {
    // Sanity check: the concern-split files all exist and follow the
    // namespace pattern. Surfaces typos in file names sooner than a
    // runtime "ns.X is not a function" ever would.
    const expected: readonly string[] = [
      "sftpBrowser/state.js",
      "sftpBrowser/messaging.js",
      "sftpBrowser/navigation.js",
      "sftpBrowser/sort.js",
      "sftpBrowser/filter.js",
      "sftpBrowser/virtualization.js",
      "sftpBrowser/selection.js",
      "sftpBrowser/rendering.js",
      "sftpBrowser/keyboard.js",
      "sftpBrowser/contextMenu.js",
      "sftpBrowser/toolbar.js",
      "sftpBrowser/dragDrop/osDrop.js",
      "sftpBrowser/localPane.js",
      "sftpBrowser/dragDrop/localPaneDrop.js",
      "sftpBrowser/dragDrop/remotePaneDrag.js",
    ];

    for (const rel of expected) {
      it(`${rel} exists`, () => {
        assert.ok(
          fs.existsSync(path.join(MEDIA, rel)),
          `missing webview script ${rel}`,
        );
      });
    }

    it("state.js bootstraps the namespace exactly once", () => {
      const stateJs = readMedia("sftpBrowser/state.js");
      assert.match(stateJs, /vsCrtSftp\s*=/, "state.js must set vsCrtSftp");
      assert.match(stateJs, /ns\.dom\s*=/, "state.js must populate ns.dom");
      assert.match(stateJs, /ns\.state\s*=/, "state.js must populate ns.state");
    });

    it("no concern-split file redefines acquireVsCodeApi", () => {
      // Only state.js is allowed to call acquireVsCodeApi — calling it
      // twice throws "An instance of the VS Code API has already been
      // acquired" at runtime.
      const files = [
        "messaging.js",
        "navigation.js",
        "sort.js",
        "filter.js",
        "virtualization.js",
        "selection.js",
        "rendering.js",
        "keyboard.js",
        "contextMenu.js",
        "toolbar.js",
        "dragDrop/osDrop.js",
        "localPane.js",
        "dragDrop/localPaneDrop.js",
        "dragDrop/remotePaneDrag.js",
      ];
      for (const f of files) {
        const src = readMedia(`sftpBrowser/${f}`);
        assert.ok(
          !/acquireVsCodeApi\s*\(/.test(src),
          `${f} must not call acquireVsCodeApi — only state.js may`,
        );
      }
    });

    it("buildHtml emits the scripts in the documented order", () => {
      // __dirname is `out/test/` when mocha runs; the .ts source lives
      // in `src/` two levels up.
      const buildHtml = fs.readFileSync(
        path.join(
          __dirname,
          "..",
          "..",
          "src",
          "commands",
          "sftpBrowser",
          "panelHost",
          "buildHtml.ts",
        ),
        "utf8",
      );
      // All expected scripts appear in the listed order.
      let cursor = 0;
      for (const rel of expected) {
        const idx = buildHtml.indexOf(`"${rel}"`, cursor);
        assert.notStrictEqual(
          idx,
          -1,
          `buildHtml.ts does not reference ${rel} after position ${cursor}`,
        );
        cursor = idx;
      }
    });
  });
});
