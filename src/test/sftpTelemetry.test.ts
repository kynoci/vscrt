import * as assert from "assert";
import { buildSftpFileOpEntry } from "../remote";
import type { CRTConfigNode } from "../config/vscrtConfig";

function node(partial: Partial<CRTConfigNode> = {}): CRTConfigNode {
  return { name: "prod-web", endpoint: "u@h", ...partial };
}

describe("buildSftpFileOpEntry", () => {
  const now = new Date("2026-04-17T12:00:00.000Z");

  it("maps succeeded=true to outcome='connected' and drops errorMessage", () => {
    const entry = buildSftpFileOpEntry(
      now,
      node(),
      "deploy@prod",
      22,
      "upload",
      true,
      "/var/app/config.json",
      "ignored",
    );
    assert.strictEqual(entry.outcome, "connected");
    assert.strictEqual(entry.errorMessage, undefined);
  });

  it("maps succeeded=false to outcome='failed' and retains errorMessage", () => {
    const entry = buildSftpFileOpEntry(
      now,
      node(),
      "deploy@prod",
      22,
      "delete",
      false,
      "/var/app/gone.log",
      "permission denied",
    );
    assert.strictEqual(entry.outcome, "failed");
    assert.strictEqual(entry.errorMessage, "permission denied");
  });

  it("sets sessionKind='sftp' and authMode='sftp-browser' on every row", () => {
    const entry = buildSftpFileOpEntry(
      now,
      node(),
      "u@h",
      2222,
      "list",
      true,
    );
    assert.strictEqual(entry.sessionKind, "sftp");
    assert.strictEqual(entry.authMode, "sftp-browser");
  });

  it("formats endpoint as `target:port`", () => {
    const entry = buildSftpFileOpEntry(
      now,
      node(),
      "deploy@prod",
      2201,
      "upload",
      true,
      "/a",
    );
    assert.strictEqual(entry.endpoint, "deploy@prod:2201");
  });

  it("propagates action + remotePath verbatim", () => {
    const entry = buildSftpFileOpEntry(
      now,
      node(),
      "u@h",
      22,
      "rename",
      true,
      "/home/alice/old.txt",
    );
    assert.strictEqual(entry.action, "rename");
    assert.strictEqual(entry.remotePath, "/home/alice/old.txt");
  });

  it("uses the node's name as `serverName`", () => {
    const entry = buildSftpFileOpEntry(
      now,
      node({ name: "staging-bastion" }),
      "u@h",
      22,
      "chmod",
      true,
    );
    assert.strictEqual(entry.serverName, "staging-bastion");
  });

  it("stamps the timestamp as the `now.toISOString()` value", () => {
    const entry = buildSftpFileOpEntry(
      now,
      node(),
      "u@h",
      22,
      "preview",
      true,
    );
    assert.strictEqual(entry.timestamp, "2026-04-17T12:00:00.000Z");
  });
});
