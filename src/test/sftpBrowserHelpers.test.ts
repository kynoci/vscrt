import * as assert from "assert";
import {
  guessLanguageId,
  looksBinary,
  parentDir,
  posixJoin,
  summarizeBulkResult,
  toScpPath,
} from "../commands/sftpBrowserHelpers";
import { sshArgsToSftpArgs } from "../remote";

describe("parentDir", () => {
  it("returns the directory above /a/b/c", () => {
    assert.strictEqual(parentDir("/a/b/c"), "/a/b");
  });

  it("returns / when popping the last segment from /a", () => {
    assert.strictEqual(parentDir("/a"), "/");
  });

  it("returns ~ when popping the last segment from ~/a", () => {
    assert.strictEqual(parentDir("~/a"), "~");
  });

  it("fixed points: / and ~", () => {
    assert.strictEqual(parentDir("/"), "/");
    assert.strictEqual(parentDir("~"), "~");
  });

  it("handles deeply nested paths", () => {
    assert.strictEqual(parentDir("/a/b/c/d/e"), "/a/b/c/d");
    assert.strictEqual(parentDir("~/src/app/index.ts"), "~/src/app");
  });
});

describe("posixJoin", () => {
  it("inserts a / separator when dir doesn't end with one", () => {
    assert.strictEqual(posixJoin("/a/b", "c"), "/a/b/c");
    assert.strictEqual(posixJoin("~/src", "app"), "~/src/app");
  });

  it("avoids doubling the separator when dir already ends in /", () => {
    assert.strictEqual(posixJoin("/", "a"), "/a");
    assert.strictEqual(posixJoin("/a/b/", "c"), "/a/b/c");
  });

  it("does not normalize or validate the name", () => {
    // Caller owns shell-quoting; posixJoin just composes.
    assert.strictEqual(posixJoin("/a", "b/c"), "/a/b/c");
    assert.strictEqual(posixJoin("/a", ".hidden"), "/a/.hidden");
  });
});

describe("guessLanguageId", () => {
  it("maps common source extensions to their language id", () => {
    assert.strictEqual(guessLanguageId("foo.ts"), "typescript");
    assert.strictEqual(guessLanguageId("foo.tsx"), "typescript");
    assert.strictEqual(guessLanguageId("foo.js"), "javascript");
    assert.strictEqual(guessLanguageId("foo.mjs"), "javascript");
    assert.strictEqual(guessLanguageId("foo.py"), "python");
    assert.strictEqual(guessLanguageId("foo.rs"), "rust");
    assert.strictEqual(guessLanguageId("foo.go"), "go");
    assert.strictEqual(guessLanguageId("foo.sh"), "shellscript");
    assert.strictEqual(guessLanguageId("foo.bash"), "shellscript");
    assert.strictEqual(guessLanguageId("foo.json"), "json");
    assert.strictEqual(guessLanguageId("foo.yaml"), "yaml");
    assert.strictEqual(guessLanguageId("foo.md"), "markdown");
  });

  it("is case-insensitive on the extension", () => {
    assert.strictEqual(guessLanguageId("README.MD"), "markdown");
    assert.strictEqual(guessLanguageId("Main.JS"), "javascript");
  });

  it("handles paths with directories", () => {
    assert.strictEqual(guessLanguageId("/var/log/syslog.log"), "log");
    assert.strictEqual(guessLanguageId("~/src/app.ts"), "typescript");
  });

  it("returns plaintext for unknown or missing extensions", () => {
    assert.strictEqual(guessLanguageId("foo"), "plaintext");
    assert.strictEqual(guessLanguageId("foo.xyz"), "plaintext");
    assert.strictEqual(guessLanguageId("README"), "plaintext");
  });

  it("returns plaintext for trailing-dot paths", () => {
    assert.strictEqual(guessLanguageId("foo."), "plaintext");
  });

  it("maps C / C++ variants", () => {
    assert.strictEqual(guessLanguageId("x.c"), "c");
    assert.strictEqual(guessLanguageId("x.h"), "c");
    assert.strictEqual(guessLanguageId("x.cpp"), "cpp");
    assert.strictEqual(guessLanguageId("x.hpp"), "cpp");
    assert.strictEqual(guessLanguageId("x.cxx"), "cpp");
  });
});

describe("looksBinary", () => {
  it("returns false for empty input", () => {
    assert.strictEqual(looksBinary(new Uint8Array()), false);
  });

  it("returns true when a NUL byte is present", () => {
    assert.strictEqual(
      looksBinary(new Uint8Array([0x48, 0x00, 0x65, 0x6c, 0x6c, 0x6f])),
      true,
    );
  });

  it("returns false for a pure-ASCII text sample", () => {
    const sample = Buffer.from(
      "Hello, world!\nThis is a plain text file.\n",
      "utf-8",
    );
    assert.strictEqual(looksBinary(new Uint8Array(sample)), false);
  });

  it("returns false for UTF-8 text with multi-byte characters", () => {
    const sample = Buffer.from("héllo — café 日本語\n", "utf-8");
    assert.strictEqual(looksBinary(new Uint8Array(sample)), false);
  });

  it("returns true for a sample full of low control bytes", () => {
    // 0x01-0x08, 0x0E-0x1F are non-text control chars.
    const sample = new Uint8Array(100);
    for (let i = 0; i < sample.length; i += 1) {
      sample[i] = 0x01;
    }
    assert.strictEqual(looksBinary(sample), true);
  });

  it("tolerates tabs, CR, LF without flagging as binary", () => {
    const sample = Buffer.from("a\tb\r\nc\fd\vx", "utf-8");
    assert.strictEqual(looksBinary(new Uint8Array(sample)), false);
  });
});

describe("toScpPath", () => {
  it("joins user@host with a remote path via :", () => {
    assert.strictEqual(
      toScpPath("deploy@prod-web", "/var/log/syslog"),
      "deploy@prod-web:/var/log/syslog",
    );
  });

  it("preserves paths with spaces (caller's shell-quote concern)", () => {
    assert.strictEqual(
      toScpPath("u@h", "/home/me/My Documents/a.txt"),
      "u@h:/home/me/My Documents/a.txt",
    );
  });
});

describe("summarizeBulkResult", () => {
  it("returns 'none' for zero items", () => {
    const s = summarizeBulkResult(0, 0);
    assert.strictEqual(s.kind, "none");
    assert.strictEqual(s.successes, 0);
    assert.strictEqual(s.failures, 0);
  });

  it("returns 'ok' when every item succeeded", () => {
    const s = summarizeBulkResult(3, 0);
    assert.strictEqual(s.kind, "ok");
    assert.ok(s.message.includes("3"));
  });

  it("returns 'failed' when every item failed", () => {
    const s = summarizeBulkResult(0, 2);
    assert.strictEqual(s.kind, "failed");
    assert.ok(s.message.toLowerCase().includes("failed"));
  });

  it("returns 'partial' for a mixed outcome", () => {
    const s = summarizeBulkResult(2, 1);
    assert.strictEqual(s.kind, "partial");
    assert.strictEqual(s.successes, 2);
    assert.strictEqual(s.failures, 1);
    assert.ok(s.message.includes("2"));
    assert.ok(s.message.includes("1"));
  });

  it("uses the singular form when the count is exactly 1", () => {
    const ok = summarizeBulkResult(1, 0);
    assert.ok(ok.message.includes("1 entry"));
    const failed = summarizeBulkResult(0, 1);
    assert.ok(failed.message.includes("1 entry"));
  });
});

describe("sshArgsToSftpArgs", () => {
  it("rewrites a joined '-p 22' element to '-P 22'", () => {
    assert.deepStrictEqual(
      sshArgsToSftpArgs(["-p 22", "-o StrictHostKeyChecking=yes"]),
      ["-P 22", "-o StrictHostKeyChecking=yes"],
    );
  });

  it("preserves the whitespace run between '-p' and the port number", () => {
    // Unlikely to happen in practice (buildBaseSshArgs uses a single
    // space) but the helper shouldn't silently normalise it away.
    assert.deepStrictEqual(sshArgsToSftpArgs(["-p  2222"]), ["-P  2222"]);
  });

  it("rewrites a standalone '-p' token in the split form", () => {
    assert.deepStrictEqual(
      sshArgsToSftpArgs(["-p", "22", "-o", "StrictHostKeyChecking=yes"]),
      ["-P", "22", "-o", "StrictHostKeyChecking=yes"],
    );
  });

  it("leaves other flags untouched (including `-o`, `-i`, `-L`, ProxyJump)", () => {
    const input = [
      "-o ProxyJump=alice@bastion",
      "-L 3306:db:3306",
      "-o ConnectTimeout=5",
      "-i",
      "/home/me/.ssh/id_ed25519",
    ];
    assert.deepStrictEqual(sshArgsToSftpArgs(input), input);
  });

  it("does not touch arguments that merely contain '-p' as a substring", () => {
    // `-p` must be a bare token, not a substring of "-port" or similar.
    assert.deepStrictEqual(
      sshArgsToSftpArgs(["--port=22", "-port"]),
      ["--port=22", "-port"],
    );
  });

  it("does not rewrite '-p' when the value isn't numeric", () => {
    // `"-p foo"` in a joined token shouldn't match — only numeric ports
    // are rewritten. The standalone "-p" token still translates
    // because ssh's -p only ever means port.
    assert.deepStrictEqual(
      sshArgsToSftpArgs(["-p foo"]),
      ["-p foo"],
    );
  });

  it("returns an empty array unchanged", () => {
    assert.deepStrictEqual(sshArgsToSftpArgs([]), []);
  });
});
