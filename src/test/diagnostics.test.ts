import * as assert from "assert";
import {
  DiagnosticsReport,
  countConfig,
  formatReport,
} from "../commands/diagnosticsCommand";

function sampleReport(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    version: "0.9.4",
    vscodeVersion: "1.106.2",
    platform: "linux",
    arch: "x64",
    nodeVersion: "v22.1.0",
    counts: {
      folders: 3,
      nodes: 12,
      configBackups: 5,
      knownHostsLines: 7,
    },
    binaries: {
      ssh: "present",
      sshpass: "missing",
      "ssh-keygen": "present",
    },
    vault: {
      initialized: true,
      unlocked: false,
      autoLockMode: "15min",
      hostKeyPolicy: "prompt-on-first",
    },
    connectionLog: {
      enabled: false,
      mode: "off",
    },
    ...overrides,
  };
}

describe("countConfig", () => {
  it("counts folders + nodes including nested subfolders", () => {
    const cfg = {
      folder: [
        {
          name: "A",
          nodes: [
            { name: "a1", endpoint: "u@h" },
            { name: "a2", endpoint: "u@h" },
          ],
          subfolder: [
            {
              name: "A.1",
              nodes: [{ name: "b1", endpoint: "u@h" }],
            },
          ],
        },
        { name: "B", nodes: [] },
      ],
    };
    assert.deepStrictEqual(countConfig(cfg), { folders: 3, nodes: 3 });
  });

  it("returns zeros for undefined / empty config", () => {
    assert.deepStrictEqual(countConfig(undefined), { folders: 0, nodes: 0 });
    assert.deepStrictEqual(countConfig(null), { folders: 0, nodes: 0 });
    assert.deepStrictEqual(countConfig({}), { folders: 0, nodes: 0 });
  });
});

describe("formatReport", () => {
  it("renders a markdown block that includes all the sections", () => {
    const out = formatReport(sampleReport());
    assert.match(out, /# vsCRT diagnostics/);
    assert.match(out, /vsCRT version.*0\.9\.4/);
    assert.match(out, /Platform.*linux/);
    assert.match(out, /## Counts/);
    assert.match(out, /Folders: 3/);
    assert.match(out, /Servers: 12/);
    assert.match(out, /## Binary availability/);
    assert.match(out, /`ssh`: present/);
    assert.match(out, /`sshpass`: missing/);
    assert.match(out, /## Vault state/);
    assert.match(out, /Initialised: true/);
    assert.match(out, /Auto-lock mode: 15min/);
    assert.match(out, /Host-key policy: prompt-on-first/);
    assert.match(out, /## Connection log/);
  });

  it("NEVER leaks endpoint, password, or salt content", () => {
    // Defensive: none of the report's producers put secret-looking data
    // in. This test locks in the invariant — if someone adds a field
    // that includes user input, they need to update this assertion.
    const out = formatReport(sampleReport());
    assert.ok(!/password/i.test(out) || /password/i.test("")); // no password leakage by construction
    assert.ok(!/SHA256:/.test(out));
    assert.ok(!/enc:v\d:/.test(out));
    assert.ok(!/@/.test(out)); // no user@host endpoints
  });
});
