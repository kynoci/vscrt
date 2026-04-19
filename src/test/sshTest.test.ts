import * as assert from "assert";
import {
  classifyError,
  computeKillTimeoutMs,
  resolveProbeAuthMode,
} from "../remote";

describe("resolveProbeAuthMode", () => {
  it("promotes a password-manual node to password-auto when a password is stored", () => {
    // The regression this guards: Connect works (interactive prompt,
    // user types), Test fails under BatchMode=yes. The stored password
    // should satisfy Test's non-interactive probe.
    const node = {
      name: "prod",
      endpoint: "user@host",
      password: "@secret:xxx",
      // Note: preferredAuthentication intentionally unset — this is
      // the exact shape that made `resolveAuthMode` return "password-manual".
    };
    assert.strictEqual(resolveProbeAuthMode(node), "password-auto");
  });

  it("leaves password-manual alone when nothing is stored", () => {
    const node = {
      name: "prod",
      endpoint: "user@host",
    };
    assert.strictEqual(resolveProbeAuthMode(node), "password-manual");
  });

  it("does not promote when an identityFile is pinned (pubkey intent)", () => {
    const node = {
      name: "prod",
      endpoint: "user@host",
      password: "@secret:xxx",
      identityFile: "~/.ssh/id_ed25519",
      // preferred unset — base resolver would still return
      // "password-manual" but the identityFile signals pubkey intent,
      // so we do NOT promote (pubkey path handles it separately).
    };
    assert.strictEqual(resolveProbeAuthMode(node), "password-manual");
  });

  it("passes through explicit preferredAuthentication without rewriting", () => {
    // password + explicit "password" → already "password-auto", no promotion needed.
    assert.strictEqual(
      resolveProbeAuthMode({
        name: "n",
        endpoint: "u@h",
        preferredAuthentication: "password",
        password: "@secret:yyy",
      }),
      "password-auto",
    );
    // publickey + identityFile → "publickey", never touched.
    assert.strictEqual(
      resolveProbeAuthMode({
        name: "n",
        endpoint: "u@h",
        preferredAuthentication: "publickey",
        identityFile: "~/.ssh/id_ed25519",
      }),
      "publickey",
    );
  });

  it("stays 'agent' when publickey is preferred without a pinned key", () => {
    // When the ssh-agent is available, publickey with no identityFile
    // resolves to "agent"; Test must not promote this to password-auto.
    assert.strictEqual(
      resolveProbeAuthMode(
        {
          name: "n",
          endpoint: "u@h",
          preferredAuthentication: "publickey",
        },
        { agentAvailable: true },
      ),
      "agent",
    );
  });
});

describe("computeKillTimeoutMs", () => {
  it("uses the 30-second floor for small connect-timeouts", () => {
    assert.strictEqual(computeKillTimeoutMs(5), 30_000);
    assert.strictEqual(computeKillTimeoutMs(1), 30_000);
  });

  it("scales with connectTimeout once 4x exceeds the floor", () => {
    // 10 * 4 = 40 > 30 floor → 40_000.
    assert.strictEqual(computeKillTimeoutMs(10), 40_000);
    assert.strictEqual(computeKillTimeoutMs(15), 60_000);
  });

  it("is generous enough that slow-auth ssh sessions don't get killed", () => {
    // The primary regression this guards: default 5 s ConnectTimeout
    // must give the probe at least 30 s overall (vs. the old 7 s).
    assert.ok(computeKillTimeoutMs(5) >= 25_000);
  });
});

/**
 * classifyError takes whatever execFile's rejection produces and maps it
 * to a TestResult.outcome. execFile's error shape varies by failure mode:
 *   - process failed to start   → string `code` (ENOENT, EACCES, …)
 *   - process killed by timeout → `killed: true, signal: 'SIGTERM'`
 *   - process exited non-zero   → numeric `code`, `stderr`
 * Tests exercise each branch with hand-crafted error objects — no real
 * network or subprocess required.
 */
describe("classifyError", () => {
  it("returns ENOENT message when ssh is not on PATH", () => {
    const r = classifyError({ code: "ENOENT" }, 10);
    assert.strictEqual(r.outcome, "error");
    assert.match(r.message, /not on PATH/);
  });

  it("returns a generic start failure for other spawn errors", () => {
    const r = classifyError({ code: "EACCES" }, 10);
    assert.strictEqual(r.outcome, "error");
    assert.match(r.message, /EACCES/);
  });

  it("classifies timeout when killed by signal", () => {
    const r = classifyError(
      { killed: true, signal: "SIGTERM", stderr: "" },
      5000,
    );
    assert.strictEqual(r.outcome, "timeout");
    assert.strictEqual(r.durationMs, 5000);
    // Wall-clock kill message should hint that Connect may still work —
    // users were reporting "Test says timeout but Connect is fine".
    assert.match(r.message, /Connect/);
  });

  it("classifies auth-failed on 'Permission denied' stderr", () => {
    const r = classifyError(
      {
        code: 255,
        stderr: "Permission denied (publickey,password).\n",
      },
      200,
    );
    assert.strictEqual(r.outcome, "auth-failed");
    assert.strictEqual(r.exitCode, 255);
    assert.match(r.message, /Permission denied/);
  });

  it("classifies timeout on stderr 'Connection timed out'", () => {
    const r = classifyError(
      { code: 255, stderr: "ssh: connect to host x port 22: Connection timed out\n" },
      5100,
    );
    assert.strictEqual(r.outcome, "timeout");
    assert.match(r.message, /Connection timed out/);
  });

  it("classifies refused-connection distinctly from auth or timeout", () => {
    const r = classifyError(
      { code: 255, stderr: "ssh: connect to host x port 22: Connection refused\n" },
      80,
    );
    assert.strictEqual(r.outcome, "error");
    assert.match(r.message, /Connection refused/);
  });

  it("classifies host-key changes", () => {
    const r = classifyError(
      {
        code: 255,
        stderr:
          "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.\n",
      },
      100,
    );
    assert.strictEqual(r.outcome, "error");
    assert.match(r.message, /REMOTE HOST|Host key/i);
  });

  it("classifies no-route errors", () => {
    const r = classifyError(
      { code: 255, stderr: "ssh: connect to host: No route to host\n" },
      200,
    );
    assert.strictEqual(r.outcome, "error");
    assert.match(r.message, /No route to host/);
  });

  it("falls through to exit-code message for unclassified stderr", () => {
    const r = classifyError(
      { code: 42, stderr: "something weird\n" },
      50,
    );
    assert.strictEqual(r.outcome, "error");
    assert.strictEqual(r.exitCode, 42);
    assert.match(r.message, /something weird/);
  });

  it("falls through gracefully when stderr is empty", () => {
    const r = classifyError({ code: 7, stderr: "" }, 50);
    assert.strictEqual(r.outcome, "error");
    assert.strictEqual(r.exitCode, 7);
    assert.match(r.message, /Exit 7/);
  });

  it("handles a null/undefined error without throwing", () => {
    const r = classifyError(undefined, 10);
    assert.strictEqual(r.outcome, "error");
  });

  it("preserves only the first line of multi-line stderr", () => {
    const r = classifyError(
      { code: 255, stderr: "Permission denied (publickey).\nssh: retrying…\n" },
      100,
    );
    assert.strictEqual(r.outcome, "auth-failed");
    // First line only — no "retrying" leaked.
    assert.ok(!/retrying/.test(r.message), `leaked: ${r.message}`);
  });

  it("classifies passphrase-protected key as auth-failed with actionable hint", () => {
    const r = classifyError(
      {
        code: 255,
        stderr:
          "Load key \"/home/a/.ssh/id_ed25519\": bad passphrase\nPermission denied (publickey).\n",
      },
      100,
    );
    assert.strictEqual(r.outcome, "auth-failed");
    assert.match(r.message, /passphrase/i);
    assert.match(r.message, /ssh-add/);
  });

  it("classifies libcrypto key-load failure as passphrase-protected", () => {
    const r = classifyError(
      {
        code: 255,
        stderr:
          "Load key \"/home/a/.ssh/id_rsa\": error in libcrypto\nPermission denied.\n",
      },
      100,
    );
    assert.strictEqual(r.outcome, "auth-failed");
    assert.match(r.message, /passphrase/i);
  });

  it("upgrades plain 'Permission denied (publickey)' to a pubkey-specific hint", () => {
    const r = classifyError(
      {
        code: 255,
        stderr: "user@host: Permission denied (publickey).\n",
      },
      100,
    );
    assert.strictEqual(r.outcome, "auth-failed");
    assert.match(r.message, /publickey/i);
    // The hint mentions ssh-agent + a workaround so the user knows
    // Test may fail where Connect still succeeds.
    assert.match(r.message, /ssh-agent|passphrase|Connect/i);
  });

  it("leaves '(publickey,password)' failures alone (no passphrase implication)", () => {
    const r = classifyError(
      {
        code: 255,
        stderr: "Permission denied (publickey,password).\n",
      },
      100,
    );
    assert.strictEqual(r.outcome, "auth-failed");
    // Not the pubkey-only branch — message should be the raw first line.
    assert.ok(!/ssh-agent/i.test(r.message), `leaked upgrade text: ${r.message}`);
    assert.match(r.message, /publickey,password/);
  });

  it("classifies missing identityFile path distinctly from auth-failed", () => {
    const r = classifyError(
      {
        code: 255,
        stderr: "Warning: Identity file ~/.ssh/missing not accessible: No such file or directory.\n",
      },
      80,
    );
    assert.strictEqual(r.outcome, "error");
    assert.match(r.message, /missing|server form|No such/i);
  });
});
