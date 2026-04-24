import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createApiRouter } from "../server/api.js";
import { PairStore } from "../server/pair-store.js";
import { SessionStore } from "../server/session-store.js";

// CRITICAL: set secret BEFORE importing auth module — JWT_SECRET is a module-level
// constant captured at load time. Any import that arrives later will see the empty string.
process.env.JWT_SECRET = "integration-test-secret";

const authModule = await import("../server/auth.js");
const { authMiddleware, setPairStore } = authModule;

// Minimal PtyManager stub — no real process spawning needed for these tests.
const ptyManagerStub = {
  spawn: async () => { throw new Error("not used"); },
  ensureMonitor: async () => null,
  kill: () => {},
  cleanup: () => {},
  fetchSparkline: async () => [],
  getSocketPath: () => "",
  on: () => {},
  discover: async () => {},
} as any;

/**
 * Build a minimal Express app that mounts the pair API under /api and forces
 * every request to appear as coming from a non-localhost IP (1.2.3.4) so the
 * auth middleware actually enforces auth instead of taking the localhost bypass.
 *
 * NOTE: setPairStore is a module-level singleton on the auth module. Calling it
 * here affects global state for the duration of the test, which is fine for a
 * single isolated test block.
 */
function makeApp(sessionStore: SessionStore, pairStore: PairStore): express.Express {
  setPairStore(pairStore);
  const app = express();
  app.use(express.json());
  // Force a non-localhost IP so the auth middleware doesn't take the bypass path.
  app.use((req, _res, next) => {
    Object.defineProperty(req, "ip", { value: "1.2.3.4", configurable: true });
    next();
  });
  app.use(authMiddleware);
  app.use("/api", createApiRouter(sessionStore, ptyManagerStub, { pairStore }));
  return app;
}

/** Issue a single request against an ephemeral port, then close the server. */
async function hit(
  app: express.Express,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any; setCookie?: string }> {
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* non-JSON body is fine */ }
    return {
      status: res.status,
      body,
      setCookie: res.headers.get("set-cookie") ?? undefined,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("pair redemption integration", () => {
  it("mints, redeems, scopes, denies-other, denies-owner-routes, and logs out", async () => {
    const sessionStore = new SessionStore();

    // Seed two sessions via SessionStore.create() which puts them in the
    // pending map. The GET /api/sessions/:id route calls ensureMonitor (stub
    // returns null → 404), but auth is the gating check here (401 means auth
    // failed; 404 means auth passed but session logic found nothing).
    const sessionId = "abc12345";
    const otherSessionId = "def67890";

    const now = Date.now();
    const baseSession = {
      command: "bash",
      args: [],
      cwd: "/tmp",
      createdAt: now,
      lastActivity: now,
      status: "running" as const,
      cols: 80,
      rows: 24,
    };
    sessionStore.create({ id: sessionId, ...baseSession });
    sessionStore.create({ id: otherSessionId, ...baseSession });

    const pairStore = new PairStore();
    const app = makeApp(sessionStore, pairStore);

    // Mint a code directly through the store — this bypasses the owner-auth
    // gate on POST /api/sessions/:id/pair, which is what we want here.
    const code = pairStore.mintCode(sessionId, "owner");

    // ── Phase 1: Redeem the code (public route, no auth cookie required) ───
    const redeem = await hit(app, "/api/pair/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(redeem.status, 200, `redeem failed: ${JSON.stringify(redeem.body)}`);
    assert.equal(redeem.body.sessionUrl, `/sessions/${sessionId}`);
    assert.ok(
      redeem.setCookie?.includes("relay_grant="),
      `redeem should set relay_grant cookie, got: ${redeem.setCookie}`
    );

    // Extract the cookie value for subsequent requests (just the name=value part).
    const cookie = redeem.setCookie!.split(";")[0]; // `relay_grant=<signed>`

    // ── Phase 2: Grant cookie passes auth for the bound session ─────────────
    // ensureMonitor returns null → 404, but 404 means we got PAST auth — not 401.
    const scoped = await hit(app, `/api/sessions/${sessionId}`, {
      headers: { cookie },
    });
    assert.notEqual(scoped.status, 401, `grant cookie should pass auth for bound session, got ${scoped.status}`);

    // ── Phase 3: Grant cookie is rejected for an unrelated session ──────────
    const other = await hit(app, `/api/sessions/${otherSessionId}`, {
      headers: { cookie },
    });
    assert.equal(other.status, 401, `grant cookie must not authorize other sessions, got ${other.status}`);

    // ── Phase 4: Grant cookie is rejected on owner-only route ───────────────
    // POST /api/sessions/:id/pair checks isOwnerRequest() → 403 for guests.
    const ownerRoute = await hit(app, `/api/sessions/${sessionId}/pair`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(ownerRoute.status, 403, `grant cookie must 403 on owner-only POST /pair, got ${ownerRoute.status}`);

    // ── Phase 5: Logout clears grant and expires cookie ─────────────────────
    const logout = await hit(app, "/api/pair/logout", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logout.status, 200, `logout failed: ${JSON.stringify(logout.body)}`);
    assert.ok(
      logout.setCookie?.includes("Max-Age=0"),
      `logout must clear the cookie, got: ${logout.setCookie}`
    );

    // ── Phase 6: Revoked cookie is now rejected ──────────────────────────────
    const after = await hit(app, `/api/sessions/${sessionId}`, {
      headers: { cookie },
    });
    assert.equal(after.status, 401, `revoked grant cookie must no longer authorize, got ${after.status}`);
  });
});
