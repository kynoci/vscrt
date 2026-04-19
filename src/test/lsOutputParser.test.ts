import * as assert from "assert";
import {
  normalizeRemotePath,
  parseLsLong,
  shellQuoteRemotePath,
} from "../remote";

describe("parseLsLong", () => {
  it("parses a canonical GNU ls listing", () => {
    const stdout = [
      "total 32",
      "drwxr-xr-x 3 user group 4096 Apr 17 10:00 docs",
      "-rw-r--r-- 1 user group  220 Apr 17 10:00 .bashrc",
    ].join("\n");
    const rows = parseLsLong(stdout);
    assert.deepStrictEqual(rows, [
      {
        name: "docs",
        kind: "dir",
        size: 4096,
        perms: "drwxr-xr-x",
        mtime: "Apr 17 10:00",
      },
      {
        name: ".bashrc",
        kind: "file",
        size: 220,
        perms: "-rw-r--r--",
        mtime: "Apr 17 10:00",
      },
    ]);
  });

  it("classifies symlinks and extracts the target", () => {
    const stdout = "lrwxrwxrwx 1 u g 11 Apr 17 10:00 link -> /etc/hosts";
    const rows = parseLsLong(stdout);
    assert.deepStrictEqual(rows[0], {
      name: "link",
      kind: "symlink",
      size: 11,
      perms: "lrwxrwxrwx",
      mtime: "Apr 17 10:00",
      linkTarget: "/etc/hosts",
    });
  });

  it("recognises long-iso date style (2-token date)", () => {
    const stdout =
      "-rw-r--r-- 1 u g 200 2026-04-17 10:00 file.log";
    const rows = parseLsLong(stdout);
    assert.deepStrictEqual(rows[0], {
      name: "file.log",
      kind: "file",
      size: 200,
      perms: "-rw-r--r--",
      mtime: "2026-04-17 10:00",
    });
  });

  it("handles names containing spaces", () => {
    const stdout =
      "-rw-r--r-- 1 u g 100 Apr 17 10:00 my file with spaces.txt";
    const rows = parseLsLong(stdout);
    assert.strictEqual(rows[0].name, "my file with spaces.txt");
    assert.strictEqual(rows[0].kind, "file");
  });


  it("drops rows with malformed permission strings", () => {
    const stdout = [
      "garbage line with no perms",
      "drwxr-xr-x 3 u g 4096 Apr 17 10:00 good",
    ].join("\n");
    const rows = parseLsLong(stdout);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, "good");
  });

  it("tolerates permission flags (ACL `+`, xattr `@`, SELinux `.`)", () => {
    const stdout = [
      "drwxr-xr-x+ 3 u g 4096 Apr 17 10:00 aclDir",
      "-rw-r--r--@ 1 u g  100 Apr 17 10:00 xattrFile",
      "-rw-r--r--. 1 u g  100 Apr 17 10:00 selinuxFile",
    ].join("\n");
    const rows = parseLsLong(stdout);
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].name, "aclDir");
    assert.strictEqual(rows[1].name, "xattrFile");
    assert.strictEqual(rows[2].name, "selinuxFile");
  });

  it("skips the 'total N' header", () => {
    const stdout = "total 999\ndrwxr-xr-x 3 u g 4096 Apr 17 10:00 x";
    assert.strictEqual(parseLsLong(stdout).length, 1);
  });

  it("classifies block/char/socket/pipe as 'other'", () => {
    const stdout = [
      "brw-rw---- 1 root disk 8, 0 Apr 17 10:00 sda",
      "crw-rw-rw- 1 root tty  5, 0 Apr 17 10:00 tty",
    ].join("\n");
    const rows = parseLsLong(stdout);
    // These have a ", " between major/minor so token-5 isn't pure digits
    // → size becomes 0. But the permission-string first char still
    // classifies the kind.
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].kind, "other");
    assert.strictEqual(rows[1].kind, "other");
  });

  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(parseLsLong(""), []);
    assert.deepStrictEqual(parseLsLong("\n\n\n"), []);
  });
});

describe("normalizeRemotePath", () => {
  it("defaults empty / whitespace to home (~)", () => {
    assert.strictEqual(normalizeRemotePath(""), "~");
    assert.strictEqual(normalizeRemotePath("   "), "~");
  });

  it("passes absolute paths through", () => {
    assert.strictEqual(normalizeRemotePath("/var/log"), "/var/log");
  });

  it("preserves the ~ prefix", () => {
    assert.strictEqual(normalizeRemotePath("~/src"), "~/src");
  });

  it("anchors relative paths to home", () => {
    assert.strictEqual(normalizeRemotePath("src/a"), "~/src/a");
  });

  it("collapses .. segments", () => {
    assert.strictEqual(normalizeRemotePath("/a/b/../c"), "/a/c");
    assert.strictEqual(normalizeRemotePath("~/a/../b"), "~/b");
  });

  it("collapses redundant /", () => {
    assert.strictEqual(normalizeRemotePath("/a//b///c"), "/a/b/c");
  });

  it("clamps .. at the root", () => {
    assert.strictEqual(normalizeRemotePath("/../../../x"), "/x");
  });
});

describe("shellQuoteRemotePath", () => {
  it("wraps in single quotes", () => {
    assert.strictEqual(shellQuoteRemotePath("/var/log"), "'/var/log'");
  });

  it("escapes embedded apostrophes via '\\'' idiom", () => {
    assert.strictEqual(
      shellQuoteRemotePath("/home/bob's docs"),
      "'/home/bob'\\''s docs'",
    );
  });

  it("leaves a bare tilde unquoted so the remote shell expands $HOME", () => {
    // Regression: SFTP Browser used to send `ls -la '~'` and get
    // `ls: cannot access '~'` every time. POSIX shells only expand
    // `~` when it's unquoted at the start of a word — so for the
    // home-directory case we must emit `~` bare.
    assert.strictEqual(shellQuoteRemotePath("~"), "~");
  });

  it("leaves the tilde unquoted but quotes the rest of the path", () => {
    // `~/src` → `~/'src'` so `$HOME` expands AND the name after the
    // slash is still defanged against shell metacharacters.
    assert.strictEqual(shellQuoteRemotePath("~/src"), "~/'src'");
  });

  it("still defangs shell metacharacters inside a ~/-rooted path", () => {
    // A name like `$(evil)` must remain literal when the shell
    // re-parses — so the non-tilde portion is still single-quoted.
    assert.strictEqual(
      shellQuoteRemotePath("~/$(evil)"),
      "~/'$(evil)'",
    );
  });

  it("escapes apostrophes inside a ~/-rooted path", () => {
    assert.strictEqual(
      shellQuoteRemotePath("~/bob's notes"),
      "~/'bob'\\''s notes'",
    );
  });

  it("handles the bare `~/` edge case without crashing", () => {
    assert.strictEqual(shellQuoteRemotePath("~/"), "~/");
  });
});
