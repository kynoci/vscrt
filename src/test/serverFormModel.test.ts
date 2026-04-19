import * as assert from "assert";
import {
  isValidData,
  JUMP_HOST_PATTERN,
  PORT_FORWARD_PATTERN,
  ENV_KEY_PATTERN,
  ServerFormData,
} from "../treeView/serverFormModel";
import { CRTConfigNode } from "../config/vscrtConfigTypes";

function validPassword(): Partial<ServerFormData> {
  return {
    name: "Web",
    endpoint: "deploy@web",
    preferredAuthentication: "password",
    password: "secret",
    passwordStorage: "secretstorage",
  };
}

function validPubkey(): Partial<ServerFormData> {
  return {
    name: "Web",
    endpoint: "deploy@web",
    preferredAuthentication: "publickey",
    identityFile: "~/.ssh/id_ed25519",
  };
}

describe("isValidData", () => {
  describe("basic fields", () => {
    it("accepts valid password auth data", () => {
      assert.strictEqual(isValidData(validPassword(), undefined), true);
    });

    it("accepts valid publickey auth data", () => {
      assert.strictEqual(isValidData(validPubkey(), undefined), true);
    });

    it("rejects null/undefined", () => {
      assert.strictEqual(isValidData(null, undefined), false);
      assert.strictEqual(isValidData(undefined, undefined), false);
    });

    it("rejects missing name", () => {
      assert.strictEqual(
        isValidData({ ...validPassword(), name: "" }, undefined),
        false,
      );
    });

    it("rejects missing endpoint", () => {
      assert.strictEqual(
        isValidData({ ...validPassword(), endpoint: "" }, undefined),
        false,
      );
    });

    it("rejects invalid preferredAuthentication", () => {
      assert.strictEqual(
        isValidData(
          { ...validPassword(), preferredAuthentication: "none" as "password" },
          undefined,
        ),
        false,
      );
    });
  });

  describe("icon validation", () => {
    it("accepts valid codicon names", () => {
      assert.strictEqual(
        isValidData({ ...validPassword(), icon: "server" }, undefined),
        true,
      );
    });

    it("rejects icons with special characters", () => {
      assert.strictEqual(
        isValidData({ ...validPassword(), icon: "<script>" }, undefined),
        false,
      );
    });
  });

  describe("terminalLocation", () => {
    it("accepts panel and editor", () => {
      assert.strictEqual(
        isValidData({ ...validPassword(), terminalLocation: "panel" }, undefined),
        true,
      );
      assert.strictEqual(
        isValidData({ ...validPassword(), terminalLocation: "editor" }, undefined),
        true,
      );
    });

    it("rejects invalid values", () => {
      assert.strictEqual(
        isValidData(
          { ...validPassword(), terminalLocation: "floating" as "panel" },
          undefined,
        ),
        false,
      );
    });
  });

  describe("jumpHost validation", () => {
    it("accepts valid ProxyJump spec", () => {
      assert.strictEqual(
        isValidData({ ...validPassword(), jumpHost: "user@bastion:22" }, undefined),
        true,
      );
    });

    it("rejects shell metacharacters in jumpHost", () => {
      assert.strictEqual(
        isValidData({ ...validPassword(), jumpHost: "host; rm -rf /" }, undefined),
        false,
      );
    });
  });

  describe("portForwards validation", () => {
    it("accepts valid port forwards", () => {
      assert.strictEqual(
        isValidData(
          { ...validPassword(), portForwards: ["-L 3306:db:3306"] },
          undefined,
        ),
        true,
      );
    });

    it("rejects malformed port forwards", () => {
      assert.strictEqual(
        isValidData(
          { ...validPassword(), portForwards: ["nope"] },
          undefined,
        ),
        false,
      );
    });
  });

  describe("env validation", () => {
    it("accepts valid env vars", () => {
      assert.strictEqual(
        isValidData(
          { ...validPassword(), env: { TERM: "xterm-256color" } },
          undefined,
        ),
        true,
      );
    });

    it("rejects env vars with invalid key names", () => {
      assert.strictEqual(
        isValidData(
          { ...validPassword(), env: { "1BAD": "x" } },
          undefined,
        ),
        false,
      );
    });
  });

  describe("password auth specifics", () => {
    it("rejects missing password on add", () => {
      assert.strictEqual(
        isValidData({ ...validPassword(), password: "" }, undefined),
        false,
      );
    });

    it("allows empty password on edit when existing has password", () => {
      const existing: CRTConfigNode = {
        name: "Web",
        endpoint: "deploy@web",
        preferredAuthentication: "password",
        password: "@secret:uuid",
      };
      assert.strictEqual(
        isValidData({ ...validPassword(), password: "" }, existing),
        true,
      );
    });

    it("rejects invalid passwordStorage", () => {
      assert.strictEqual(
        isValidData(
          { ...validPassword(), passwordStorage: "plain" as "secretstorage" },
          undefined,
        ),
        false,
      );
    });
  });

  describe("publickey auth specifics", () => {
    it("rejects empty identityFile", () => {
      assert.strictEqual(
        isValidData({ ...validPubkey(), identityFile: "" }, undefined),
        false,
      );
    });

    it("rejects .pub suffix", () => {
      assert.strictEqual(
        isValidData(
          { ...validPubkey(), identityFile: "~/.ssh/id_ed25519.pub" },
          undefined,
        ),
        false,
      );
    });

    it("rejects installPublicKeyNow without oneTimePassword", () => {
      assert.strictEqual(
        isValidData(
          { ...validPubkey(), installPublicKeyNow: true },
          undefined,
        ),
        false,
      );
    });

    it("accepts installPublicKeyNow with oneTimePassword", () => {
      assert.strictEqual(
        isValidData(
          { ...validPubkey(), installPublicKeyNow: true, oneTimePassword: "temp123" },
          undefined,
        ),
        true,
      );
    });
  });
});

describe("exported regex patterns", () => {
  it("JUMP_HOST_PATTERN accepts valid specs", () => {
    assert.ok(JUMP_HOST_PATTERN.test("user@host:22"));
    assert.ok(JUMP_HOST_PATTERN.test("alice@jump1,bob@jump2"));
  });

  it("JUMP_HOST_PATTERN rejects shell injection", () => {
    assert.ok(!JUMP_HOST_PATTERN.test("host; whoami"));
    assert.ok(!JUMP_HOST_PATTERN.test("$(cmd)"));
  });

  it("PORT_FORWARD_PATTERN accepts valid specs", () => {
    assert.ok(PORT_FORWARD_PATTERN.test("-L 3306:db:3306"));
    assert.ok(PORT_FORWARD_PATTERN.test("-D 1080"));
  });

  it("PORT_FORWARD_PATTERN rejects invalid", () => {
    assert.ok(!PORT_FORWARD_PATTERN.test("nope"));
    assert.ok(!PORT_FORWARD_PATTERN.test("-L 3306;rm:3306"));
  });

  it("ENV_KEY_PATTERN accepts valid env var names", () => {
    assert.ok(ENV_KEY_PATTERN.test("TERM"));
    assert.ok(ENV_KEY_PATTERN.test("_PRIVATE"));
    assert.ok(ENV_KEY_PATTERN.test("A1"));
  });

  it("ENV_KEY_PATTERN rejects names starting with digit", () => {
    assert.ok(!ENV_KEY_PATTERN.test("1BAD"));
  });
});
