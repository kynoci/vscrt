import * as assert from "assert";
import { buildBaseSshArgs, parseSshConfig } from "../remote";
import { hostEntryToNode } from "../commands/importSshConfigCommand";
import { CRTConfigNode } from "../config/vscrtConfig";

function node(partial: Partial<CRTConfigNode>): CRTConfigNode {
  return { name: "t", endpoint: "u@h", ...partial };
}

describe("parseSshConfig: native extras", () => {
  it("captures ConnectTimeout + ServerAliveInterval + IdentitiesOnly", () => {
    const out = parseSshConfig([
      "Host bastion",
      "  HostName bastion.example",
      "  ConnectTimeout 15",
      "  ServerAliveInterval 60",
      "  IdentitiesOnly yes",
    ].join("\n"));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].connectTimeoutSeconds, 15);
    assert.strictEqual(out[0].serverAliveIntervalSeconds, 60);
    assert.strictEqual(out[0].identitiesOnly, true);
  });

  it("rejects out-of-range ConnectTimeout", () => {
    const out = parseSshConfig([
      "Host x",
      "  ConnectTimeout 999999",
    ].join("\n"));
    assert.strictEqual(out[0].connectTimeoutSeconds, undefined);
  });

  it("preserves unknown directives in extraDirectives", () => {
    const out = parseSshConfig([
      "Host prod",
      "  HostName prod.example",
      "  ControlMaster auto",
      "  ControlPath ~/.ssh/cm-%r@%h:%p",
      "  HostKeyAlgorithms ssh-ed25519,ssh-rsa",
    ].join("\n"));
    assert.ok(out[0].extraDirectives);
    assert.strictEqual(out[0].extraDirectives.controlmaster, "auto");
    assert.strictEqual(
      out[0].extraDirectives.controlpath,
      "~/.ssh/cm-%r@%h:%p",
    );
    assert.strictEqual(
      out[0].extraDirectives.hostkeyalgorithms,
      "ssh-ed25519,ssh-rsa",
    );
  });
});


describe("hostEntryToNode: extras → CRTConfigNode", () => {
  it("carries timeouts and IdentitiesOnly through", () => {
    const n = hostEntryToNode({
      name: "a",
      hostName: "h",
      connectTimeoutSeconds: 12,
      serverAliveIntervalSeconds: 45,
      identitiesOnly: true,
    });
    assert.strictEqual(n.connectTimeoutSeconds, 12);
    assert.strictEqual(n.serverAliveIntervalSeconds, 45);
    assert.strictEqual(n.identitiesOnly, true);
  });

  it("copies extraDirectives when present", () => {
    const n = hostEntryToNode({
      name: "a",
      hostName: "h",
      extraDirectives: { controlmaster: "auto" },
    });
    assert.deepStrictEqual(n.extraSshDirectives, { controlmaster: "auto" });
  });
});

describe("buildBaseSshArgs: native extras emit -o flags", () => {
  it("emits ConnectTimeout / ServerAliveInterval / IdentitiesOnly", () => {
    const args = buildBaseSshArgs(
      node({
        endpoint: "u@h",
        connectTimeoutSeconds: 15,
        serverAliveIntervalSeconds: 60,
        identitiesOnly: true,
      }),
      22,
    );
    assert.ok(args.includes("-o ConnectTimeout=15"));
    assert.ok(args.includes("-o ServerAliveInterval=60"));
    assert.ok(args.includes("-o IdentitiesOnly=yes"));
  });

  it("emits IdentitiesOnly=no when set to false", () => {
    const args = buildBaseSshArgs(
      node({ endpoint: "u@h", identitiesOnly: false }),
      22,
    );
    assert.ok(args.includes("-o IdentitiesOnly=no"));
  });

  it("emits preserved extraSshDirectives as -o flags", () => {
    const args = buildBaseSshArgs(
      node({
        endpoint: "u@h",
        extraSshDirectives: {
          ControlMaster: "auto",
          StrictHostKeyChecking: "yes",
        },
      }),
      22,
    );
    assert.ok(args.includes("-o ControlMaster=auto"));
    assert.ok(args.includes("-o StrictHostKeyChecking=yes"));
  });

  it("rejects keys with special characters in extraSshDirectives", () => {
    const args = buildBaseSshArgs(
      node({
        endpoint: "u@h",
        extraSshDirectives: { "bad key": "x", "Control-Master": "y" },
      }),
      22,
    );
    assert.ok(!args.some((a) => a.includes("bad key")));
    assert.ok(!args.some((a) => a.includes("Control-Master")));
  });

  it("rejects values with shell metacharacters in extraSshDirectives", () => {
    const args = buildBaseSshArgs(
      node({
        endpoint: "u@h",
        extraSshDirectives: { MaliciousOpt: "value; rm -rf /" },
      }),
      22,
    );
    assert.ok(!args.some((a) => a.includes("rm -rf")));
  });

  it("rejects values with newlines in extraSshDirectives (option injection)", () => {
    const args = buildBaseSshArgs(
      node({
        endpoint: "u@h",
        extraSshDirectives: { SafeKey: "yes\n-o ProxyCommand=evil" },
      }),
      22,
    );
    assert.ok(
      !args.some((a) => a.includes("ProxyCommand")),
      "newline in value should be rejected to prevent option injection",
    );
  });

  it("rejects values with NUL bytes in extraSshDirectives", () => {
    const args = buildBaseSshArgs(
      node({
        endpoint: "u@h",
        extraSshDirectives: { Opt: "val\x00ue" },
      }),
      22,
    );
    assert.ok(!args.some((a) => a.includes("Opt")));
  });
});
