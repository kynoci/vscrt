import * as assert from "assert";
import { LogSink, formatLine, log, setLogSink } from "../log";

const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(INFO|WARN|ERROR|DEBUG)\] /;

describe("log module", () => {
  afterEach(() => {
    setLogSink(undefined);
  });

  describe("formatLine", () => {
    it("prefixes an ISO 8601 timestamp and level tag", () => {
      const line = formatLine("INFO", "hello", []);
      assert.match(line, ISO);
      assert.ok(line.endsWith("hello"));
    });

    it("appends string args separated by spaces", () => {
      const line = formatLine("WARN", "context", ["alpha", "beta"]);
      assert.ok(line.endsWith("context alpha beta"), `got: ${line}`);
    });

    it("JSON-stringifies non-string, non-Error args", () => {
      const line = formatLine("DEBUG", "obj:", [{ k: 1 }, [1, 2]]);
      assert.ok(line.endsWith(`obj: {"k":1} [1,2]`), `got: ${line}`);
    });

    it("formats Error via stack (or name+message fallback)", () => {
      const err = new Error("boom");
      const line = formatLine("ERROR", "caught", [err]);
      assert.ok(line.includes("boom"), "includes message");
      // Node preserves stack on Error instances.
      assert.ok(line.includes("Error"), "includes error name");
    });

    it("handles cyclic objects without throwing", () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      const line = formatLine("DEBUG", "cyclic", [obj]);
      assert.ok(typeof line === "string");
      assert.match(line, ISO);
    });
  });

  describe("routing", () => {
    it("routes log.info/warn/error to the configured sink", () => {
      const lines: string[] = [];
      const sink: LogSink = { appendLine: (s) => lines.push(s) };
      setLogSink(sink);

      log.info("i");
      log.warn("w");
      log.error("e");
      log.debug("d");

      assert.strictEqual(lines.length, 4);
      assert.match(lines[0], /\[INFO\] i$/);
      assert.match(lines[1], /\[WARN\] w$/);
      assert.match(lines[2], /\[ERROR\] e$/);
      assert.match(lines[3], /\[DEBUG\] d$/);
    });

    it("survives setLogSink(undefined) (falls through to console)", () => {
      setLogSink(undefined);
      // Should not throw; console output is acceptable.
      log.info("fallback");
      log.error("fallback-err");
    });

    it("respects a subsequent setLogSink swap", () => {
      const a: string[] = [];
      const b: string[] = [];
      setLogSink({ appendLine: (s) => a.push(s) });
      log.info("to-a");
      setLogSink({ appendLine: (s) => b.push(s) });
      log.info("to-b");

      assert.strictEqual(a.length, 1);
      assert.strictEqual(b.length, 1);
      assert.ok(a[0].endsWith("to-a"));
      assert.ok(b[0].endsWith("to-b"));
    });
  });

  describe("log.show", () => {
    it("calls sink.show if defined", () => {
      let calls = 0;
      setLogSink({
        appendLine: () => undefined,
        show: () => {
          calls += 1;
        },
      });
      log.show();
      log.show(true);
      assert.strictEqual(calls, 2);
    });

    it("is a no-op when sink lacks show", () => {
      setLogSink({ appendLine: () => undefined });
      // Should not throw.
      log.show();
    });

    it("is a no-op when no sink is installed", () => {
      setLogSink(undefined);
      log.show();
    });
  });
});
