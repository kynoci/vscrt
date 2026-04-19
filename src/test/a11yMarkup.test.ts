/**
 * Structural assertions on the webview a11y markup.
 *
 * These files (`media/connectionView.js`, `media/serverForm.html`, etc.)
 * run in the VS Code webview and are not loaded by the headless Mocha
 * suite. To keep regressions from silently undoing the a11y pass, we
 * read the static files and grep for the contract.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

const MEDIA = path.join(__dirname, "..", "..", "media");

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(MEDIA, relPath), "utf8");
}

describe("webview a11y markup", () => {
  describe("sftpBrowser CSS + HTML contracts", () => {
    const css = readFile("sftpBrowser.css");

    it("no hardcoded hex / rgb colors — tokens only", () => {
      // Every color must resolve through `var(--vscode-…)`. The plan
      // calls this "color-token-discipline" and makes it build-enforced.
      // Matches #abc / #aabbcc and rgb( / rgba( literals. Allows
      // `color-mix(in srgb, var(…) 25%, transparent)` and similar.
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
      const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g);
      assert.strictEqual(
        hex,
        null,
        `hex colors in sftpBrowser.css — should be var(--vscode-…) tokens: ${JSON.stringify(hex)}`,
      );
      const rgbLiteral = stripped.match(/\brgba?\s*\(\s*\d/g);
      assert.strictEqual(
        rgbLiteral,
        null,
        `rgb()/rgba() literals in sftpBrowser.css — use theme tokens: ${JSON.stringify(rgbLiteral)}`,
      );
    });
  });

  // Row-height + scroll contract lives in `sftpScrollContract.test.ts`.
  // The virtualization JS lives at `media/sftpBrowser/virtualization.js`.

  describe("connectionView.js", () => {
    const js = readFile("connectionView.js");

    it("context-menu items get role=menuitem and tabindex=-1", () => {
      assert.match(js, /setAttribute\(['"]role['"], ['"]menuitem['"]\)/);
      assert.match(js, /setAttribute\(['"]tabindex['"], ['"]-1['"]\)/);
    });

    it("context-menu separators get role=separator and aria-hidden", () => {
      assert.match(js, /setAttribute\(['"]role['"], ['"]separator['"]\)/);
      assert.match(js, /setAttribute\(['"]aria-hidden['"], ['"]true['"]\)/);
    });

    it("menu supports arrow-key navigation between items", () => {
      // Look for the keydown handler that walks menuitem elements.
      assert.match(js, /mi\[role="menuitem"\]/);
      assert.match(js, /ArrowDown/);
      assert.match(js, /ArrowUp/);
    });

    it("focuses the first menuitem when the menu opens", () => {
      assert.match(js, /mi\[role="menuitem"\][\s\S]*first\.focus\(\)/);
    });

    it("right-click → Connect uses trigger=dblclick (doubleClick setting)", () => {
      // Regression guard: right-click → Connect should honour
      // `vsCRT.doubleClickTerminalLocation`, same as double-clicking
      // the row. The inline hover row-action button keeps
      // `trigger: 'button'`; right-click → Connect must not.
      const ctxLine = js
        .split("\n")
        .find((l) => /label: 'Connect',\s+action:/.test(l));
      assert.ok(ctxLine, "context-menu 'Connect' entry not found");
      assert.match(ctxLine as string, /trigger: 'dblclick'/);
      assert.ok(
        !/trigger: 'button'/.test(ctxLine as string),
        `right-click Connect must not use 'button' trigger: ${ctxLine}`,
      );
    });

    it("empty-state gets role=status + aria-live=polite for SR announcement", () => {
      assert.match(
        js,
        /empty\.setAttribute\(['"]role['"], ['"]status['"]\)/,
      );
      assert.match(
        js,
        /empty\.setAttribute\(['"]aria-live['"], ['"]polite['"]\)/,
      );
    });

    it("empty-state action buttons are grouped with aria-label", () => {
      assert.match(js, /role="group" aria-label="Get started"/);
    });

    it("decorative codicons inside the empty-state get aria-hidden", () => {
      // Every codicon <i> in the empty-state HTML should be aria-hidden.
      const emptyBlock = js.split("empty.innerHTML")[1] ?? "";
      const codicons = emptyBlock.match(/codicon-[a-z-]+/g) ?? [];
      const hiddens =
        emptyBlock.match(/codicon-[a-z-]+[^>]*aria-hidden="true"/g) ?? [];
      assert.ok(
        codicons.length > 0,
        "expected at least one codicon in empty-state",
      );
      assert.strictEqual(
        hiddens.length,
        codicons.length,
        `all ${codicons.length} codicons should be aria-hidden, found ${hiddens.length}`,
      );
    });
  });

  describe("serverForm.html", () => {
    const html = readFile("serverForm.html");

    it("terminal-location radio group has role=radiogroup + aria-labelledby", () => {
      assert.match(
        html,
        /role="radiogroup"[^>]*aria-labelledby="termloc-label"/,
      );
    });

    it("authentication radio group has role=radiogroup + aria-required", () => {
      assert.match(
        html,
        /role="radiogroup"[^>]*aria-labelledby="auth-label"[^>]*aria-required="true"/,
      );
    });

    it("storage radio group has role=radiogroup + aria-labelledby", () => {
      assert.match(
        html,
        /role="radiogroup"[^>]*aria-labelledby="storage-label"/,
      );
    });

    it("install-public-key checkbox label is tied to the input via for=", () => {
      assert.match(html, /for="installPublicKeyNow"/);
    });

    it("install checkbox advertises its controlled panel via aria-controls", () => {
      assert.match(html, /aria-controls="sect-otp"/);
    });

    it("required markers use aria-hidden for screen readers", () => {
      // The visible '*' is decorative; the real signal is the sr-only text.
      const reqMarkers = html.match(/class="req"[^>]*aria-hidden="true"/g) ?? [];
      assert.ok(
        reqMarkers.length >= 3,
        `expected multiple aria-hidden '*' markers, found ${reqMarkers.length}`,
      );
    });
  });
});
