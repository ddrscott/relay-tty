import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Set secret BEFORE importing auth module
process.env.JWT_SECRET = "test-secret-for-grant-cookies";

const { signGrantCookie, verifyGrantCookie } = await import("../server/auth.js");

describe("grant cookie", () => {
  it("signs and verifies a grant id", () => {
    const signed = signGrantCookie("abc123");
    assert.ok(signed!.startsWith("abc123."));
    const verified = verifyGrantCookie(signed!);
    assert.equal(verified, "abc123");
  });

  it("rejects a tampered signature", () => {
    const signed = signGrantCookie("abc123");
    const tampered = signed!.replace(/.$/, "!");
    assert.equal(verifyGrantCookie(tampered), null);
  });

  it("rejects a cookie with swapped grant id", () => {
    const signed = signGrantCookie("abc123");
    const parts = signed!.split(".");
    const swapped = "xyz999." + parts[1];
    assert.equal(verifyGrantCookie(swapped), null);
  });
});
