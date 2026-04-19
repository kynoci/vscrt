import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { CRTConfigNode } from "../config/vscrtConfig";
import {
  buildBaseSshArgs,
  buildDisplayTarget,
  expandTilde,
  getSshCommand,
  getSshpassCommand,
  hasUserAtHost,
  isValidJumpHost,
  isValidPortForward,
  resolveEndpoint,
  trimToUndefined,
} from "../remote";

function node(overrides: Partial<CRTConfigNode> = {}): CRTConfigNode {
  return {
    name: "test",
    endpoint: "",
    ...overrides,
  };
}

describe("sshHelpers", () => {
  describe("buildDisplayTarget", () => {
    it("omits the port when it's 22", () => {
      assert.strictEqual(buildDisplayTarget(node({ endpoint: "u@h" })), "u@h");
      assert.strictEqual(buildDisplayTarget(node({ endpoint: "u@h:22" })), "u@h");
    });

    it("includes the port when it's non-standard", () => {
      assert.strictEqual(
        buildDisplayTarget(node({ endpoint: "u@h:2222" })),
        "u@h:2222",
      );
    });

    it("handles bracketed IPv6 targets", () => {
      assert.strictEqual(
        buildDisplayTarget(node({ endpoint: "u@[::1]:2222" })),
        "u@[::1]:2222",
      );
    });

    it("strips port 22 suffix from an endpoint that had one", () => {
      assert.strictEqual(
        buildDisplayTarget(node({ endpoint: "u@h:22" })),
        "u@h",
      );
    });

    it("uses the node's user and hostName when endpoint is empty", () => {
      assert.strictEqual(
        buildDisplayTarget(node({ endpoint: "", hostName: "host", user: "root" })),
        "root@host",
      );
    });
  });

  describe("isValidJumpHost regex edge cases", () => {
    it("accepts IPv4 hosts", () => {
      assert.strictEqual(isValidJumpHost("10.0.0.1"), true);
    });

    it("accepts user@host:port", () => {
      assert.strictEqual(isValidJumpHost("alice@bastion:2222"), true);
    });

    it("accepts comma-separated multi-hop chains", () => {
      assert.strictEqual(
        isValidJumpHost("alice@bastion1,bob@bastion2"),
        true,
      );
    });

    it("rejects strings with spaces", () => {
      assert.strictEqual(isValidJumpHost("alice bastion"), false);
    });

    it("rejects strings with shell metacharacters", () => {
      assert.strictEqual(isValidJumpHost("alice@bastion;rm"), false);
      assert.strictEqual(isValidJumpHost("alice@bastion`whoami`"), false);
      assert.strictEqual(isValidJumpHost("alice@bastion$(pwd)"), false);
      assert.strictEqual(isValidJumpHost("alice@bastion|cat"), false);
    });

    it("rejects empty string", () => {
      assert.strictEqual(isValidJumpHost(""), false);
    });
  });

  describe("isValidPortForward regex edge cases", () => {
    it("accepts -L spec", () => {
      assert.strictEqual(isValidPortForward("-L 3306:db:3306"), true);
    });

    it("accepts -R spec", () => {
      assert.strictEqual(isValidPortForward("-R 8080:localhost:8080"), true);
    });

    it("accepts -D spec", () => {
      assert.strictEqual(isValidPortForward("-D 1080"), true);
    });

    it("rejects unknown direction letter", () => {
      assert.strictEqual(isValidPortForward("-Q 1080"), false);
    });

    it("rejects shell metacharacters in spec body", () => {
      assert.strictEqual(
        isValidPortForward("-L 3306:db;whoami:3306"),
        false,
      );
    });
  });

  describe("trimToUndefined", () => {
    it("returns undefined for undefined or null", () => {
      assert.strictEqual(trimToUndefined(undefined), undefined);
      assert.strictEqual(trimToUndefined(null), undefined);
    });

    it("preserves tab/newline internal characters", () => {
      assert.strictEqual(trimToUndefined("a\tb"), "a\tb");
      assert.strictEqual(trimToUndefined("line1\nline2"), "line1\nline2");
    });

    it("returns undefined for empty or whitespace-only", () => {
      assert.strictEqual(trimToUndefined(""), undefined);
      assert.strictEqual(trimToUndefined("   "), undefined);
      assert.strictEqual(trimToUndefined("\t\n"), undefined);
    });

    it("returns the trimmed string when non-empty", () => {
      assert.strictEqual(trimToUndefined("abc"), "abc");
      assert.strictEqual(trimToUndefined("  abc  "), "abc");
    });
  });

  describe("hasUserAtHost", () => {
    it("returns true when the string contains user@host", () => {
      assert.strictEqual(hasUserAtHost("user@host"), true);
      assert.strictEqual(hasUserAtHost("root@10.0.0.1"), true);
      assert.strictEqual(hasUserAtHost("user@host:2222"), true);
    });

    it("returns false when there is no @, or when either side is empty", () => {
      assert.strictEqual(hasUserAtHost(""), false);
      assert.strictEqual(hasUserAtHost("host"), false);
      assert.strictEqual(hasUserAtHost("@host"), false);
      assert.strictEqual(hasUserAtHost("user@"), false);
    });
  });

  describe("resolveEndpoint", () => {
    it("parses endpoint user@host without a port", () => {
      assert.deepStrictEqual(
        resolveEndpoint(node({ endpoint: "deploy@web" })),
        { target: "deploy@web", port: 22 },
      );
    });

    it("strips a trailing :<port> into the port field", () => {
      assert.deepStrictEqual(
        resolveEndpoint(node({ endpoint: "deploy@web:2222" })),
        { target: "deploy@web", port: 2222 },
      );
    });

    it("accepts user strings containing '@' (right-most @ wins via hasUserAtHost)", () => {
      const r = resolveEndpoint(node({ endpoint: "user@corp@bastion" }));
      assert.strictEqual(r.target, "user@corp@bastion");
      assert.strictEqual(r.port, 22);
    });

    it("handles bracketed IPv6 targets with a port", () => {
      assert.deepStrictEqual(
        resolveEndpoint(node({ endpoint: "deploy@[2001:db8::1]:2222" })),
        { target: "deploy@[2001:db8::1]", port: 2222 },
      );
    });

    it("handles bracketed IPv6 target without a port (defaults to 22)", () => {
      assert.deepStrictEqual(
        resolveEndpoint(node({ endpoint: "deploy@[::1]" })),
        { target: "deploy@[::1]", port: 22 },
      );
    });

    it("does not misread raw IPv6 as a port suffix", () => {
      assert.deepStrictEqual(
        resolveEndpoint(node({ endpoint: "deploy@fe80::1" })),
        { target: "deploy@fe80::1", port: 22 },
      );
    });

    it("keeps the whole endpoint intact when the :suffix is out of port range", () => {
      assert.deepStrictEqual(
        resolveEndpoint(node({ endpoint: "deploy@web:99999" })),
        { target: "deploy@web:99999", port: 22 },
      );
      assert.deepStrictEqual(
        resolveEndpoint(node({ endpoint: "deploy@web:0" })),
        { target: "deploy@web:0", port: 22 },
      );
    });

    it("falls back to user + hostName when endpoint has no user@", () => {
      assert.deepStrictEqual(
        resolveEndpoint(
          node({ endpoint: "", hostName: "prod-db", user: "postgres" }),
        ),
        { target: "postgres@prod-db", port: 22 },
      );
    });

    it("uses endpoint as the host when hostName is absent and endpoint has no @", () => {
      assert.deepStrictEqual(
        resolveEndpoint(node({ endpoint: "bare-host" })),
        { target: "bare-host", port: 22 },
      );
    });

    it("returns just the host when no user is available", () => {
      assert.deepStrictEqual(
        resolveEndpoint(node({ endpoint: "", hostName: "prod-db" })),
        { target: "prod-db", port: 22 },
      );
    });

    it("trims whitespace around endpoint, hostName, and user", () => {
      assert.deepStrictEqual(
        resolveEndpoint(
          node({ endpoint: "  ", hostName: "  web  ", user: "  root  " }),
        ),
        { target: "root@web", port: 22 },
      );
    });

    it("treats whitespace-only hostName with a valid user as just user@", () => {
      const result = resolveEndpoint(
        node({ endpoint: "", hostName: "   ", user: "root" }),
      );
      // With hostName blank after trim and no endpoint, host becomes "".
      assert.strictEqual(result.port, 22);
      // target is "root@" when host is empty — explicitly odd but documented.
      assert.ok(result.target.startsWith("root@") || result.target === "");
    });

    it("prefers endpoint's user@host form over user/hostName fields", () => {
      assert.deepStrictEqual(
        resolveEndpoint(
          node({
            endpoint: "endpoint-user@endpoint-host:2201",
            user: "other-user",
            hostName: "other-host",
          }),
        ),
        { target: "endpoint-user@endpoint-host", port: 2201 },
      );
    });
  });

  describe("expandTilde", () => {
    it("returns empty input untouched", () => {
      assert.strictEqual(expandTilde(""), "");
      assert.strictEqual(expandTilde("   "), "");
    });

    it("expands a lone ~ to the home directory", () => {
      assert.strictEqual(expandTilde("~"), os.homedir());
      assert.strictEqual(expandTilde("  ~  "), os.homedir());
    });

    it("expands ~/foo into <home>/foo", () => {
      assert.strictEqual(
        expandTilde("~/foo/bar"),
        path.join(os.homedir(), "foo/bar"),
      );
    });

    it("expands Windows-style ~\\foo into <home>/foo (normalized)", () => {
      assert.strictEqual(
        expandTilde("~\\foo"),
        path.join(os.homedir(), "foo"),
      );
    });

    it("leaves plain paths alone", () => {
      assert.strictEqual(expandTilde("/absolute/path"), "/absolute/path");
      assert.strictEqual(expandTilde("relative/path"), "relative/path");
    });

    it("does not expand ~user syntax", () => {
      assert.strictEqual(expandTilde("~someuser/foo"), "~someuser/foo");
    });

    it("expands ~/ with just a trailing slash", () => {
      // Semantics: expandTilde("~/") should resolve to home, possibly
      // with a trailing separator.
      const out = expandTilde("~/");
      assert.ok(
        out === os.homedir() || out === os.homedir() + path.sep,
        `got: ${out}`,
      );
    });
  });

  describe("getSshCommand / getSshpassCommand", () => {
    const originalPlatformDesc = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    )!;

    afterEach(() => {
      Object.defineProperty(process, "platform", originalPlatformDesc);
    });

    it("returns ssh / sshpass on non-Windows platforms", () => {
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });
      assert.strictEqual(getSshCommand(), "ssh");
      assert.strictEqual(getSshpassCommand(), "sshpass");
    });

    it("returns ssh.exe / sshpass.exe on Windows", () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      assert.strictEqual(getSshCommand(), "ssh.exe");
      assert.strictEqual(getSshpassCommand(), "sshpass.exe");
    });

    it("returns the non-Windows names on darwin", () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      assert.strictEqual(getSshCommand(), "ssh");
      assert.strictEqual(getSshpassCommand(), "sshpass");
    });
  });

  describe("buildBaseSshArgs", () => {
    it("includes the port and the accept-new host-key fallback", () => {
      assert.deepStrictEqual(
        buildBaseSshArgs(node({ endpoint: "a@b" }), 2222),
        ["-p 2222", "-o StrictHostKeyChecking=accept-new"],
      );
    });

    it("inserts extraArgs before the default accept-new so user overrides win", () => {
      assert.deepStrictEqual(
        buildBaseSshArgs(
          node({ endpoint: "a@b", extraArgs: "-o StrictHostKeyChecking=yes" }),
          22,
        ),
        [
          "-p 22",
          "-o StrictHostKeyChecking=yes",
          "-o StrictHostKeyChecking=accept-new",
        ],
      );
    });

    it("ignores whitespace-only extraArgs", () => {
      assert.deepStrictEqual(
        buildBaseSshArgs(node({ endpoint: "a@b", extraArgs: "   " }), 22),
        ["-p 22", "-o StrictHostKeyChecking=accept-new"],
      );
    });

    it("trims surrounding whitespace on extraArgs", () => {
      assert.deepStrictEqual(
        buildBaseSshArgs(node({ endpoint: "a@b", extraArgs: "  -v  " }), 22),
        ["-p 22", "-v", "-o StrictHostKeyChecking=accept-new"],
      );
    });

    it("emits -o ProxyJump=<value> when jumpHost is set", () => {
      assert.deepStrictEqual(
        buildBaseSshArgs(
          node({ endpoint: "deploy@prod-web", jumpHost: "alice@bastion" }),
          22,
        ),
        [
          "-p 22",
          "-o ProxyJump=alice@bastion",
          "-o StrictHostKeyChecking=accept-new",
        ],
      );
    });

    it("places ProxyJump after extraArgs and before the accept-new default", () => {
      const args = buildBaseSshArgs(
        node({
          endpoint: "a@b",
          extraArgs: "-v",
          jumpHost: "jump.example.com",
        }),
        22,
      );
      assert.deepStrictEqual(args, [
        "-p 22",
        "-v",
        "-o ProxyJump=jump.example.com",
        "-o StrictHostKeyChecking=accept-new",
      ]);
    });

    it("trims and ignores whitespace-only jumpHost", () => {
      assert.deepStrictEqual(
        buildBaseSshArgs(node({ endpoint: "a@b", jumpHost: "   " }), 22),
        ["-p 22", "-o StrictHostKeyChecking=accept-new"],
      );
      assert.deepStrictEqual(
        buildBaseSshArgs(
          node({ endpoint: "a@b", jumpHost: "  bastion  " }),
          22,
        ),
        ["-p 22", "-o ProxyJump=bastion", "-o StrictHostKeyChecking=accept-new"],
      );
    });

    it("supports comma-chained multi-hop jump specs", () => {
      assert.deepStrictEqual(
        buildBaseSshArgs(
          node({ endpoint: "a@b", jumpHost: "alice@jump1,bob@jump2" }),
          22,
        ),
        [
          "-p 22",
          "-o ProxyJump=alice@jump1,bob@jump2",
          "-o StrictHostKeyChecking=accept-new",
        ],
      );
    });

    it("appends each portForwards entry verbatim in order", () => {
      const args = buildBaseSshArgs(
        node({
          endpoint: "a@b",
          portForwards: ["-L 3306:db:3306", "-D 1080"],
        }),
        22,
      );
      assert.deepStrictEqual(args, [
        "-p 22",
        "-L 3306:db:3306",
        "-D 1080",
        "-o StrictHostKeyChecking=accept-new",
      ]);
    });

    it("places portForwards after ProxyJump and before accept-new", () => {
      const args = buildBaseSshArgs(
        node({
          endpoint: "a@b",
          jumpHost: "bastion",
          portForwards: ["-L 5432:pg:5432"],
        }),
        22,
      );
      assert.deepStrictEqual(args, [
        "-p 22",
        "-o ProxyJump=bastion",
        "-L 5432:pg:5432",
        "-o StrictHostKeyChecking=accept-new",
      ]);
    });

    it("trims entries and skips blanks in portForwards", () => {
      const args = buildBaseSshArgs(
        node({ endpoint: "a@b", portForwards: ["  -L 80:localhost:80  ", "", "   "] }),
        22,
      );
      assert.deepStrictEqual(args, [
        "-p 22",
        "-L 80:localhost:80",
        "-o StrictHostKeyChecking=accept-new",
      ]);
    });

    describe("ssh-agent fields", () => {
      it("emits -A when agentForwarding is true", () => {
        const args = buildBaseSshArgs(
          node({ endpoint: "a@b", agentForwarding: true }),
          22,
        );
        assert.ok(args.includes("-A"));
      });

      it("does NOT emit -A when agentForwarding is false or missing", () => {
        const off = buildBaseSshArgs(
          node({ endpoint: "a@b", agentForwarding: false }),
          22,
        );
        const missing = buildBaseSshArgs(node({ endpoint: "a@b" }), 22);
        assert.ok(!off.includes("-A"));
        assert.ok(!missing.includes("-A"));
      });

      it("emits -o AddKeysToAgent=<value> for every valid enum value", () => {
        for (const value of ["yes", "no", "ask", "confirm"] as const) {
          const args = buildBaseSshArgs(
            node({ endpoint: "a@b", addKeysToAgent: value }),
            22,
          );
          assert.ok(
            args.includes(`-o AddKeysToAgent=${value}`),
            `missing -o AddKeysToAgent=${value} for value=${value}`,
          );
        }
      });
    });
  });

  describe("isValidJumpHost", () => {
    it("accepts typical ProxyJump specs", () => {
      for (const jh of [
        "bastion",
        "user@bastion",
        "user@host:2222",
        "alice@jump1,bob@jump2",
        "jump.example.com",
        "user@[2001:db8::1]",
      ]) {
        assert.strictEqual(isValidJumpHost(jh), true, `expected "${jh}" to pass`);
      }
    });

    it("rejects shell metacharacters", () => {
      for (const bad of [
        "bastion; rm -rf /",
        "bastion $(whoami)",
        "bastion|cat",
        "bastion`whoami`",
      ]) {
        assert.strictEqual(isValidJumpHost(bad), false, `expected "${bad}" to fail`);
      }
    });
  });

  describe("isValidPortForward", () => {
    it("accepts valid port forward specs", () => {
      for (const fwd of [
        "-L 3306:db.internal:3306",
        "-R 8080:localhost:8080",
        "-D 1080",
      ]) {
        assert.strictEqual(isValidPortForward(fwd), true, `expected "${fwd}" to pass`);
      }
    });

    it("rejects malformed or dangerous specs", () => {
      for (const bad of ["-L 3306:db;rm:3306", "-D $(whoami)", "nope"]) {
        assert.strictEqual(isValidPortForward(bad), false, `expected "${bad}" to fail`);
      }
    });
  });
});
