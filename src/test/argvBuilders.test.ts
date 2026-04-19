import * as assert from "assert";
import {
  buildBashArgvSshpassCommand,
  buildPowerShellArgvSshpassCommand,
  detectShellKind,
  psSingleQuote,
  shSingleQuote,
} from "../remote";

describe("shell-safe quoting", () => {
  describe("shSingleQuote", () => {
    it("wraps a plain string in single quotes", () => {
      assert.strictEqual(shSingleQuote("hello"), "'hello'");
    });

    it("leaves shell metacharacters literal inside the quotes", () => {
      for (const meta of ["$HOME", "`whoami`", "\\nt", '"quotes"', ";|&"]) {
        assert.strictEqual(shSingleQuote(meta), `'${meta}'`);
      }
    });

    it("closes + escapes + reopens on an embedded single quote", () => {
      assert.strictEqual(shSingleQuote("it's"), "'it'\\''s'");
    });

    it("handles consecutive single quotes", () => {
      assert.strictEqual(shSingleQuote("'''"), "''\\'''\\'''\\'''");
    });

    it("handles the empty string", () => {
      assert.strictEqual(shSingleQuote(""), "''");
    });
  });

  describe("psSingleQuote", () => {
    it("wraps a plain string in single quotes", () => {
      assert.strictEqual(psSingleQuote("hello"), "'hello'");
    });

    it("leaves $ and backticks literal (PowerShell doesn't expand in '...')", () => {
      assert.strictEqual(psSingleQuote("$env:USER"), "'$env:USER'");
      assert.strictEqual(psSingleQuote("`n`r"), "'`n`r'");
    });

    it("doubles an embedded single quote", () => {
      assert.strictEqual(psSingleQuote("it's"), "'it''s'");
      assert.strictEqual(psSingleQuote("''"), "''''''");
    });
  });
});

describe("buildBashArgvSshpassCommand", () => {
  const fixed = {
    sshpassCmd: "sshpass",
    sshCmd: "ssh",
    sshArgs: ["-p 22", "-o StrictHostKeyChecking=accept-new"],
    target: "deploy@web",
  };

  it("emits the expected bash one-liner for a benign password", () => {
    const cmd = buildBashArgvSshpassCommand({ ...fixed, password: "hunter2" });
    assert.strictEqual(
      cmd,
      "HISTFILE=/dev/null; 'sshpass' -p 'hunter2' 'ssh' -p 22 -o StrictHostKeyChecking=accept-new 'deploy@web'",
    );
  });

  it("contains a password with $ inside single quotes (no expansion)", () => {
    const cmd = buildBashArgvSshpassCommand({
      ...fixed,
      password: "pa$$word",
    });
    assert.ok(
      cmd.includes("-p 'pa$$word'"),
      `expected literal \${ in quotes: ${cmd}`,
    );
  });

  it("quotes backticks so no command substitution happens", () => {
    const cmd = buildBashArgvSshpassCommand({
      ...fixed,
      password: "a`whoami`b",
    });
    assert.ok(cmd.includes("-p 'a`whoami`b'"));
  });

  it("quotes double quotes literally", () => {
    const cmd = buildBashArgvSshpassCommand({
      ...fixed,
      password: 'a"b"c',
    });
    assert.ok(cmd.includes(`-p 'a"b"c'`));
  });

  it("escapes a single quote by ending + inserting \\' + reopening", () => {
    const cmd = buildBashArgvSshpassCommand({
      ...fixed,
      password: "a'b",
    });
    assert.ok(
      cmd.includes("-p 'a'\\''b'"),
      `expected escaped single quote, got: ${cmd}`,
    );
  });

  it("quotes passwords that try to break out with ; and |", () => {
    const cmd = buildBashArgvSshpassCommand({
      ...fixed,
      password: "x; rm -rf /; echo y",
    });
    assert.ok(cmd.includes("-p 'x; rm -rf /; echo y'"));
    // The metacharacters from the PASSWORD must not appear outside quotes.
    // (The intentional `;` after HISTFILE=/dev/null is part of the template,
    // so we check the password-injected text specifically.)
    const afterPassword = cmd.slice(cmd.indexOf("-p '") + 4);
    const beforeCloseQuote = afterPassword.slice(
      0,
      afterPassword.indexOf("'"),
    );
    assert.strictEqual(beforeCloseQuote, "x; rm -rf /; echo y");
  });

  it("quotes a newline inside the password", () => {
    const cmd = buildBashArgvSshpassCommand({
      ...fixed,
      password: "line1\nline2",
    });
    assert.ok(cmd.includes("-p 'line1\nline2'"));
  });
});

describe("buildPowerShellArgvSshpassCommand", () => {
  const fixed = {
    sshpassCmd: "sshpass.exe",
    sshCmd: "ssh.exe",
    sshArgs: ["-p 22"],
    target: "deploy@web",
  };

  it("emits the expected PowerShell block for a benign password", () => {
    const cmd = buildPowerShellArgvSshpassCommand({
      ...fixed,
      password: "hunter2",
    });
    assert.ok(cmd.startsWith("& { "));
    assert.ok(cmd.endsWith("}"));
    assert.ok(
      cmd.includes("& 'sshpass.exe' -p 'hunter2' 'ssh.exe' -p 22 'deploy@web'"),
    );
    assert.ok(cmd.includes("Set-PSReadLineOption -HistorySaveStyle SaveNothing"));
  });

  it("doesn't expand $env in single-quoted PowerShell literals", () => {
    const cmd = buildPowerShellArgvSshpassCommand({
      ...fixed,
      password: "pw-$env:USERNAME-end",
    });
    assert.ok(cmd.includes("-p 'pw-$env:USERNAME-end'"));
  });

  it("doubles a single quote in the password (PS convention)", () => {
    const cmd = buildPowerShellArgvSshpassCommand({
      ...fixed,
      password: "a'b",
    });
    assert.ok(cmd.includes("-p 'a''b'"));
  });

  it("treats backticks as literals inside single-quoted strings", () => {
    const cmd = buildPowerShellArgvSshpassCommand({
      ...fixed,
      password: "a`n`t",
    });
    assert.ok(cmd.includes("-p 'a`n`t'"));
  });
});

describe("detectShellKind", () => {
  // NOTE: path.basename on Linux only splits on '/', not '\\', so these tests
  // use bare basenames or Unix paths. Windows-path tests are only meaningful
  // in CI's Windows matrix row.
  it("detects bash from Unix paths", () => {
    assert.strictEqual(detectShellKind("/bin/bash"), "bash");
    assert.strictEqual(detectShellKind("/usr/bin/bash"), "bash");
  });

  it("detects bash-family shells (sh, zsh, fish)", () => {
    assert.strictEqual(detectShellKind("/bin/sh"), "bash");
    assert.strictEqual(detectShellKind("/usr/bin/zsh"), "bash");
    assert.strictEqual(detectShellKind("/usr/bin/fish"), "bash");
  });

  it("detects powershell from bare names", () => {
    assert.strictEqual(detectShellKind("pwsh"), "powershell");
    assert.strictEqual(detectShellKind("pwsh.exe"), "powershell");
    assert.strictEqual(detectShellKind("/usr/bin/pwsh"), "powershell");
  });

  it("detects wsl from bare name", () => {
    assert.strictEqual(detectShellKind("wsl"), "wsl");
    assert.strictEqual(detectShellKind("wsl.exe"), "wsl");
  });

  it("detects cmd from bare name", () => {
    assert.strictEqual(detectShellKind("cmd"), "cmd");
    assert.strictEqual(detectShellKind("cmd.exe"), "cmd");
  });

  it("returns unknown for unrecognized shells", () => {
    assert.strictEqual(detectShellKind("/usr/bin/unknown-shell"), "unknown");
    assert.strictEqual(detectShellKind(""), "unknown");
  });
});

