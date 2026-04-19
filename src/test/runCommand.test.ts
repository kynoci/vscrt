import * as assert from "assert";
import {
  buildCommandPicks,
  findTerminalForNode,
} from "../commands/runCommandCommand";
import { CRTNodeCommand } from "../config/vscrtConfig";

describe("buildCommandPicks", () => {
  const sample: CRTNodeCommand[] = [
    { name: "Tail logs", script: "tail -f /var/log/app.log" },
    {
      name: "Restart service",
      script: "sudo systemctl restart app",
      description: "requires sudo",
    },
    { name: "  ", script: "echo blank name" },
    { name: "blank script", script: "   " },
    { name: "Multi-line", script: "cd /opt/app\n./run.sh" },
  ];

  it("filters entries whose name or script is blank", () => {
    const picks = buildCommandPicks(sample);
    const labels = picks.map((p) => p.label);
    assert.ok(labels.includes("Tail logs"));
    assert.ok(labels.includes("Restart service"));
    assert.ok(labels.includes("Multi-line"));
    assert.ok(!labels.some((l) => l.trim() === ""));
    assert.ok(!labels.includes("blank script"));
  });

  it("sets the detail to the first line of the script", () => {
    const picks = buildCommandPicks(sample);
    const multi = picks.find((p) => p.label === "Multi-line");
    assert.ok(multi);
    assert.strictEqual(multi.detail, "cd /opt/app");
  });

  it("surfaces description as the pick description", () => {
    const picks = buildCommandPicks(sample);
    const restart = picks.find((p) => p.label === "Restart service");
    assert.ok(restart);
    assert.strictEqual(restart.description, "requires sudo");
  });

  it("returns [] for an empty or all-blank list", () => {
    assert.deepStrictEqual(buildCommandPicks([]), []);
    assert.deepStrictEqual(
      buildCommandPicks([{ name: "", script: "" }]),
      [],
    );
  });

  it("preserves the original command object on the pick", () => {
    const picks = buildCommandPicks(sample);
    const first = picks[0];
    assert.strictEqual(first.command, sample[0]);
  });
});

describe("findTerminalForNode", () => {
  function fakeTerminal(name: string): { name: string } {
    return { name };
  }

  it("matches on the 'vsCRT: <name>' naming convention", () => {
    const terminals = [
      fakeTerminal("some unrelated terminal"),
      fakeTerminal("vsCRT: Prod Web"),
      fakeTerminal("vsCRT: Staging DB"),
    ];
    const out = findTerminalForNode(
      "Prod Web",
      terminals as unknown as readonly import("vscode").Terminal[],
    );
    assert.ok(out);
    assert.strictEqual(out.name, "vsCRT: Prod Web");
  });

  it("returns undefined when no matching terminal is open", () => {
    const terminals = [fakeTerminal("vsCRT: Different Server")];
    const out = findTerminalForNode(
      "Prod Web",
      terminals as unknown as readonly import("vscode").Terminal[],
    );
    assert.strictEqual(out, undefined);
  });

  it("is exact on node name (doesn't match a prefix)", () => {
    // "Prod Web 2" should not match when looking for "Prod Web"
    const terminals = [fakeTerminal("vsCRT: Prod Web 2")];
    const out = findTerminalForNode(
      "Prod Web",
      terminals as unknown as readonly import("vscode").Terminal[],
    );
    assert.strictEqual(out, undefined);
  });
});
