import * as assert from "assert";
import { hasSshAuthSock, resolveAuthMode } from "../remote";
import { CRTConfigNode } from "../config/vscrtConfig";

function node(partial: Partial<CRTConfigNode>): CRTConfigNode {
  return {
    name: "test",
    endpoint: "u@h",
    ...partial,
  };
}

describe("resolveAuthMode", () => {
  describe("publickey preference", () => {
    it("returns 'publickey' when identityFile is set (regardless of agent)", () => {
      assert.strictEqual(
        resolveAuthMode(
          node({
            preferredAuthentication: "publickey",
            identityFile: "~/.ssh/id_ed25519",
          }),
          { agentAvailable: true },
        ),
        "publickey",
      );
    });

    it("returns 'agent' when identityFile is blank but agent is running", () => {
      assert.strictEqual(
        resolveAuthMode(
          node({ preferredAuthentication: "publickey" }),
          { agentAvailable: true },
        ),
        "agent",
      );
    });

    it("falls through to 'publickey' when agent is unavailable", () => {
      // ssh itself will still try ~/.ssh/id_* conventional paths.
      assert.strictEqual(
        resolveAuthMode(
          node({ preferredAuthentication: "publickey" }),
          { agentAvailable: false },
        ),
        "publickey",
      );
    });

    it("treats whitespace-only identityFile as blank", () => {
      assert.strictEqual(
        resolveAuthMode(
          node({
            preferredAuthentication: "publickey",
            identityFile: "   ",
          }),
          { agentAvailable: true },
        ),
        "agent",
      );
    });
  });

  describe("password preference", () => {
    it("returns 'password-auto' when a password is stored", () => {
      assert.strictEqual(
        resolveAuthMode(
          node({ preferredAuthentication: "password", password: "secret" }),
          { agentAvailable: false },
        ),
        "password-auto",
      );
    });

    it("returns 'password-manual' when no password is stored", () => {
      assert.strictEqual(
        resolveAuthMode(
          node({ preferredAuthentication: "password" }),
          { agentAvailable: false },
        ),
        "password-manual",
      );
    });
  });

  it("treats whitespace-only password as 'not set' (→ password-manual)", () => {
    assert.strictEqual(
      resolveAuthMode(
        node({ preferredAuthentication: "password", password: "   " }),
        { agentAvailable: false },
      ),
      "password-manual",
    );
  });

  it("defaults to password-manual when no preferred auth is set", () => {
    assert.strictEqual(
      resolveAuthMode(node({}), { agentAvailable: true }),
      "password-manual",
    );
  });
});

describe("hasSshAuthSock", () => {
  it("detects the env var when present and non-empty", () => {
    assert.strictEqual(
      hasSshAuthSock({ SSH_AUTH_SOCK: "/tmp/ssh-xxx/agent.123" }),
      true,
    );
  });

  it("returns false for empty strings", () => {
    assert.strictEqual(hasSshAuthSock({ SSH_AUTH_SOCK: "" }), false);
  });

  it("returns false when the env var is missing", () => {
    assert.strictEqual(hasSshAuthSock({}), false);
  });
});
