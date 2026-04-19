import * as assert from "assert";
import { classifyInstallError } from "../remote";

describe("classifyInstallError", () => {
  it("handles ENOENT with a PATH hint", () => {
    assert.match(classifyInstallError({ code: "ENOENT" }), /not on PATH/);
  });

  it("reports a timeout when killed", () => {
    assert.match(
      classifyInstallError({ killed: true, stderr: "" }),
      /Timed out/,
    );
  });

  it("annotates auth failures", () => {
    const msg = classifyInstallError({
      code: 255,
      stderr: "Permission denied (password).\n",
    });
    assert.match(msg, /Authentication failed/);
    assert.match(msg, /Permission denied/);
  });

  it("returns the first stderr line for unrecognised errors", () => {
    const msg = classifyInstallError({
      code: 1,
      stderr: "some other failure\nsecond line\n",
    });
    assert.strictEqual(msg, "some other failure");
  });

  it("falls back to the exit code when stderr is blank", () => {
    const msg = classifyInstallError({ code: 3, stderr: "" });
    assert.match(msg, /exited 3/);
  });

  it("handles a null error without throwing", () => {
    const msg = classifyInstallError(undefined);
    assert.ok(typeof msg === "string" && msg.length > 0);
  });
});
