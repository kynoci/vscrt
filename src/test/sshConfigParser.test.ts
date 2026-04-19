import * as assert from "assert";
import {
  SshHostEntry,
  isWildcard,
  parseSshConfig,
} from "../remote";
import { hostEntryToNode } from "../commands/importSshConfigCommand";

describe("parseSshConfig — agent directives", () => {
  it("preserves AddKeysToAgent and ForwardAgent", () => {
    const out = parseSshConfig([
      "Host agent-host",
      "  HostName 10.0.0.1",
      "  AddKeysToAgent yes",
      "  ForwardAgent yes",
    ].join("\n"));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].addKeysToAgent, "yes");
    assert.strictEqual(out[0].forwardAgent, true);
  });

  it("accepts 'ask' and 'confirm' values for AddKeysToAgent", () => {
    const ask = parseSshConfig([
      "Host a",
      "  AddKeysToAgent ask",
    ].join("\n"));
    assert.strictEqual(ask[0].addKeysToAgent, "ask");
    const confirm = parseSshConfig([
      "Host b",
      "  AddKeysToAgent confirm",
    ].join("\n"));
    assert.strictEqual(confirm[0].addKeysToAgent, "confirm");
  });

  it("drops unknown AddKeysToAgent values", () => {
    const out = parseSshConfig([
      "Host c",
      "  AddKeysToAgent maybe",
    ].join("\n"));
    assert.strictEqual(out[0].addKeysToAgent, undefined);
  });

  it("treats ForwardAgent no as explicit false", () => {
    const out = parseSshConfig([
      "Host d",
      "  ForwardAgent no",
    ].join("\n"));
    assert.strictEqual(out[0].forwardAgent, false);
  });
});

describe("hostEntryToNode — agent directives", () => {
  it("carries ForwardAgent into agentForwarding=true", () => {
    const entry: SshHostEntry = {
      name: "agent",
      hostName: "10.0.0.1",
      forwardAgent: true,
    };
    const node = hostEntryToNode(entry);
    assert.strictEqual(node.agentForwarding, true);
  });

  it("carries AddKeysToAgent through unchanged", () => {
    const entry: SshHostEntry = {
      name: "agent",
      hostName: "10.0.0.1",
      addKeysToAgent: "confirm",
    };
    const node = hostEntryToNode(entry);
    assert.strictEqual(node.addKeysToAgent, "confirm");
  });

  it("omits agentForwarding when ForwardAgent is absent or false", () => {
    const omitted = hostEntryToNode({ name: "a", hostName: "h" });
    assert.strictEqual(omitted.agentForwarding, undefined);
    const explicit = hostEntryToNode({
      name: "b",
      hostName: "h",
      forwardAgent: false,
    });
    assert.strictEqual(explicit.agentForwarding, undefined);
  });
});

describe("parseSshConfig", () => {
  it("extracts a single basic Host block", () => {
    const out = parseSshConfig([
      "Host prod-web",
      "  HostName 10.0.0.1",
      "  User deploy",
      "  Port 2201",
      "  IdentityFile ~/.ssh/prod.pem",
    ].join("\n"));
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0], {
      name: "prod-web",
      hostName: "10.0.0.1",
      user: "deploy",
      port: 2201,
      identityFile: "~/.ssh/prod.pem",
    });
  });

  it("takes the first non-wildcard alias on a multi-alias Host line", () => {
    const out = parseSshConfig([
      "Host prod-web prod-web.internal",
      "  HostName 10.0.0.1",
    ].join("\n"));
    assert.strictEqual(out[0].name, "prod-web");
  });

  it("skips host blocks whose aliases are all wildcards", () => {
    const out = parseSshConfig([
      "Host *",
      "  ServerAliveInterval 60",
      "",
      "Host real-one",
      "  HostName 10.0.0.2",
    ].join("\n"));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].name, "real-one");
  });

  it("treats wildcard-only aliases in multi-alias lines as uselss", () => {
    const out = parseSshConfig([
      "Host *.prod bastion-prod",
      "  HostName bastion.example.com",
    ].join("\n"));
    // `*.prod` is a wildcard; `bastion-prod` is not — pick that.
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].name, "bastion-prod");
  });

  it("parses Keyword=value syntax", () => {
    const out = parseSshConfig([
      "Host foo",
      "  HostName=10.0.0.1",
      "  Port=2222",
    ].join("\n"));
    assert.deepStrictEqual(out[0], {
      name: "foo",
      hostName: "10.0.0.1",
      port: 2222,
    });
  });

  it("applies top-level defaults to hosts missing those fields", () => {
    const out = parseSshConfig([
      "User alice",
      "Port 2201",
      "",
      "Host with-user",
      "  HostName a.example.com",
      "  User bob",
      "",
      "Host uses-defaults",
      "  HostName b.example.com",
    ].join("\n"));
    const withUser = out.find((e) => e.name === "with-user")!;
    const usesDefaults = out.find((e) => e.name === "uses-defaults")!;
    assert.strictEqual(withUser.user, "bob"); // explicit wins
    assert.strictEqual(withUser.port, 2201); // inherits from default
    assert.strictEqual(usesDefaults.user, "alice");
    assert.strictEqual(usesDefaults.port, 2201);
  });

  it("skips keywords inside Match blocks entirely", () => {
    const out = parseSshConfig([
      "Host real",
      "  HostName real.example.com",
      "",
      "Match user root",
      "  User notthisone",
      "  IdentityFile ~/.ssh/bad",
      "",
      "Host after-match",
      "  HostName after.example.com",
    ].join("\n"));
    const real = out.find((e) => e.name === "real")!;
    assert.strictEqual(real.hostName, "real.example.com");
    assert.strictEqual(real.user, undefined);
    const after = out.find((e) => e.name === "after-match")!;
    assert.strictEqual(after.hostName, "after.example.com");
  });

  it("skips Include directives without recursing", () => {
    const out = parseSshConfig([
      "Include ./somewhere",
      "",
      "Host foo",
      "  HostName foo.example.com",
    ].join("\n"));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].name, "foo");
  });

  it("strips # comments and ignores blank lines", () => {
    const out = parseSshConfig([
      "# top comment",
      "",
      "Host web # inline too",
      "  HostName web.example.com  # this is the primary VM",
      "",
      "  # mid-block comment",
      "  User deploy",
    ].join("\n"));
    assert.deepStrictEqual(out, [
      { name: "web", hostName: "web.example.com", user: "deploy" },
    ]);
  });

  it("rejects out-of-range ports", () => {
    const out = parseSshConfig([
      "Host a",
      "  Port 99999",
      "Host b",
      "  Port 0",
      "Host c",
      "  Port 22",
    ].join("\n"));
    assert.strictEqual(out[0].port, undefined);
    assert.strictEqual(out[1].port, undefined);
    assert.strictEqual(out[2].port, 22);
  });

  it("captures ProxyJump verbatim", () => {
    const out = parseSshConfig([
      "Host target",
      "  HostName target.internal",
      "  ProxyJump alice@bastion.example.com",
    ].join("\n"));
    assert.strictEqual(out[0].proxyJump, "alice@bastion.example.com");
  });

  it("keeps only the first IdentityFile when multiple are listed", () => {
    const out = parseSshConfig([
      "Host multi",
      "  IdentityFile ~/.ssh/a",
      "  IdentityFile ~/.ssh/b",
    ].join("\n"));
    assert.strictEqual(out[0].identityFile, "~/.ssh/a");
  });

  it("preserves unknown keywords in extraDirectives (ServerAliveInterval is now native)", () => {
    const out = parseSshConfig([
      "Host x",
      "  HostName x.example.com",
      "  ServerAliveInterval 60",
      "  SomeRandomKeyword nah",
    ].join("\n"));
    // ServerAliveInterval is natively handled now (Round 11 #1).
    assert.strictEqual(out[0].serverAliveIntervalSeconds, 60);
    // Truly unknown keywords land in extraDirectives so a symmetric
    // export can re-emit them verbatim.
    assert.strictEqual(out[0].extraDirectives?.somerandomkeyword, "nah");
    assert.strictEqual(out[0].hostName, "x.example.com");
  });

  it("returns an empty array for an empty / comment-only file", () => {
    assert.deepStrictEqual(parseSshConfig(""), []);
    assert.deepStrictEqual(parseSshConfig("# only a comment\n"), []);
  });
});

describe("isWildcard", () => {
  it("detects *, ?, and ! patterns", () => {
    assert.strictEqual(isWildcard("*"), true);
    assert.strictEqual(isWildcard("prod-*"), true);
    assert.strictEqual(isWildcard("web?"), true);
    assert.strictEqual(isWildcard("!skip"), true);
  });
  it("returns false for plain aliases", () => {
    assert.strictEqual(isWildcard("prod-web"), false);
    assert.strictEqual(isWildcard("db.internal"), false);
  });
});

describe("hostEntryToNode", () => {
  it("builds endpoint from user + hostName + port", () => {
    const node = hostEntryToNode({
      name: "prod",
      hostName: "10.0.0.1",
      user: "deploy",
      port: 2201,
    });
    assert.strictEqual(node.endpoint, "deploy@10.0.0.1:2201");
  });

  it("omits :port when port is the default 22", () => {
    const node = hostEntryToNode({
      name: "p",
      hostName: "10.0.0.1",
      user: "deploy",
      port: 22,
    });
    assert.strictEqual(node.endpoint, "deploy@10.0.0.1");
  });

  it("falls back to entry name when HostName is absent", () => {
    const node = hostEntryToNode({ name: "bare", user: "alice" });
    assert.strictEqual(node.endpoint, "alice@bare");
  });

  it("omits user@ when user is absent", () => {
    const node = hostEntryToNode({ name: "h", hostName: "h.example.com" });
    assert.strictEqual(node.endpoint, "h.example.com");
  });

  it("sets publickey + identityFile when IdentityFile is present", () => {
    const node = hostEntryToNode({
      name: "key",
      hostName: "x",
      identityFile: "~/.ssh/id_ed25519",
    });
    assert.strictEqual(node.preferredAuthentication, "publickey");
    assert.strictEqual(node.identityFile, "~/.ssh/id_ed25519");
  });

  it("copies valid ProxyJump into jumpHost", () => {
    const node = hostEntryToNode({
      name: "t",
      hostName: "t.example.com",
      proxyJump: "alice@bastion",
    });
    assert.strictEqual(node.jumpHost, "alice@bastion");
  });

  it("drops unsafe ProxyJump values and fires the handler", () => {
    let dropped = 0;
    const node = hostEntryToNode(
      {
        name: "t",
        hostName: "t.example.com",
        proxyJump: "bastion; rm -rf /",
      },
      { droppedJumpHandler: () => (dropped += 1) },
    );
    assert.strictEqual(node.jumpHost, undefined);
    assert.strictEqual(dropped, 1);
    // Rest of the entry still makes it through.
    assert.strictEqual(node.endpoint, "t.example.com");
  });
});

// Placate noUnusedLocals: the test file imports the types.
const _: SshHostEntry | undefined = undefined;
void _;
