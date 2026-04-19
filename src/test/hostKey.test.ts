import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendKnownHostsLine,
  buildBaseSshArgs,
  extractHost,
  formatKnownHostsKey,
  parseHostKeyPolicy,
  pickPreferredKey,
} from "../remote";

describe("parseHostKeyPolicy", () => {
  it("returns valid policy values unchanged", () => {
    assert.strictEqual(parseHostKeyPolicy("auto-accept"), "auto-accept");
    assert.strictEqual(parseHostKeyPolicy("prompt-on-first"), "prompt-on-first");
    assert.strictEqual(parseHostKeyPolicy("strict"), "strict");
  });

  it("falls back to prompt-on-first for unknown / missing values", () => {
    assert.strictEqual(parseHostKeyPolicy(undefined), "prompt-on-first");
    assert.strictEqual(parseHostKeyPolicy(""), "prompt-on-first");
    assert.strictEqual(parseHostKeyPolicy("bogus"), "prompt-on-first");
    assert.strictEqual(parseHostKeyPolicy(42), "prompt-on-first");
  });
});

describe("extractHost", () => {
  it("strips a leading user@ prefix", () => {
    assert.strictEqual(extractHost("deploy@prod-web"), "prod-web");
  });

  it("strips only the last @ (tolerates user names containing @)", () => {
    assert.strictEqual(extractHost("a@b@host"), "host");
  });

  it("returns the string unchanged when no user prefix", () => {
    assert.strictEqual(extractHost("prod-web"), "prod-web");
  });
});

describe("formatKnownHostsKey", () => {
  it("uses the bare host on default port 22", () => {
    assert.strictEqual(formatKnownHostsKey("host.example", 22), "host.example");
  });

  it("uses [host]:port for non-default ports", () => {
    assert.strictEqual(
      formatKnownHostsKey("host.example", 2222),
      "[host.example]:2222",
    );
  });
});

describe("pickPreferredKey", () => {
  const ed25519 =
    "host.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample";
  const rsa = "host.example ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQExample";
  const ecdsa =
    "host.example ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyExample";

  it("returns null on empty output", () => {
    assert.strictEqual(pickPreferredKey(""), null);
    assert.strictEqual(pickPreferredKey("# comment only\n"), null);
  });

  it("prefers ed25519 over rsa", () => {
    const out = pickPreferredKey(`${rsa}\n${ed25519}`);
    assert.ok(out);
    assert.strictEqual(out.keyType, "ssh-ed25519");
  });

  it("prefers ecdsa over rsa when ed25519 absent", () => {
    const out = pickPreferredKey(`${rsa}\n${ecdsa}`);
    assert.ok(out);
    assert.strictEqual(out.keyType, "ecdsa-sha2-nistp256");
  });

  it("falls back to whatever key is available", () => {
    const out = pickPreferredKey(rsa);
    assert.ok(out);
    assert.strictEqual(out.keyType, "ssh-rsa");
    assert.strictEqual(out.line, rsa);
  });

  it("ignores # comment lines emitted by ssh-keyscan", () => {
    const input = [
      "# host.example:22 SSH-2.0-OpenSSH_9.0",
      ed25519,
      "# extra comment",
    ].join("\n");
    const out = pickPreferredKey(input);
    assert.ok(out);
    assert.strictEqual(out.line, ed25519);
  });
});

describe("appendKnownHostsLine", () => {
  let dir: string;
  let knownHostsPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscrt-kh-"));
    knownHostsPath = path.join(dir, "known_hosts");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file if missing and appends the line with a trailing newline", async () => {
    await appendKnownHostsLine("host.example ssh-ed25519 AAAA", knownHostsPath);
    const contents = fs.readFileSync(knownHostsPath, "utf-8");
    assert.strictEqual(contents, "host.example ssh-ed25519 AAAA\n");
  });

  it("preserves existing entries and appends under them", async () => {
    fs.writeFileSync(knownHostsPath, "other ssh-rsa AAAA\n", { mode: 0o600 });
    await appendKnownHostsLine("host.example ssh-ed25519 BBBB", knownHostsPath);
    const contents = fs.readFileSync(knownHostsPath, "utf-8");
    assert.strictEqual(
      contents,
      "other ssh-rsa AAAA\nhost.example ssh-ed25519 BBBB\n",
    );
  });

  it("does not duplicate newline when line already ends in one", async () => {
    await appendKnownHostsLine("host.example ssh-ed25519 CCCC\n", knownHostsPath);
    const contents = fs.readFileSync(knownHostsPath, "utf-8");
    assert.strictEqual(contents, "host.example ssh-ed25519 CCCC\n");
  });
});

describe("buildBaseSshArgs: hostKeyCheck mode mapping", () => {
  const node = { name: "n", endpoint: "u@h" };

  it("emits accept-new by default (backwards-compatible)", () => {
    const args = buildBaseSshArgs(node, 22);
    assert.ok(args.includes("-o StrictHostKeyChecking=accept-new"));
  });

  it("emits yes when policy is strict", () => {
    const args = buildBaseSshArgs(node, 22, { hostKeyCheck: "strict" });
    assert.ok(args.includes("-o StrictHostKeyChecking=yes"));
    assert.ok(!args.some((a) => a.includes("accept-new")));
  });

  it("emits ask when policy is ask (ProxyJump fallback)", () => {
    const args = buildBaseSshArgs(node, 22, { hostKeyCheck: "ask" });
    assert.ok(args.includes("-o StrictHostKeyChecking=ask"));
  });

  it("emits accept-new when policy is accept-new explicitly", () => {
    const args = buildBaseSshArgs(node, 22, { hostKeyCheck: "accept-new" });
    assert.ok(args.includes("-o StrictHostKeyChecking=accept-new"));
  });

  it("starts with -p <port> as the first arg", () => {
    const args = buildBaseSshArgs(node, 2222);
    assert.strictEqual(args[0], "-p 2222");
  });

  it("skips whitespace-only extraArgs", () => {
    const args = buildBaseSshArgs(
      { name: "n", endpoint: "u@h", extraArgs: "   " },
      22,
    );
    // No empty string appended from the extraArgs path.
    assert.ok(args.every((a) => a.trim().length > 0));
  });
});
