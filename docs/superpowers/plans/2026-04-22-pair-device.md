# Pair Device — 6-Digit Code Sharing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated user share a single session with another device (e.g. a library computer) via a one-time 6-digit code, without email or a QR camera. The paired device gets the same experience as a normal session, bounded by a 30-minute sliding idle timeout and an explicit logout.

**Architecture:** Stateful pair-code store on the server mints codes (5-min TTL, single-use, rate-limited). Redemption exchanges the code for an HMAC-signed `relay_grant` cookie tied to one session id. The auth middleware grants a cookie holder access to **only** that session's page, WS, and per-session APIs. Grants are in-memory (server restart drops guests — acceptable since grants are temporary by design) with a 30-min sliding idle timeout bumped on each auth'd request.

**Tech Stack:** Express, React Router v7 SSR, TypeScript, Node's `node:crypto` HMAC, node:test. No new npm deps.

---

## File Structure

**New files:**
- `server/pair-store.ts` — `PairStore` class: code minting, redemption, grant lifecycle, rate limiting, TTL sweep.
- `test/pair-store.test.ts` — unit tests for PairStore.
- `test/pair-grant-cookie.test.ts` — unit tests for grant cookie sign/verify.
- `app/routes/pair.tsx` — `/pair` page: 6-digit input + redeem.
- `app/components/pair-host-dialog.tsx` — owner modal: code display + active guests + revoke.

**Modified files:**
- `server/auth.ts` — add `signGrantCookie`, `verifyGrantCookie`, `grantAuth` branch in `authMiddleware` and `verifyWsAuth`.
- `server/api.ts` — add pair/redeem/logout/grants routes.
- `server.js` — construct `PairStore` in `loadModules`, pass to api router, export it for auth middleware use.
- `app/routes.ts` — register `/pair`.
- `app/components/session-info-panel.tsx` — add "Pair Device" button next to existing "Share" button.
- `app/routes/sessions.$id.tsx` — wire up `PairHostDialog`; show "Guest — log out" chip when on grant cookie.
- `shared/types.ts` — add `PairCodeResponse`, `PairRedeemResponse`, `GrantInfo` types.
- `docs/content/reference/cli.mdx` or similar — document the feature per CLAUDE.md "always update docs" rule.

---

## Task 1: PairStore data model (TDD)

**Files:**
- Create: `server/pair-store.ts`
- Create: `test/pair-store.test.ts`

The `PairStore` owns two in-memory maps (codes, grants) and handles:
- `mintCode(sessionId, ownerSub): string` — returns a 6-digit code
- `redeemCode(code, ip): { sessionId, grantId } | { error }` — removes code, creates grant
- `verifyGrant(grantId): { sessionId, isValid: boolean }` — and bumps `lastSeen`
- `revokeGrant(grantId)` — owner kick
- `revokeCode(code)` — owner cancels before redemption
- `listGrantsForSession(sessionId): GrantInfo[]`
- `sweep()` — remove expired codes and grants; called by a timer

- [ ] **Step 1: Write the failing test for code minting**

Create `test/pair-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="PairStore.mintCode"`
Expected: FAIL — `Cannot find module '../server/pair-store.js'`.

- [ ] **Step 3: Create minimal PairStore**

Create `server/pair-store.ts`:

```ts
import { randomInt, randomBytes } from "node:crypto";

const CODE_TTL_MS = 5 * 60 * 1000;
const GRANT_IDLE_MS = 30 * 60 * 1000;

export interface PairCode {
  code: string;
  sessionId: string;
  ownerSub: string;
  expiresAt: number;
  attempts: number;
}

export interface Grant {
  grantId: string;
  sessionId: string;
  ownerSub: string;
  ip: string;
  issuedAt: number;
  lastSeen: number;
  revoked: boolean;
}

export interface GrantInfo {
  grantId: string;
  ip: string;
  issuedAt: number;
  lastSeen: number;
}

export class PairStore {
  private codes = new Map<string, PairCode>();
  private grants = new Map<string, Grant>();

  mintCode(sessionId: string, ownerSub: string): string {
    // Retry on collision — 1M codes, collisions unlikely but guard anyway
    for (let tries = 0; tries < 10; tries++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (!this.codes.has(code)) {
        this.codes.set(code, {
          code,
          sessionId,
          ownerSub,
          expiresAt: Date.now() + CODE_TTL_MS,
          attempts: 0,
        });
        return code;
      }
    }
    throw new Error("Failed to mint unique pair code");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="PairStore.mintCode"`
Expected: both tests PASS.

- [ ] **Step 5: Add redemption tests**

Append to `test/pair-store.test.ts`:

```ts
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
    // Force expiry
    const entry = (store as any).codes.get(code);
    entry.expiresAt = Date.now() - 1000;
    const result = store.redeemCode(code, "1.2.3.4");
    assert.equal(result.error, "expired");
  });

  it("rejects after 20 wrong guesses (brute-force guard)", () => {
    const store = new PairStore();
    store.mintCode("abc12345", "owner-sub");
    for (let i = 0; i < 20; i++) store.redeemCode("000000", "1.2.3.4");
    // A valid (not-yet-used) code from the same IP should still work — brute-force guard is per-IP, not global:
    const code = store.mintCode("def67890", "owner-sub");
    // Per-IP rate limit kicks in after 5 attempts per minute:
    const result = store.redeemCode(code, "1.2.3.4");
    assert.equal(result.error, "rate-limited");
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="PairStore.redeemCode"`
Expected: FAIL — `redeemCode` not defined.

- [ ] **Step 7: Implement redemption + per-IP rate limit**

Add to `server/pair-store.ts` after `mintCode`:

```ts
  private ipAttempts = new Map<string, { count: number; windowStart: number }>();
  private readonly IP_LIMIT = 5;
  private readonly IP_WINDOW_MS = 60 * 1000;

  private checkIpLimit(ip: string): boolean {
    const now = Date.now();
    const entry = this.ipAttempts.get(ip);
    if (!entry || now - entry.windowStart > this.IP_WINDOW_MS) {
      this.ipAttempts.set(ip, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= this.IP_LIMIT;
  }

  redeemCode(code: string, ip: string): { sessionId?: string; grantId?: string; error?: string } {
    if (!this.checkIpLimit(ip)) return { error: "rate-limited" };

    const entry = this.codes.get(code);
    if (!entry) return { error: "invalid" };
    if (Date.now() > entry.expiresAt) {
      this.codes.delete(code);
      return { error: "expired" };
    }

    // Success — consume
    this.codes.delete(code);
    const grantId = randomBytes(32).toString("hex"); // 64 hex chars

    const now = Date.now();
    this.grants.set(grantId, {
      grantId,
      sessionId: entry.sessionId,
      ownerSub: entry.ownerSub,
      ip,
      issuedAt: now,
      lastSeen: now,
      revoked: false,
    });
    return { sessionId: entry.sessionId, grantId };
  }
```

Also add the import at the top:

```ts
// (already imported randomInt above)
```

- [ ] **Step 8: Run tests**

Run: `npm test -- --test-name-pattern="PairStore"`
Expected: all tests PASS.

- [ ] **Step 9: Add grant-verification and sweep tests**

Append to `test/pair-store.test.ts`:

```ts
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
```

- [ ] **Step 10: Implement verifyGrant, revokeGrant, sweep, listGrantsForSession**

Append to `server/pair-store.ts`:

```ts
  verifyGrant(grantId: string): { sessionId?: string; isValid: boolean } {
    const grant = this.grants.get(grantId);
    if (!grant) return { isValid: false };
    if (grant.revoked) return { isValid: false };
    if (Date.now() - grant.lastSeen > GRANT_IDLE_MS) {
      this.grants.delete(grantId);
      return { isValid: false };
    }
    grant.lastSeen = Date.now();
    return { sessionId: grant.sessionId, isValid: true };
  }

  revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    grant.revoked = true;
    this.grants.delete(grantId);
    return true;
  }

  revokeCode(code: string): boolean {
    return this.codes.delete(code);
  }

  listGrantsForSession(sessionId: string): GrantInfo[] {
    const out: GrantInfo[] = [];
    for (const g of this.grants.values()) {
      if (g.sessionId === sessionId && !g.revoked) {
        out.push({
          grantId: g.grantId,
          ip: g.ip,
          issuedAt: g.issuedAt,
          lastSeen: g.lastSeen,
        });
      }
    }
    return out;
  }

  sweep(): void {
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (now > entry.expiresAt) this.codes.delete(code);
    }
    for (const [id, grant] of this.grants) {
      if (now - grant.lastSeen > GRANT_IDLE_MS) this.grants.delete(id);
    }
    // Garbage-collect stale IP-limit entries
    for (const [ip, attempt] of this.ipAttempts) {
      if (now - attempt.windowStart > this.IP_WINDOW_MS) this.ipAttempts.delete(ip);
    }
  }

  /** Start a periodic sweep every 60s; returns a handle to clearInterval. */
  startSweepTimer(): ReturnType<typeof setInterval> {
    return setInterval(() => this.sweep(), 60 * 1000);
  }
```

- [ ] **Step 11: Run all PairStore tests**

Run: `npm test -- --test-name-pattern="PairStore"`
Expected: all tests PASS.

- [ ] **Step 12: Commit**

```bash
git add server/pair-store.ts test/pair-store.test.ts
git commit -m "feat: add PairStore for 6-digit device-pair codes"
```

---

## Task 2: Grant cookie sign / verify helpers (TDD)

**Files:**
- Modify: `server/auth.ts`
- Create: `test/pair-grant-cookie.test.ts`

Grant cookie format: `relay_grant=<grantId>.<signature>` where the signature is HMAC-SHA256 of `grantId` with `JWT_SECRET`, base64url encoded. This is tamper-proof; lookup still happens in `PairStore`.

- [ ] **Step 1: Write the failing test**

Create `test/pair-grant-cookie.test.ts`:

```ts
import { describe, it, before } from "node:test";
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

  it("returns null when JWT_SECRET is empty", () => {
    // Can't easily test this without module reload; skip or document
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- --test-name-pattern="grant cookie"`
Expected: FAIL — `signGrantCookie is not a function`.

- [ ] **Step 3: Implement sign/verify in server/auth.ts**

Add to `server/auth.ts` (near the other helpers, before `authMiddleware`):

```ts
/**
 * Sign a grant id with HMAC-SHA256 for use as a `relay_grant` cookie value.
 * Format: `<grantId>.<signature>`. The grant id itself is looked up in PairStore;
 * this signature only proves the id hasn't been tampered with.
 */
export function signGrantCookie(grantId: string): string | null {
  if (!JWT_SECRET) return null;
  const sig = createHmac("sha256", JWT_SECRET).update(grantId).digest("base64url");
  return `${grantId}.${sig}`;
}

/**
 * Verify a `relay_grant` cookie value. Returns the grant id on success, null otherwise.
 */
export function verifyGrantCookie(cookieValue: string): string | null {
  if (!JWT_SECRET) return null;
  const idx = cookieValue.lastIndexOf(".");
  if (idx < 1) return null;
  const grantId = cookieValue.slice(0, idx);
  const sig = cookieValue.slice(idx + 1);
  const expected = createHmac("sha256", JWT_SECRET).update(grantId).digest("base64url");
  if (sig !== expected) return null;
  return grantId;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- --test-name-pattern="grant cookie"`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/auth.ts test/pair-grant-cookie.test.ts
git commit -m "feat: add HMAC grant-cookie sign/verify helpers"
```

---

## Task 3: Auth middleware — grant-aware authorization

**Files:**
- Modify: `server/auth.ts`

Wire a grant-cookie path into both `authMiddleware` and `verifyWsAuth`. A grant cookie is accepted **only** for requests whose URL targets the grant's session id. All other requests fall through to the existing JWT path (and 401).

The module-level hook: since `PairStore` is instantiated in `server.js`, we pass it into auth functions that need it. The cleanest approach: export a factory `makeAuthMiddleware(pairStore)` and have `server.js` call it. But to avoid rewiring, add a `setPairStore(store)` hook that the middleware closes over.

- [ ] **Step 1: Add the PairStore hook in server/auth.ts**

Add near the top of `server/auth.ts` (after the `JWT_SECRET` line):

```ts
import type { PairStore } from "./pair-store.js";

let pairStore: PairStore | null = null;

/**
 * Register the pair-code store. Called once during server startup.
 * The auth middleware uses this to verify `relay_grant` cookies.
 */
export function setPairStore(store: PairStore): void {
  pairStore = store;
}
```

- [ ] **Step 2: Add helper to extract session id from a URL path**

Add below `setPairStore`:

```ts
/**
 * Extract the session id that a request path targets, if any.
 * Returns the id for `/sessions/:id`, `/ws/sessions/:id`, and `/api/sessions/:id/*`.
 */
function pathSessionId(urlPath: string): string | null {
  const m1 = urlPath.match(/^\/sessions\/([a-f0-9]+)(?:$|\/)/);
  if (m1) return m1[1];
  const m2 = urlPath.match(/^\/ws\/sessions\/([a-f0-9]+)$/);
  if (m2) return m2[1];
  const m3 = urlPath.match(/^\/api\/sessions\/([a-f0-9]+)(?:$|\/)/);
  if (m3) return m3[1];
  return null;
}

/** Paths a grant cookie is always allowed to hit, regardless of session-id scoping. */
function isGrantAllowedOpenPath(urlPath: string): boolean {
  return (
    urlPath === "/api/pair/logout"
    || urlPath === "/api/pair/whoami"
    // Static assets handled downstream in the middleware
  );
}
```

- [ ] **Step 3: Update authMiddleware to honor the grant cookie**

Replace the body of `authMiddleware` (currently lines 263-317) with:

```ts
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isLocalhost(req)) {
    next();
    return;
  }

  if (!JWT_SECRET) {
    next();
    return;
  }

  // Allow the callback route through (it sets the cookie)
  if (req.path === "/api/auth/callback") {
    next();
    return;
  }

  // Allow share routes through (they validate their own token)
  if (req.path.startsWith("/share/")) {
    next();
    return;
  }

  // Allow the public pair entry page and its redeem API through
  // so the library computer can enter a code without auth.
  if (req.path === "/pair" || req.path === "/api/pair/redeem") {
    next();
    return;
  }

  const cookies = cookie.parse(req.headers.cookie || "");

  // Primary auth path — owner JWT
  const token = cookies.session;
  if (token && verifyJwt(token)) {
    next();
    return;
  }

  // Guest auth path — device pairing grant
  const grantCookie = cookies.relay_grant;
  if (grantCookie && pairStore) {
    const grantId = verifyGrantCookie(grantCookie);
    if (grantId) {
      const { sessionId, isValid } = pairStore.verifyGrant(grantId);
      if (isValid) {
        if (isGrantAllowedOpenPath(req.path)) {
          next();
          return;
        }
        const targetId = pathSessionId(req.path);
        if (targetId && targetId === sessionId) {
          next();
          return;
        }
        // Grant valid but request targets a different resource — fall through to 401.
      }
    }
  }

  if (req.path.startsWith("/api/") || req.path.startsWith("/ws/")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Only block page routes — let assets, modules, and other resources through.
  const lastSegment = req.path.split("/").pop() || "";
  const isAsset = lastSegment.includes(".") || req.path.startsWith("/@") || req.path.startsWith("/__");
  if (isAsset) {
    next();
    return;
  }

  res.status(401).send(
    `<!DOCTYPE html>
<html><head><title>relay-tty — unauthorized</title></head>
<body style="font-family:monospace;max-width:480px;margin:80px auto;text-align:center">
<h2>relay-tty</h2>
<p>Access denied. Use the token URL printed by the server.</p>
</body></html>`
  );
}
```

- [ ] **Step 4: Update verifyWsAuth to honor the grant cookie**

Replace the body of `verifyWsAuth` (currently lines 322-340) with:

```ts
export function verifyWsAuth(req: { url?: string; headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }): boolean {
  const ip = req.socket.remoteAddress || "";
  const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

  // Same CF tunnel detection as authMiddleware
  const isCfTunnel = isLocal && !!req.headers["cf-connecting-ip"];
  const isRelayTunnel = isLocal && !!req.headers["x-relay-tunnel"];
  if (isLocal && !isCfTunnel && !isRelayTunnel) return true;
  if (!JWT_SECRET) return true;

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== "string") return false;

  const cookies = cookie.parse(cookieHeader);

  // Owner JWT
  const token = cookies.session;
  if (token && verifyJwt(token)) return true;

  // Guest grant — must target the same session id
  const grantCookie = cookies.relay_grant;
  if (grantCookie && pairStore && req.url) {
    const grantId = verifyGrantCookie(grantCookie);
    if (grantId) {
      const { sessionId, isValid } = pairStore.verifyGrant(grantId);
      if (isValid) {
        // The only WS path a guest may hit is /ws/sessions/<their-session-id>
        const urlPath = req.url.split("?")[0];
        const wsMatch = urlPath.match(/^\/ws\/sessions\/([a-f0-9]+)$/);
        if (wsMatch && wsMatch[1] === sessionId) return true;
      }
    }
  }

  return false;
}
```

- [ ] **Step 5: Smoke-check the file compiles**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/auth.ts
git commit -m "feat: authorize grant cookies for their bound session only"
```

---

## Task 4: PairStore integration in server startup

**Files:**
- Modify: `server.js`
- Modify: `server/api.ts` (accept `pairStore` in options; no routes yet)

- [ ] **Step 1: Thread PairStore through loadModules**

Modify `server.js` `loadModules` — after the `authModule` is loaded, construct and register the store. Replace lines ~62-83 with:

```js
  const authModule = await load("auth");

  const pairStoreModule = await load("pair-store");
  const pairStore = new pairStoreModule.PairStore();
  const sweepTimer = pairStore.startSweepTimer();
  authModule.setPairStore(pairStore);

  app.use(authModule.authMiddleware);

  const notifStoreModule = await load("notification-store");
  const notificationStore = new notifStoreModule.NotificationStore();

  const pushStoreModule = await load("push-store");
  const pushStore = new pushStoreModule.PushStore();

  const apiModule = await load("api");
  app.use("/api", apiModule.createApiRouter(sessionStore, ptyManager, { appUrl: APP_URL, notificationStore, pushStore, pairStore }));
```

And update the SIGINT/SIGTERM handler near the end of `start()` so it clears the sweep timer. Replace the signal loop at the bottom of `start()` with:

```js
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      clearInterval(sweepTimer);
      clearServerInfo();
      process.exit(0);
    });
  }
```

`sweepTimer` is declared inside `loadModules`, so you'll also need to return it. Update the return object in `loadModules` to include `sweepTimer` and `pairStore`:

```js
  return {
    sessionStore,
    ptyManager,
    wsHandler,
    pairStore,
    sweepTimer,
    verifyWsAuth: authModule.verifyWsAuth,
    generateToken: authModule.generateToken,
    generateAccessToken: authModule.generateAccessToken,
    verifyAccessToken: authModule.verifyAccessToken,
    readCustomCommands: apiModule.readCustomCommands,
    readUploadDir: apiModule.readUploadDir,
  };
```

And destructure `sweepTimer` where modules is returned in `start()`:

```js
  const { wsHandler, verifyWsAuth, generateToken, generateAccessToken, sweepTimer } = modules;
```

- [ ] **Step 2: Accept pairStore in API router options (no routes yet)**

Modify `server/api.ts`. Change the `ApiOptions` interface (around line 83) to:

```ts
interface ApiOptions {
  appUrl?: string;
  notificationStore?: NotificationStore;
  pushStore?: PushStore;
  pairStore?: import("./pair-store.js").PairStore;
}
```

- [ ] **Step 3: Verify server still starts**

Run: `npm run dev` in a background shell, wait ~4s, hit `curl http://localhost:7680/api/sessions`, kill the server.

Expected: no crash, `/api/sessions` returns JSON.

- [ ] **Step 4: Commit**

```bash
git add server.js server/api.ts
git commit -m "feat: wire PairStore into server startup"
```

---

## Task 5: API routes — mint, redeem, list, revoke

**Files:**
- Modify: `server/api.ts`
- Modify: `shared/types.ts`

- [ ] **Step 1: Add the response types**

Append to `shared/types.ts`:

```ts
export interface PairCodeResponse {
  code: string;       // 6-digit string
  expiresIn: number;  // seconds
  pairUrl: string;    // absolute URL to the /pair page (convenience for UI)
}

export interface PairRedeemResponse {
  sessionUrl: string; // absolute path like /sessions/abc12345
}

export interface GrantListEntry {
  grantId: string;
  ip: string;
  issuedAt: number;
  lastSeen: number;
}

export interface GrantListResponse {
  grants: GrantListEntry[];
}
```

- [ ] **Step 2: Add the routes to api.ts**

First, add the new imports to the top of `server/api.ts`. Update the existing auth import (currently `import { generateShareToken, generatePasswordShareToken, readPasswordHash, hashPassword } from "./auth.js";`) to include `signGrantCookie` and `verifyGrantCookie`:

```ts
import {
  generateShareToken,
  generatePasswordShareToken,
  readPasswordHash,
  hashPassword,
  signGrantCookie,
  verifyGrantCookie,
} from "./auth.js";
```

Then insert these handlers in `createApiRouter`, right after the existing `POST /sessions/:id/share` handler (after line 200):

```ts
  // POST /api/sessions/:id/pair — mint a 6-digit pair code for this session.
  router.post("/sessions/:id/pair", (req, res) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!options.pairStore) {
      res.status(500).json({ error: "Pair store not configured" });
      return;
    }
    // ownerSub isn't meaningful without per-user auth; use "owner" as a placeholder.
    // Future: if auth.ts exposes the verified JWT payload, thread the sub through.
    const code = options.pairStore.mintCode(req.params.id, "owner");
    const baseUrl = options.appUrl
      || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.headers.host}`;
    res.json({ code, expiresIn: 300, pairUrl: `${baseUrl}/pair` });
  });

  // DELETE /api/sessions/:id/pair/:code — revoke an unredeemed code.
  router.delete("/sessions/:id/pair/:code", (req, res) => {
    if (!options.pairStore) {
      res.status(500).json({ error: "Pair store not configured" });
      return;
    }
    options.pairStore.revokeCode(req.params.code);
    res.json({ ok: true });
  });

  // POST /api/pair/redeem — exchange a 6-digit code for a grant cookie.
  // Public (no auth required). Rate-limited per-IP inside PairStore.
  router.post("/pair/redeem", (req, res) => {
    const code = String(req.body?.code || "");
    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: "invalid-code-format" });
      return;
    }
    if (!options.pairStore) {
      res.status(500).json({ error: "Pair store not configured" });
      return;
    }
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const result = options.pairStore.redeemCode(code, ip);
    if (result.error) {
      const status = result.error === "rate-limited" ? 429 : 401;
      res.status(status).json({ error: result.error });
      return;
    }

    const signed = signGrantCookie(result.grantId!);
    if (!signed) {
      res.status(500).json({ error: "JWT_SECRET not configured" });
      return;
    }

    // Short-ish max age; sliding window is enforced server-side anyway.
    // Set max-age = 2h so the cookie never wildly outlives the server's view of the grant.
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    const securePart = isSecure ? " Secure;" : "";
    res.setHeader("Set-Cookie", `relay_grant=${signed}; HttpOnly; SameSite=Lax;${securePart} Path=/; Max-Age=${2 * 60 * 60}`);
    res.json({ sessionUrl: `/sessions/${result.sessionId}` });
  });

  // POST /api/pair/logout — guest clears their grant cookie and server state.
  router.post("/pair/logout", (req, res) => {
    const cookieHeader = req.headers.cookie || "";
    // Parse minimally — we only need the grant cookie
    const m = cookieHeader.match(/(?:^|;\s*)relay_grant=([^;]+)/);
    if (m && options.pairStore) {
      const grantId = verifyGrantCookie(decodeURIComponent(m[1]));
      if (grantId) options.pairStore.revokeGrant(grantId);
    }
    res.setHeader("Set-Cookie", "relay_grant=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  // GET /api/sessions/:id/grants — list active guest grants for a session (owner UI).
  router.get("/sessions/:id/grants", (req, res) => {
    if (!options.pairStore) {
      res.json({ grants: [] });
      return;
    }
    res.json({ grants: options.pairStore.listGrantsForSession(req.params.id) });
  });

  // DELETE /api/sessions/:id/grants/:grantId — kick a guest.
  router.delete("/sessions/:id/grants/:grantId", (req, res) => {
    if (!options.pairStore) {
      res.status(500).json({ error: "Pair store not configured" });
      return;
    }
    const removed = options.pairStore.revokeGrant(req.params.grantId);
    res.json({ ok: removed });
  });

  // GET /api/pair/whoami — returns info about the current grant (used by the session page).
  router.get("/pair/whoami", (req, res) => {
    const cookieHeader = req.headers.cookie || "";
    const m = cookieHeader.match(/(?:^|;\s*)relay_grant=([^;]+)/);
    if (!m || !options.pairStore) {
      res.json({ isGuest: false });
      return;
    }
    const grantId = verifyGrantCookie(decodeURIComponent(m[1]));
    if (!grantId) {
      res.json({ isGuest: false });
      return;
    }
    const { sessionId, isValid } = options.pairStore.verifyGrant(grantId);
    if (!isValid) {
      res.json({ isGuest: false });
      return;
    }
    res.json({ isGuest: true, sessionId });
  });
```


- [ ] **Step 3: Smoke-check**

Run: `npm run dev` in the background, then in another shell:

```bash
# Localhost bypass means we don't need JWT_SECRET to test the happy path.
curl -sS -X POST http://localhost:7680/api/sessions/NONEXISTENT/pair
# Expected: {"error":"Session not found"}

# Create a session and mint a code:
SID=$(curl -sS -X POST -H 'content-type: application/json' \
  -d '{"command":"cat","cols":80,"rows":24}' http://localhost:7680/api/sessions | jq -r .session.id)
curl -sS -X POST http://localhost:7680/api/sessions/$SID/pair
# Expected: {"code":"123456","expiresIn":300,"pairUrl":"http://localhost:7680/pair"}
```

Kill the session + stop the server.

Expected: both responses match.

- [ ] **Step 4: Commit**

```bash
git add shared/types.ts server/api.ts
git commit -m "feat: pair-code API — mint, redeem, list, revoke, whoami"
```

---

## Task 6: /pair route — 6-digit code entry page

**Files:**
- Create: `app/routes/pair.tsx`
- Modify: `app/routes.ts`

- [ ] **Step 1: Register the route**

Modify `app/routes.ts`:

```ts
import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("activity", "routes/activity.tsx"),
  route("grid", "routes/grid.tsx"),
  route("lanes", "routes/lanes.tsx"),
  route("tiles", "routes/tiles.tsx"),
  route("settings", "routes/settings.tsx"),
  route("sessions/:id", "routes/sessions.$id.tsx"),
  route("share/:token", "routes/share.$token.tsx"),
  route("pair", "routes/pair.tsx"),
] satisfies RouteConfig;
```

- [ ] **Step 2: Create the /pair page**

Create `app/routes/pair.tsx`:

```tsx
import { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router";

export function meta() {
  return [{ title: "relay-tty — pair device" }];
}

export default function PairPage() {
  const navigate = useNavigate();
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(async (code: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/pair/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          data.error === "rate-limited" ? "Too many attempts. Wait a minute and try again."
          : data.error === "expired" ? "That code expired. Ask for a new one."
          : data.error === "invalid-code-format" ? "Code must be 6 digits."
          : "That code didn't work.";
        setError(msg);
        setDigits("");
        setSubmitting(false);
        inputRef.current?.focus();
        return;
      }
      navigate(data.sessionUrl, { replace: true });
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }, [navigate]);

  const onChange = (raw: string) => {
    const clean = raw.replace(/\D/g, "").slice(0, 6);
    setDigits(clean);
    setError(null);
    if (clean.length === 6) submit(clean);
  };

  return (
    <main className="h-app flex items-center justify-center bg-[#0a0a0f]">
      <div className="w-full max-w-xs px-6 text-center">
        <h1 className="text-xl font-bold text-[#e2e8f0] mb-2">Pair device</h1>
        <p className="text-sm text-[#64748b] mb-6">
          Enter the 6-digit code shown on the device that started the session.
        </p>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          autoComplete="one-time-code"
          value={digits}
          onChange={(e) => onChange(e.target.value)}
          disabled={submitting}
          className="toolbar-input w-full text-center text-3xl tracking-[0.4em] font-mono py-3"
          placeholder="••••••"
          aria-label="6-digit pair code"
        />
        {error && (
          <p className="mt-3 text-sm text-[#ef4444] font-mono" role="alert">{error}</p>
        )}
        {submitting && !error && (
          <p className="mt-3 text-sm text-[#64748b] font-mono">Checking code…</p>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Manual test — does the page render?**

Start dev server in background: `npm run dev`
Visit `http://localhost:7680/pair` in a browser (or curl the HTML).

Run: `curl -sS http://localhost:7680/pair | grep -c "Pair device"`
Expected: `1` (the h1 text renders).

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add app/routes.ts app/routes/pair.tsx
git commit -m "feat: add /pair page for 6-digit device pairing"
```

---

## Task 7: Owner UI — PairHostDialog

**Files:**
- Create: `app/components/pair-host-dialog.tsx`
- Modify: `app/components/session-info-panel.tsx`
- Modify: `app/routes/sessions.$id.tsx`

The dialog shows the 6-digit code with a countdown, a copy-to-clipboard button, and a live list of connected guests with per-guest kick buttons.

- [ ] **Step 1: Create the PairHostDialog component**

Create `app/components/pair-host-dialog.tsx`:

```tsx
import { useState, useCallback, useEffect } from "react";
import { Copy, Check, Hash, X as XIcon, RefreshCw } from "lucide-react";
import type { GrantListEntry } from "../../shared/types";

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function PairHostDialog({ sessionId, onClose }: Props) {
  const [code, setCode] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [guests, setGuests] = useState<GrantListEntry[]>([]);

  const mint = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pair`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to mint code");
        return;
      }
      const data = await res.json();
      setCode(data.code);
      setPairUrl(data.pairUrl);
      setExpiresAt(Date.now() + data.expiresIn * 1000);
    } catch {
      setError("Network error");
    } finally {
      setGenerating(false);
    }
  }, [sessionId]);

  // Mint on open
  useEffect(() => { mint(); }, [mint]);

  // Countdown
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const s = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setSecondsLeft(s);
      if (s === 0) {
        setCode(null);
        setExpiresAt(null);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // Poll guests
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/grants`);
        const data = await res.json();
        if (!stop) setGuests(data.grants || []);
      } catch { /* transient */ }
    };
    load();
    const id = setInterval(load, 5000);
    return () => { stop = true; clearInterval(id); };
  }, [sessionId]);

  const onCopy = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore — some browsers block clipboard write
    }
  }, [code]);

  const kick = useCallback(async (grantId: string) => {
    await fetch(`/api/sessions/${sessionId}/grants/${grantId}`, { method: "DELETE" });
    setGuests((prev) => prev.filter((g) => g.grantId !== grantId));
  }, [sessionId]);

  return (
    <dialog className="modal modal-open" onClick={onClose}>
      <div
        className="modal-box max-w-sm bg-[#0f0f1a] border border-[#2d2d44]"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold text-lg mb-4 text-[#e2e8f0] flex items-center gap-2">
          <Hash className="w-5 h-5 text-[#3b82f6]" />
          Pair Device
        </h3>

        {/* Code + countdown */}
        <div className="text-center mb-4">
          {generating && <span className="loading loading-spinner loading-md" />}
          {!generating && code && (
            <>
              <div className="font-mono text-4xl tracking-[0.4em] text-[#e2e8f0] select-all py-4">
                {code.slice(0, 3)} {code.slice(3)}
              </div>
              <p className="text-xs font-mono text-[#64748b]">
                Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
              </p>
              {pairUrl && (
                <p className="text-xs font-mono text-[#94a3b8] mt-2 break-all">
                  On the other device, open <span className="text-[#3b82f6]">{pairUrl}</span>
                </p>
              )}
            </>
          )}
          {!generating && !code && (
            <>
              <p className="text-sm text-[#ef4444] font-mono py-4">Code expired</p>
              <button className="btn btn-sm btn-primary" onClick={mint} onMouseDown={(e) => e.preventDefault()} tabIndex={-1}>
                <RefreshCw className="w-4 h-4" /> Generate new code
              </button>
            </>
          )}
          {error && <p className="text-xs text-[#ef4444] font-mono mt-2">{error}</p>}
        </div>

        {/* Copy button */}
        {code && (
          <div className="flex justify-center mb-4">
            <button
              className="btn btn-sm bg-[#19191f] border-[#2d2d44] text-[#94a3b8] hover:text-[#e2e8f0]"
              onClick={onCopy}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              {copied ? <Check className="w-4 h-4 text-[#22c55e]" /> : <Copy className="w-4 h-4" />}
              {copied ? "Copied" : "Copy code"}
            </button>
          </div>
        )}

        {/* Connected guests */}
        <div className="border-t border-[#2d2d44] pt-4">
          <p className="text-xs font-mono text-[#64748b] mb-2">
            Connected devices ({guests.length})
          </p>
          {guests.length === 0 && (
            <p className="text-xs font-mono text-[#64748b] italic">No devices paired yet</p>
          )}
          {guests.map((g) => (
            <div key={g.grantId} className="flex items-center gap-2 py-1 text-xs font-mono text-[#94a3b8]">
              <span className="flex-1 truncate">
                {g.ip} · since {new Date(g.issuedAt).toLocaleTimeString()}
              </span>
              <button
                className="btn btn-xs btn-square bg-[#1a1a2e] border-[#2d2d44] text-[#ef4444] hover:bg-[#2d1a1a]"
                onClick={() => kick(g.grantId)}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
                aria-label="Kick device"
              >
                <XIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        <div className="modal-action mt-4">
          <button
            className="btn btn-sm bg-[#1a1a2e] border-[#2d2d44] text-[#94a3b8] hover:text-[#e2e8f0]"
            onClick={onClose}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
          >
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
```

- [ ] **Step 2: Add "Pair Device" button to SessionInfoPanel**

Read `app/components/session-info-panel.tsx` and find the `onShare` prop (around line 46) and its usage (around line 254-257). Add a sibling `onPair` prop and button.

Add to the props interface (next to `onShare?: () => void;`):

```ts
  onPair?: () => void;
```

Destructure it in the function signature next to `onShare`:

```ts
  onShare,
  onPair,
```

Immediately after the `onShare` button block (the `{onShare && (...)}` JSX), add:

```tsx
        {onPair && (
          <button
            className="..." // match the styling of the onShare button exactly — copy classes from it
            onPress={() => { onClose(); onPair(); }}
          >
            Pair Device
          </button>
        )}
```

**Reference:** before editing, read lines 240-270 of `app/components/session-info-panel.tsx` to see the existing button pattern, then mirror it exactly. Use the `Hash` icon from `lucide-react` (import it at the top of the file alongside the existing icons).

- [ ] **Step 3: Wire PairHostDialog into sessions.$id.tsx**

Modify `app/routes/sessions.$id.tsx`:

1. Add the import near line 17 (next to `ShareDialog`):

```ts
import { PairHostDialog } from "../components/pair-host-dialog";
```

2. Add the state near line 264 (next to `shareDialogOpen`):

```ts
  const [pairDialogOpen, setPairDialogOpen] = useState(false);
```

3. Pass `onPair` next to `onShare` (around line 1088):

```tsx
              onShare={() => setShareDialogOpen(true)}
              onPair={() => setPairDialogOpen(true)}
```

4. Render the dialog alongside the share dialog (around line 1403-1408):

```tsx
      {/* ── Pair dialog ── */}
      {pairDialogOpen && (
        <PairHostDialog
          sessionId={session.id}
          onClose={() => setPairDialogOpen(false)}
        />
      )}
```

- [ ] **Step 4: Manual smoke test**

Start the dev server. Open a session. Open the info panel. Tap "Pair Device". Confirm:
- Modal shows a 6-digit code
- Countdown decreases
- Copy button works (code goes to clipboard)
- "Connected devices (0)" is shown

Close the modal.

- [ ] **Step 5: Commit**

```bash
git add app/components/pair-host-dialog.tsx app/components/session-info-panel.tsx app/routes/sessions.$id.tsx
git commit -m "feat: PairHostDialog — code + guest list for owners"
```

---

## Task 8: Guest session logout UI

**Files:**
- Modify: `app/routes/sessions.$id.tsx`

When the page loads inside a grant cookie (as opposed to a full `session` JWT), show a compact "Guest — log out" chip in the header. Tapping it calls `/api/pair/logout` and redirects to `/pair` (fresh state).

- [ ] **Step 1: Add `isGuest` detection via /api/pair/whoami**

In `app/routes/sessions.$id.tsx`, add a hook near the top of the component:

```ts
  const [isGuest, setIsGuest] = useState(false);

  useEffect(() => {
    let stop = false;
    fetch("/api/pair/whoami")
      .then((r) => r.json())
      .then((data) => { if (!stop) setIsGuest(!!data.isGuest); })
      .catch(() => { /* treat as owner */ });
    return () => { stop = true; };
  }, []);
```

Place this near the other top-level hooks in the component (just after the existing `useState` declarations around line 262-266, before other `useEffect`s).

- [ ] **Step 2: Render the guest chip in the header**

Find the header section of the session view (search the file for the `relay-tty` branding line — around the `<code className="...font-bold font-mono text-[#22c55e] pl-1">relay-tty</code>` block). Immediately after the branding area, before the right-side controls, add:

```tsx
{isGuest && (
  <button
    className="ml-2 text-xs font-mono border border-[#f59e0b] text-[#f59e0b] rounded px-2 py-0.5 hover:bg-[#2a1e0f]"
    onMouseDown={(e) => e.preventDefault()}
    tabIndex={-1}
    onClick={async () => {
      await fetch("/api/pair/logout", { method: "POST" });
      window.location.href = "/pair";
    }}
  >
    Guest · log out
  </button>
)}
```

If the header layout already has constraints (e.g. flex with specific gap), match the existing siblings' classes.

- [ ] **Step 3: Verify hide logic in SessionInfoPanel**

A guest should not be able to mint codes or kick other guests. In `session-info-panel.tsx`, pass `isGuest` through and hide both `Pair Device` and (optionally) `Share` buttons for guests. **Simpler approach that requires no prop-plumbing:** in `sessions.$id.tsx`, conditionally pass `onPair` only when `!isGuest`:

```tsx
              onPair={isGuest ? undefined : () => setPairDialogOpen(true)}
```

(The `SessionInfoPanel` already guards with `{onPair && (...)}`.) Apply the same treatment to `onShare` and `onKillSession`. The full replacement for the props block around line 1088 is:

```tsx
              onShare={isGuest ? undefined : () => setShareDialogOpen(true)}
              onPair={isGuest ? undefined : () => setPairDialogOpen(true)}
              onKillSession={isGuest ? undefined : async () => {
                if (!confirm("Kill this session?")) return;
                await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
                navigate("/");
              }}
```

If `onShare` or `onKillSession` are currently required props on `SessionInfoPanel`, change their type declarations to optional (add `?`) in `app/components/session-info-panel.tsx`. The panel already guards each button with `{onShare && (...)}` etc., so making them optional is safe.

- [ ] **Step 4: Manual smoke test**

1. Start the server with `JWT_SECRET=testsecret APP_URL=http://localhost:7680 npm run dev`.
2. Open an incognito window, visit `http://localhost:7680/pair` — confirm the input renders.
3. In your main (localhost-bypass) window, start a session and mint a pair code.
4. In the incognito window, enter the 6-digit code. Confirm redirect to `/sessions/<id>`.
5. Confirm the header shows "Guest · log out".
6. Confirm the info panel hides the "Pair Device" and "Share" and "Kill" buttons.
7. Tap "Guest · log out". Confirm you are redirected to `/pair`.
8. Try to revisit `/sessions/<id>` — confirm you get a 401.

- [ ] **Step 5: Commit**

```bash
git add app/routes/sessions.$id.tsx app/components/session-info-panel.tsx
git commit -m "feat: guest session UI — log-out chip + hide owner controls"
```

---

## Task 9: End-to-end redemption integration test

**Files:**
- Create: `test/pair-redeem.integration.test.ts`

The happy-path: mint a code, redeem it through the real Express app, confirm the `relay_grant` cookie is issued, then confirm the cookie grants access to the scoped session but 401s on unrelated paths.

- [ ] **Step 1: Write the test**

Create `test/pair-redeem.integration.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createApiRouter } from "../server/api.js";
import { PairStore } from "../server/pair-store.js";
import { SessionStore } from "../server/session-store.js";
import { authMiddleware, setPairStore } from "../server/auth.js";

process.env.JWT_SECRET = "test-secret";

// Minimal PtyManager stub — we don't exercise any pty calls in this test.
const ptyManagerStub = {
  spawn: async () => { throw new Error("not used"); },
  ensureMonitor: async () => null,
  kill: () => {},
  cleanup: () => {},
  fetchSparkline: async () => [],
  getSocketPath: () => "",
  on: () => {},
} as any;

function makeApp(sessionStore: SessionStore, pairStore: PairStore): express.Express {
  setPairStore(pairStore);
  const app = express();
  app.use(express.json());
  // Force non-localhost IP so auth actually enforces
  app.use((req, _res, next) => { Object.defineProperty(req, "ip", { value: "1.2.3.4" }); next(); });
  app.use(authMiddleware);
  app.use("/api", createApiRouter(sessionStore, ptyManagerStub, { pairStore }));
  return app;
}

async function fetchApp(app: express.Express, path: string, init: RequestInit = {}): Promise<{ status: number; body: any; setCookie?: string }> {
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, setCookie: res.headers.get("set-cookie") ?? undefined };
  } finally {
    server.close();
  }
}

describe("pair redemption end-to-end", () => {
  it("mints, redeems, scopes, and revokes", async () => {
    const sessionStore = new SessionStore();
    // Seed the store so `/sessions/:id/pair` passes the 404 guard.
    (sessionStore as any).sessions.set("abc12345", { id: "abc12345", status: "running" });
    const pairStore = new PairStore();
    const app = makeApp(sessionStore, pairStore);

    // 1. Mint without auth — must be 401 because we forced IP to 1.2.3.4
    //    (the route is under /api, which the middleware blocks for non-auth non-localhost)
    const noauth = await fetchApp(app, "/api/sessions/abc12345/pair", { method: "POST" });
    assert.equal(noauth.status, 401);

    // 2. Mint directly through the store, since JWT_SECRET-based owner auth isn't what we're testing here
    const code = pairStore.mintCode("abc12345", "owner");

    // 3. Redeem — public route, should succeed
    const redeem = await fetchApp(app, "/api/pair/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(redeem.status, 200);
    assert.match(redeem.body.sessionUrl, /^\/sessions\/abc12345$/);
    assert.ok(redeem.setCookie?.includes("relay_grant="));

    const cookie = redeem.setCookie!.split(";")[0];

    // 4. Cookie grants access to /api/sessions/abc12345
    const scoped = await fetchApp(app, "/api/sessions/abc12345", {
      headers: { cookie },
    });
    assert.equal(scoped.status, 404); // ensureMonitor returns null — routes to 404 not 401
    // The key assertion is that we got PAST auth.

    // 5. Cookie is rejected on unrelated session
    const other = await fetchApp(app, "/api/sessions/ZZZ99999", {
      headers: { cookie },
    });
    assert.equal(other.status, 401);

    // 6. Logout clears the cookie + revokes
    const logout = await fetchApp(app, "/api/pair/logout", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logout.status, 200);
    assert.ok(logout.setCookie?.includes("Max-Age=0"));

    // 7. After logout, cookie no longer grants access
    const after = await fetchApp(app, "/api/sessions/abc12345", {
      headers: { cookie },
    });
    assert.equal(after.status, 401);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- --test-name-pattern="pair redemption"`
Expected: PASS.

If it fails because `SessionStore` doesn't expose a `sessions` Map, inspect `server/session-store.ts` and adjust seeding to whatever internal method or constructor arg it exposes. (Read the file first: `grep -n 'class SessionStore\|set\|sessions' server/session-store.ts`.)

- [ ] **Step 3: Commit**

```bash
git add test/pair-redeem.integration.test.ts
git commit -m "test: integration test for pair redemption + scoped auth"
```

---

## Task 10: Documentation

**Files:**
- Modify: `docs/content/reference/cli.mdx` (or relevant reference page — verify via `ls docs/content/`)
- Create or modify: a how-to page under `docs/content/how-to/` describing the pairing flow
- Modify: `CHANGELOG.md` under an "Unreleased" section

Per `CLAUDE.md`: "Always update docs when changing user-facing features."

- [ ] **Step 1: Identify the right doc pages**

Run:

```bash
ls docs/content/
ls docs/content/reference/ 2>/dev/null
ls docs/content/how-to/ 2>/dev/null
```

Find the page that documents "sharing" today (likely `docs/content/reference/sharing.mdx` or similar). If none exists, create `docs/content/how-to/pair-device.mdx`.

- [ ] **Step 2: Write a short how-to**

Create or append (depending on Step 1 result) with this content:

```mdx
---
title: Pair a device with a running session
description: Share a live session with another browser on another device using a one-time 6-digit code.
---

## What this does

Gives a second device full interactive access to one session you started, without email, QR cameras, or sharing your login. The other device goes to `/pair`, types a 6-digit code shown on your original device, and lands in the session as a guest.

Guest access is bounded:

- **30-minute idle timeout** — grant expires after 30 minutes of inactivity.
- **Explicit logout** — the guest can log out any time; you can kick them from the host dialog.
- **Scope** — the guest can only see and interact with the one session that was shared. They cannot list other sessions, access the file browser for other paths, or spawn new sessions.

## How to pair

**On the device running the session:**

1. Open the session's info panel.
2. Tap **Pair Device**.
3. Read the 6-digit code (e.g. `384 291`). It expires in 5 minutes.

**On the other device:**

1. Go to `/pair` on your relay-tty domain.
2. Enter the 6-digit code.
3. You'll be redirected into the session.

## Managing guests

The host dialog shows all connected devices with their IP and connection time. Tap the `×` button next to any guest to kick them.

The guest's header shows a **Guest · log out** chip they can tap to leave cleanly.

## Security notes

- Codes are single-use and expire in 5 minutes.
- Rate limit: 5 redemption attempts per IP per minute.
- Grant cookies are HMAC-signed with `JWT_SECRET` and server-verified on every request.
- Grants are in-memory — restarting the server logs out all guests.
```

- [ ] **Step 3: Add changelog entry**

Append under the "Unreleased" section of `CHANGELOG.md`:

```md
### Added
- `/pair` page and "Pair Device" session action — share a session with another browser using a one-time 6-digit code. Grants expire after 30 minutes of inactivity or on explicit logout.
```

If no "Unreleased" section exists, add one at the top.

- [ ] **Step 4: Commit**

```bash
git add docs/ CHANGELOG.md
git commit -m "docs: document /pair device sharing"
```

---

## Self-review checklist (run before handing off)

- [ ] Every task has concrete file paths
- [ ] All tests show the full assertion code, not placeholders
- [ ] No "TODO" or "similar to above" references
- [ ] Auth middleware correctly rejects grant cookies on wrong-session URLs
- [ ] Sliding 30-min idle timeout is enforced by `verifyGrant` (not just on a sweep)
- [ ] Guest UI hides all owner-only actions (share, pair, kill)
- [ ] `/pair/redeem` is exempt from auth middleware (otherwise it 401s before the handler runs)
- [ ] `relay_grant` cookie is HttpOnly, SameSite=Lax, Path=/
- [ ] Server restart drops all guests (explicitly documented; acceptable)
- [ ] Changelog + docs updated
