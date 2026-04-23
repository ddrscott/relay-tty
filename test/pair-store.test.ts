import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PairStore } from "../server/pair-store.js";

describe("PairStore.mintCode", () => {
  it("returns a 6-digit numeric string", () => {
    const store = new PairStore();
    const code = store.mintCode("abc12345", "owner-sub");
    assert.match(code, /^\d{6}$/);
  });

  it("produces unique codes on repeated calls", () => {
    const store = new PairStore();
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) codes.add(store.mintCode("abc12345", "owner-sub"));
    assert.ok(codes.size >= 95, `expected near-100 unique codes, got ${codes.size}`);
  });
});

describe("PairStore.redeemCode", () => {
  it("returns sessionId + grantId on valid code", () => {
    const store = new PairStore();
    const code = store.mintCode("abc12345", "owner-sub");
    const result = store.redeemCode(code, "1.2.3.4");
    assert.equal(result.error, undefined);
    assert.equal(result.sessionId, "abc12345");
    assert.match(result.grantId!, /^[a-f0-9]{64}$/);
  });

  it("rejects an unknown code", () => {
    const store = new PairStore();
    const result = store.redeemCode("999999", "1.2.3.4");
    assert.equal(result.error, "invalid");
  });

  it("consumes the code (single-use)", () => {
    const store = new PairStore();
    const code = store.mintCode("abc12345", "owner-sub");
    store.redeemCode(code, "1.2.3.4");
    const second = store.redeemCode(code, "1.2.3.4");
    assert.equal(second.error, "invalid");
  });

  it("rejects expired codes", () => {
    const store = new PairStore();
    const code = store.mintCode("abc12345", "owner-sub");
    const entry = (store as any).codes.get(code);
    entry.expiresAt = Date.now() - 1000;
    const result = store.redeemCode(code, "1.2.3.4");
    assert.equal(result.error, "expired");
  });

  it("rejects after 20 wrong guesses (brute-force guard)", () => {
    const store = new PairStore();
    store.mintCode("abc12345", "owner-sub");
    for (let i = 0; i < 20; i++) store.redeemCode("000000", "1.2.3.4");
    const code = store.mintCode("def67890", "owner-sub");
    const result = store.redeemCode(code, "1.2.3.4");
    assert.equal(result.error, "rate-limited");
  });
});

describe("PairStore.verifyGrant", () => {
  it("returns sessionId for a valid grant and bumps lastSeen", async () => {
    const store = new PairStore();
    const code = store.mintCode("abc12345", "owner");
    const { grantId } = store.redeemCode(code, "1.2.3.4");
    const before = (store as any).grants.get(grantId).lastSeen;
    await new Promise((r) => setTimeout(r, 5));
    const result = store.verifyGrant(grantId!);
    const after = (store as any).grants.get(grantId).lastSeen;
    assert.equal(result.sessionId, "abc12345");
    assert.equal(result.isValid, true);
    assert.ok(after > before, "lastSeen must be bumped");
  });

  it("rejects revoked grants", () => {
    const store = new PairStore();
    const code = store.mintCode("abc12345", "owner");
    const { grantId } = store.redeemCode(code, "1.2.3.4");
    store.revokeGrant(grantId!);
    const result = store.verifyGrant(grantId!);
    assert.equal(result.isValid, false);
  });

  it("rejects grants idle longer than 30 minutes", () => {
    const store = new PairStore();
    const code = store.mintCode("abc12345", "owner");
    const { grantId } = store.redeemCode(code, "1.2.3.4");
    const entry = (store as any).grants.get(grantId);
    entry.lastSeen = Date.now() - 31 * 60 * 1000;
    const result = store.verifyGrant(grantId!);
    assert.equal(result.isValid, false);
  });
});

describe("PairStore.sweep", () => {
  it("removes expired codes", () => {
    const store = new PairStore();
    const code = store.mintCode("abc12345", "owner");
    (store as any).codes.get(code).expiresAt = Date.now() - 1000;
    store.sweep();
    assert.equal((store as any).codes.has(code), false);
  });

  it("removes idle grants", () => {
    const store = new PairStore();
    const code = store.mintCode("abc12345", "owner");
    const { grantId } = store.redeemCode(code, "1.2.3.4");
    (store as any).grants.get(grantId).lastSeen = Date.now() - 31 * 60 * 1000;
    store.sweep();
    assert.equal((store as any).grants.has(grantId), false);
  });
});

describe("PairStore.listGrantsForSession", () => {
  it("returns active grants for a session", () => {
    const store = new PairStore();
    const code1 = store.mintCode("sess-A", "owner");
    const code2 = store.mintCode("sess-A", "owner");
    const code3 = store.mintCode("sess-B", "owner");
    const g1 = store.redeemCode(code1, "1.1.1.1").grantId!;
    const g2 = store.redeemCode(code2, "2.2.2.2").grantId!;
    store.redeemCode(code3, "3.3.3.3");
    const grants = store.listGrantsForSession("sess-A");
    assert.equal(grants.length, 2);
    assert.deepEqual(grants.map((g) => g.grantId).sort(), [g1, g2].sort());
  });
});
