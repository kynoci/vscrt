import * as assert from "assert";
import { detectSshAgent } from "../remote";

describe("detectSshAgent", () => {
  it("reports socketSet=false when SSH_AUTH_SOCK is absent", async () => {
    const status = await detectSshAgent({});
    assert.strictEqual(status.socketSet, false);
    assert.strictEqual(status.keysLoaded, false);
    assert.strictEqual(status.keyCount, 0);
    assert.ok(status.message && /SSH_AUTH_SOCK/i.test(status.message));
  });

  it("reports socketSet=false when SSH_AUTH_SOCK is the empty string", async () => {
    const status = await detectSshAgent({ SSH_AUTH_SOCK: "" });
    assert.strictEqual(status.socketSet, false);
  });

  it("returns a well-formed status shape when the socket is set", async function () {
    // We can't guarantee ssh-add is on the CI runner's PATH or that
    // an agent is reachable, so we just assert shape invariants.
    const status = await detectSshAgent({
      SSH_AUTH_SOCK: "/tmp/nonexistent-socket-for-test",
    });
    assert.strictEqual(status.socketSet, true);
    assert.strictEqual(typeof status.keysLoaded, "boolean");
    assert.strictEqual(typeof status.keyCount, "number");
    // With a bogus socket we expect keysLoaded=false and a message.
    assert.strictEqual(status.keysLoaded, false);
  });
});
