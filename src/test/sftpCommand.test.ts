/**
 * Pure-helper tests for `buildSftpShellCommand`. The command handler
 * itself has VS Code-side I/O (terminal creation, modals, fs writes)
 * that we don't exercise here — those are covered by the integration
 * test scaffold and manual QA. The shell-string builder, however, is
 * pure and carries the security-sensitive quoting invariants, so it
 * deserves direct coverage.
 */

import * as assert from "assert";
import { buildSftpShellCommand } from "../remote";

const POSIX = "linux" as NodeJS.Platform;
const WIN = "win32" as NodeJS.Platform;

describe("buildSftpShellCommand", () => {
  describe("POSIX shape", () => {
    it("builds a bare sftp invocation for password-manual / agent", () => {
      const cmd = buildSftpShellCommand({
        platform: POSIX,
        sftpCmd: "sftp",
        sshArgs: ["-p 22", "-o StrictHostKeyChecking=accept-new"],
        target: "deploy@prod-web",
      });
      assert.strictEqual(
        cmd,
        "'sftp' -P 22 -o StrictHostKeyChecking=accept-new 'deploy@prod-web'",
      );
    });

    it("inserts sshpass -f <file> before sftp for password-auto", () => {
      const cmd = buildSftpShellCommand({
        platform: POSIX,
        sftpCmd: "sftp",
        sshArgs: ["-p 2222"],
        target: "deploy@prod-web",
        pwdFile: "/tmp/vsCRT-abc.pwd",
        sshpassCmd: "sshpass",
      });
      assert.strictEqual(
        cmd,
        "'sshpass' -f '/tmp/vsCRT-abc.pwd' 'sftp' -P 2222 'deploy@prod-web'",
      );
    });

    it("appends -i <key> for publickey auth with pinned identityFile", () => {
      const cmd = buildSftpShellCommand({
        platform: POSIX,
        sftpCmd: "sftp",
        sshArgs: ["-p 22"],
        target: "deploy@prod-web",
        identityFile: "/home/alice/.ssh/id_ed25519",
      });
      assert.ok(cmd.includes("-i '/home/alice/.ssh/id_ed25519'"));
      assert.ok(cmd.endsWith("'deploy@prod-web'"));
    });

    it("single-quotes paths containing spaces", () => {
      const cmd = buildSftpShellCommand({
        platform: POSIX,
        sftpCmd: "sftp",
        sshArgs: ["-p 22"],
        target: "deploy@prod-web",
        identityFile: "/home/alice/my keys/id_ed25519",
      });
      assert.ok(cmd.includes("'/home/alice/my keys/id_ed25519'"));
    });

    it("defangs embedded single quotes in identityFile (POSIX convention)", () => {
      const cmd = buildSftpShellCommand({
        platform: POSIX,
        sftpCmd: "sftp",
        sshArgs: ["-p 22"],
        target: "u@h",
        identityFile: "/home/bob's keys/id",
      });
      // shSingleQuote closes, escapes ', reopens.
      assert.ok(cmd.includes("'/home/bob'\\''s keys/id'"));
    });

    it("defangs shell metacharacters in target", () => {
      const cmd = buildSftpShellCommand({
        platform: POSIX,
        sftpCmd: "sftp",
        sshArgs: [],
        target: "deploy@host; rm -rf /",
      });
      // The target is fully single-quoted so `;` never reaches the shell.
      assert.ok(cmd.includes("'deploy@host; rm -rf /'"));
    });

    it("throws if pwdFile is set without sshpassCmd", () => {
      assert.throws(
        () =>
          buildSftpShellCommand({
            platform: POSIX,
            sftpCmd: "sftp",
            sshArgs: [],
            target: "u@h",
            pwdFile: "/tmp/foo.pwd",
          }),
        /sshpassCmd is required/,
      );
    });
  });

  describe("PowerShell shape", () => {
    it("wraps the command in `& { & ... }` for PowerShell", () => {
      const cmd = buildSftpShellCommand({
        platform: WIN,
        sftpCmd: "sftp.exe",
        sshArgs: ["-p 22"],
        target: "deploy@prod-web",
      });
      assert.ok(cmd.startsWith("& { & "));
      assert.ok(cmd.endsWith(" }"));
      assert.ok(cmd.includes("'sftp.exe'"));
    });

    it("uses PowerShell single-quote doubling for embedded apostrophes", () => {
      const cmd = buildSftpShellCommand({
        platform: WIN,
        sftpCmd: "sftp.exe",
        sshArgs: [],
        target: "u@h",
        identityFile: "C:\\Users\\bob's keys\\id",
      });
      // psSingleQuote: single quote becomes '' (doubled) inside ''.
      assert.ok(cmd.includes("'C:\\Users\\bob''s keys\\id'"));
    });

    it("PowerShell sshpass path", () => {
      const cmd = buildSftpShellCommand({
        platform: WIN,
        sftpCmd: "sftp.exe",
        sshArgs: ["-p 22"],
        target: "deploy@prod-web",
        pwdFile: "C:\\Temp\\vsCRT-abc.pwd",
        sshpassCmd: "sshpass.exe",
      });
      assert.ok(cmd.startsWith("& { & 'sshpass.exe' -f 'C:\\Temp\\vsCRT-abc.pwd' 'sftp.exe'"));
    });
  });

  describe("integration with base ssh args", () => {
    it("threads ProxyJump / port-forward / timeouts through to sftp", () => {
      const cmd = buildSftpShellCommand({
        platform: POSIX,
        sftpCmd: "sftp",
        sshArgs: [
          "-p 22",
          "-o ProxyJump=alice@bastion",
          "-L 3306:db:3306",
          "-o ConnectTimeout=5",
          "-o StrictHostKeyChecking=yes",
        ],
        target: "u@h",
      });
      assert.ok(cmd.includes("ProxyJump=alice@bastion"));
      assert.ok(cmd.includes("-L 3306:db:3306"));
      assert.ok(cmd.includes("ConnectTimeout=5"));
      assert.ok(cmd.includes("StrictHostKeyChecking=yes"));
    });
  });
});

