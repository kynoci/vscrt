import * as assert from "assert";
import { parseDeepLink } from "../commands/uriHandler";

describe("parseDeepLink", () => {
  it("extracts the 'connect' verb and name param", () => {
    const out = parseDeepLink({ path: "/connect", query: "name=Prod%2FWeb" });
    assert.strictEqual(out.verb, "connect");
    assert.strictEqual(out.name, "Prod/Web");
  });

  it("accepts the bare quickConnect verb", () => {
    const out = parseDeepLink({ path: "/quickConnect", query: "" });
    assert.strictEqual(out.verb, "quickConnect");
    assert.strictEqual(out.name, undefined);
  });

  it("accepts the 'open' verb", () => {
    const out = parseDeepLink({ path: "/open", query: "name=Staging" });
    assert.strictEqual(out.verb, "open");
    assert.strictEqual(out.name, "Staging");
  });

  it("accepts the 'validate' verb", () => {
    const out = parseDeepLink({ path: "/validate", query: "" });
    assert.strictEqual(out.verb, "validate");
  });

  it("returns 'unknown' for verbs outside the allow-list", () => {
    const out = parseDeepLink({ path: "/deleteAllData", query: "" });
    assert.strictEqual(out.verb, "unknown");
  });

  it("percent-decodes the name param", () => {
    const out = parseDeepLink({
      path: "/connect",
      query: "name=Prod%20Servers%2FWeb%20%231",
    });
    assert.strictEqual(out.name, "Prod Servers/Web #1");
  });

  it("ignores extra query params (future-proofing)", () => {
    const out = parseDeepLink({
      path: "/connect",
      query: "name=X&extra=ignored&another=one",
    });
    assert.strictEqual(out.verb, "connect");
    assert.strictEqual(out.name, "X");
  });

  it("treats a nested sub-path as the verb segment", () => {
    const out = parseDeepLink({
      path: "/connect/subpath",
      query: "",
    });
    assert.strictEqual(out.verb, "connect");
  });

  it("accepts the `/sftp` verb with a name param", () => {
    const out = parseDeepLink({ path: "/sftp", query: "name=Prod%2FWeb" });
    assert.strictEqual(out.verb, "sftp");
    assert.strictEqual(out.name, "Prod/Web");
  });

  it("accepts the `/sftp` verb with no params (falls through to the picker)", () => {
    const out = parseDeepLink({ path: "/sftp", query: "" });
    assert.strictEqual(out.verb, "sftp");
    assert.strictEqual(out.name, undefined);
  });

  it("accepts the `/sftpBrowser` verb with a name param", () => {
    const out = parseDeepLink({
      path: "/sftpBrowser",
      query: "name=Staging%2FWeb",
    });
    assert.strictEqual(out.verb, "sftpBrowser");
    assert.strictEqual(out.name, "Staging/Web");
  });

  it("accepts the `/sftpBrowser` verb with no name (picker)", () => {
    const out = parseDeepLink({ path: "/sftpBrowser", query: "" });
    assert.strictEqual(out.verb, "sftpBrowser");
    assert.strictEqual(out.name, undefined);
  });
});
