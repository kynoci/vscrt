import * as assert from "assert";
import { classifySshTarget } from "../remote";

describe("classifySshTarget", () => {
  describe("hostnames", () => {
    it("recognises plain hostnames", () => {
      assert.strictEqual(classifySshTarget("prod-web"), "hostname");
      assert.strictEqual(classifySshTarget("prod.web.example.com"), "hostname");
    });

    it("accepts user@hostname form", () => {
      assert.strictEqual(classifySshTarget("deploy@prod-web"), "hostname");
    });

    it("accepts user@hostname:port form", () => {
      assert.strictEqual(
        classifySshTarget("deploy@prod-web:2222"),
        "hostname",
      );
    });
  });

  describe("IPv4", () => {
    it("recognises plain IPv4", () => {
      assert.strictEqual(classifySshTarget("10.0.0.1"), "ip4");
    });

    it("recognises IPv4 with port", () => {
      assert.strictEqual(classifySshTarget("192.168.1.1:2222"), "ip4");
    });

    it("rejects out-of-range octets", () => {
      assert.strictEqual(classifySshTarget("999.0.0.1"), "invalid");
    });
  });

  describe("IPv6", () => {
    it("recognises bracketed IPv6", () => {
      assert.strictEqual(classifySshTarget("[::1]"), "ip6");
      assert.strictEqual(classifySshTarget("[2001:db8::1]"), "ip6");
    });

    it("recognises raw IPv6", () => {
      assert.strictEqual(classifySshTarget("2001:db8::1"), "ip6");
    });

    it("recognises user@[ipv6]", () => {
      assert.strictEqual(classifySshTarget("root@[::1]"), "ip6");
    });
  });

  describe("invalid inputs", () => {
    it("flags empty string", () => {
      assert.strictEqual(classifySshTarget(""), "invalid");
      assert.strictEqual(classifySshTarget("   "), "invalid");
    });

    it("flags user@ with empty host", () => {
      assert.strictEqual(classifySshTarget("user@"), "invalid");
    });

    it("flags hostnames with spaces", () => {
      assert.strictEqual(classifySshTarget("prod web"), "invalid");
    });

    it("flags bracketed non-IPv6 content", () => {
      assert.strictEqual(classifySshTarget("[not-ipv6]"), "invalid");
    });
  });

  describe("common SSH target shapes", () => {
    it("treats localhost as a valid hostname", () => {
      assert.strictEqual(classifySshTarget("localhost"), "hostname");
      assert.strictEqual(classifySshTarget("root@localhost"), "hostname");
    });

    it("treats single-label hostnames as valid", () => {
      assert.strictEqual(classifySshTarget("prod"), "hostname");
    });

    it("handles IPv4 loopback", () => {
      assert.strictEqual(classifySshTarget("127.0.0.1"), "ip4");
    });

    it("handles IPv6 loopback", () => {
      assert.strictEqual(classifySshTarget("::1"), "ip6");
      assert.strictEqual(classifySshTarget("[::1]"), "ip6");
    });

    it("accepts hostnames with digits and hyphens", () => {
      assert.strictEqual(classifySshTarget("host-1"), "hostname");
      assert.strictEqual(classifySshTarget("db-prod-01.example.com"), "hostname");
    });

    it("rejects hostnames starting or ending with hyphen", () => {
      assert.strictEqual(classifySshTarget("-foo"), "invalid");
      assert.strictEqual(classifySshTarget("foo-"), "invalid");
    });
  });
});
