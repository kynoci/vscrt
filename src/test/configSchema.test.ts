import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { Ajv, ValidateFunction } from "ajv";

// Compiled layout: out/test/configSchema.test.js → repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  "schemas",
  "vscrtConfig.schema.json",
);
const EXAMPLE_PATH = path.join(REPO_ROOT, "vscrtConfigExample.json");

// ajv@8 defaults to draft-2020-12. `strict: false` lets us compile a
// draft-07 schema and the non-standard `deprecationMessage` keyword that
// VS Code consumes without flagging the test suite.
function makeValidator(): ValidateFunction<unknown> {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  return ajv.compile<unknown>(schema);
}

describe("vscrtConfig.schema.json", () => {
  let validate: ValidateFunction<unknown>;

  before(() => {
    validate = makeValidator();
  });

  describe("file-level sanity", () => {
    it("is valid JSON and compiles under ajv", () => {
      const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
      assert.strictEqual(typeof schema.title, "string");
      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties.folder);
      assert.ok(schema.definitions.folder);
      assert.ok(schema.definitions.node);
    });
  });

  describe("accepts valid configurations", () => {
    it("accepts the bundled vscrtConfigExample.json", () => {
      const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, "utf8"));
      const ok = validate(example);
      if (!ok) {
        assert.fail(
          `example config should validate:\n${JSON.stringify(validate.errors, null, 2)}`,
        );
      }
    });

    it("accepts an empty object", () => {
      assert.strictEqual(validate({}), true);
    });

    it("accepts an empty folder array", () => {
      assert.strictEqual(validate({ folder: [] }), true);
    });

    it("accepts a minimal node with just name + endpoint", () => {
      const cfg = {
        folder: [
          { name: "Prod", nodes: [{ name: "web", endpoint: "u@h" }] },
        ],
      };
      assert.strictEqual(validate(cfg), true);
    });

    it("accepts deeply nested subfolders", () => {
      const cfg = {
        folder: [
          {
            name: "A",
            subfolder: [
              {
                name: "B",
                subfolder: [
                  { name: "C", nodes: [{ name: "n", endpoint: "u@h" }] },
                ],
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), true);
    });

    it("accepts the top-level vsCRT.*TerminalLocation settings", () => {
      assert.strictEqual(
        validate({
          "vsCRT.doubleClickTerminalLocation": "editor",
          "vsCRT.buttonClickTerminalLocation": "panel",
        }),
        true,
      );
    });

    it("accepts a node with saved commands", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                commands: [
                  { name: "tail", script: "tail -f /var/log/app.log" },
                  {
                    name: "restart",
                    script: "sudo systemctl restart app",
                    description: "requires sudo",
                  },
                ],
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), true);
    });

    it("accepts a valid launchProfiles array", () => {
      const cfg = {
        launchProfiles: [
          {
            name: "Morning deploy",
            description: "Connect to staging + prod web",
            targets: [
              { nodePath: "Staging/Web" },
              { nodePath: "Prod/Web", terminalLocation: "editor", delayMs: 500 },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), true);
    });

    it("accepts a valid knownFingerprints array", () => {
      const cfg = {
        knownFingerprints: [
          {
            host: "prod-web",
            port: 22,
            sha256: "SHA256:abc123+def456/ghi789=",
            comment: "rotated 2026-03",
          },
        ],
      };
      assert.strictEqual(validate(cfg), true);
    });

    it("rejects knownFingerprints with invalid sha256 format", () => {
      const cfg = {
        knownFingerprints: [
          { host: "prod-web", sha256: "notaprefixed" },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("accepts legacy `port` field (deprecated but still parsed)", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                ...({ port: 2222 } as object),
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), true);
    });
  });

  describe("rejects invalid configurations", () => {
    it("rejects an unknown top-level key", () => {
      assert.strictEqual(validate({ notARealKey: 1 }), false);
    });

    it("rejects commands entries missing name or script", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                commands: [{ name: "tail" }],
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects an unknown field on a node (typo guard)", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                ...({ preferedAuthentication: "password" } as object),
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects a node missing the required `endpoint`", () => {
      const cfg = {
        folder: [{ name: "Prod", nodes: [{ name: "n" } as object] }],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects a node missing the required `name`", () => {
      const cfg = {
        folder: [{ name: "Prod", nodes: [{ endpoint: "u@h" } as object] }],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects bad enum values on preferredAuthentication", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                preferredAuthentication: "passwords", // typo
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects bad enum values on passwordStorage", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                passwordStorage: "passphrasee", // typo
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects bad enum values on passwordDelivery", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                passwordDelivery: "socket",
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects bad enum values on terminalLocation", () => {
      assert.strictEqual(
        validate({ "vsCRT.doubleClickTerminalLocation": "side" }),
        false,
      );
    });

    it("rejects an icon name with disallowed characters", () => {
      const cfg = {
        folder: [
          { name: "Prod", icon: "my_folder!", nodes: [] },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects empty name strings", () => {
      assert.strictEqual(validate({ folder: [{ name: "" }] }), false);
    });

    it("rejects empty endpoint strings", () => {
      const cfg = {
        folder: [{ name: "Prod", nodes: [{ name: "n", endpoint: "" }] }],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects non-string name or endpoint", () => {
      assert.strictEqual(
        validate({ folder: [{ name: 123 as unknown as string }] }),
        false,
      );
    });
  });

  describe("jumpHost field", () => {
    it("accepts typical ProxyJump specs", () => {
      for (const jh of [
        "bastion",
        "user@bastion",
        "user@host:2222",
        "alice@jump1,bob@jump2",
        "jump.example.com",
        "user@[2001:db8::1]",
      ]) {
        const cfg = {
          folder: [
            {
              name: "Prod",
              nodes: [{ name: "n", endpoint: "u@h", jumpHost: jh }],
            },
          ],
        };
        assert.strictEqual(
          validate(cfg),
          true,
          `expected "${jh}" to validate`,
        );
      }
    });

    it("accepts typical portForwards entries", () => {
      for (const fwd of [
        "-L 3306:db.internal:3306",
        "-R 8080:localhost:8080",
        "-D 1080",
        "-L 5432:[2001:db8::1]:5432",
      ]) {
        const cfg = {
          folder: [
            {
              name: "Prod",
              nodes: [{ name: "n", endpoint: "u@h", portForwards: [fwd] }],
            },
          ],
        };
        assert.strictEqual(
          validate(cfg),
          true,
          `expected "${fwd}" to validate`,
        );
      }
    });

    it("rejects portForwards with shell metacharacters", () => {
      for (const bad of ["-L 3306:db;rm:3306", "-D $(whoami)", "nope"]) {
        const cfg = {
          folder: [
            {
              name: "Prod",
              nodes: [{ name: "n", endpoint: "u@h", portForwards: [bad] }],
            },
          ],
        };
        assert.strictEqual(
          validate(cfg),
          false,
          `expected "${bad}" to be rejected`,
        );
      }
    });

    it("accepts env as a map of valid env-var names to strings", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                env: { TERM: "xterm-256color", HTTP_PROXY: "http://proxy:8080" },
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), true);
    });

    it("rejects env entries with invalid variable names", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                env: { "1BAD": "x" },
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("accepts connectTimeoutSeconds and serverAliveIntervalSeconds", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                connectTimeoutSeconds: 30,
                serverAliveIntervalSeconds: 60,
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), true);
    });

    it("rejects connectTimeoutSeconds below 1", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              { name: "n", endpoint: "u@h", connectTimeoutSeconds: 0 },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects connectTimeoutSeconds above 300", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              { name: "n", endpoint: "u@h", connectTimeoutSeconds: 301 },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("accepts identitiesOnly as boolean", () => {
      for (const val of [true, false]) {
        const cfg = {
          folder: [
            {
              name: "Prod",
              nodes: [
                { name: "n", endpoint: "u@h", identitiesOnly: val },
              ],
            },
          ],
        };
        assert.strictEqual(validate(cfg), true, `identitiesOnly: ${val}`);
      }
    });

    it("rejects identitiesOnly as string", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                identitiesOnly: "yes" as unknown as boolean,
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("accepts extraSshDirectives with valid keys", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                extraSshDirectives: {
                  ControlMaster: "auto",
                  ControlPersist: "60",
                },
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), true);
    });

    it("rejects extraSshDirectives with keys containing spaces", () => {
      const cfg = {
        folder: [
          {
            name: "Prod",
            nodes: [
              {
                name: "n",
                endpoint: "u@h",
                extraSshDirectives: { "bad key": "x" },
              },
            ],
          },
        ],
      };
      assert.strictEqual(validate(cfg), false);
    });

    it("rejects shell metacharacters in jumpHost", () => {
      for (const bad of [
        "bastion; rm -rf /",
        "bastion $(whoami)",
        "bastion|cat",
        "bastion`whoami`",
        'bastion"x"',
        "bastion*",
      ]) {
        const cfg = {
          folder: [
            {
              name: "Prod",
              nodes: [{ name: "n", endpoint: "u@h", jumpHost: bad }],
            },
          ],
        };
        assert.strictEqual(
          validate(cfg),
          false,
          `expected "${bad}" to be rejected`,
        );
      }
    });
  });
});
