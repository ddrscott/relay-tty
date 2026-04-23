import type { Request, Response, NextFunction } from "express";
import type { PairStore } from "./pair-store.js";
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as cookie from "cookie";

const PASSWD_FILE = path.join(os.homedir(), ".relay-tty", "passwd");

const JWT_SECRET = process.env.JWT_SECRET || "";

let pairStore: PairStore | null = null;

/**
 * Register the pair-code store. Called once during server startup.
 * The auth middleware uses this to verify `relay_grant` cookies.
 */
export function setPairStore(store: PairStore): void {
  pairStore = store;
}

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
  return urlPath === "/api/pair/logout" || urlPath === "/api/pair/whoami";
}

/**
 * Check if request originates from localhost.
 *
 * SECURITY: This relies on req.ip being the direct connection IP.
 * If Express `trust proxy` is enabled, req.ip becomes the X-Forwarded-For
 * value, which can be spoofed — allowing remote clients to bypass auth
 * by sending `X-Forwarded-For: 127.0.0.1`. Do NOT set `trust proxy`
 * without also removing or reworking this bypass.
 *
 * Cloudflare tunnel detection: cloudflared runs locally so proxied traffic
 * appears as 127.0.0.1, but Cloudflare edge injects `Cf-Connecting-Ip`.
 * If that header is present, the request came through a CF tunnel and must
 * NOT get the localhost bypass. The `--tunnel` relay tunnel strips CF
 * headers before forwarding, so it still gets the bypass (secured by slug).
 */
function isLocalhost(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress || "";
  const isLocal =
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost";

  if (!isLocal) return false;

  // cloudflared forwards Cf-Connecting-Ip from the Cloudflare edge —
  // its presence means this "localhost" request is actually remote.
  if (req.headers["cf-connecting-ip"]) return false;

  // Custom tunnel client (v1.9+) injects this header so auth is enforced.
  // Older tunnel clients omit it and keep the localhost bypass (slug-only security).
  if (req.headers["x-relay-tunnel"]) return false;

  return true;
}

interface JwtPayload {
  iss?: string;
  iat?: number;
  [key: string]: unknown;
}

function signJwt(payload: JwtPayload, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token: string): JwtPayload | null {
  if (!JWT_SECRET) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const headerPayload = `${parts[0]}.${parts[1]}`;
    const signature = createHmac("sha256", JWT_SECRET)
      .update(headerPayload)
      .digest("base64url");

    if (signature !== parts[2]) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString()
    ) as JwtPayload;

    if (payload.iss !== "relay-tty") return null;

    // Check expiry if present
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate an access token for remote browser auth.
 * Returns null if JWT_SECRET is not configured.
 */
export function generateToken(): string | null {
  if (!JWT_SECRET) return null;
  return signJwt({ iss: "relay-tty", iat: Math.floor(Date.now() / 1000) }, JWT_SECRET);
}

/**
 * Generate a short-lived access token (for QR codes, etc).
 * The token is valid for `ttlSeconds` (default 24h).
 * The auth callback should exchange this for a long-lived session cookie.
 */
export function generateAccessToken(ttlSeconds = 86400): string | null {
  if (!JWT_SECRET) return null;
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: "relay-tty",
    iat: now,
    exp: now + ttlSeconds,
  }, JWT_SECRET);
}

/**
 * Verify an access token. Returns true if valid, false otherwise.
 * Used by the auth callback to validate incoming tokens before setting cookies.
 */
export function verifyAccessToken(token: string): boolean {
  return verifyJwt(token) !== null;
}

/**
 * Generate a short-lived, read-only share token for a session.
 */
export function generateShareToken(sessionId: string, ttlSeconds = 3600): string | null {
  if (!JWT_SECRET) return null;
  return signJwt({
    iss: "relay-tty",
    sub: sessionId,
    scope: "share:read",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  }, JWT_SECRET);
}

/**
 * Verify a share token. Returns the session ID if valid, null otherwise.
 * Returns null for password-protected tokens — use verifyPasswordShareToken instead.
 */
export function verifyShareToken(token: string): string | null {
  if (!JWT_SECRET) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    // Reject password-protected tokens — they need verifyPasswordShareToken
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString()
    ) as JwtPayload;
    if (payload.pwd === true) return null;

    const headerPayload = `${parts[0]}.${parts[1]}`;
    const signature = createHmac("sha256", JWT_SECRET)
      .update(headerPayload)
      .digest("base64url");

    if (signature !== parts[2]) return null;

    if (payload.iss !== "relay-tty") return null;
    if (payload.scope !== "share:read") return null;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== "string") return null;

    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * Read the global relay password hash from ~/.relay-tty/passwd.
 */
export function readPasswordHash(): string | null {
  try {
    const hash = fs.readFileSync(PASSWD_FILE, "utf-8").trim();
    return hash || null;
  } catch {
    return null;
  }
}

/**
 * Hash a raw password with SHA-256 (for storing or deriving signing secrets).
 */
export function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

/**
 * Generate a password-protected share token.
 * The JWT is signed with a derived secret (JWT_SECRET + passwordHash) so the
 * token is cryptographically unverifiable without knowing the password.
 */
export function generatePasswordShareToken(sessionId: string, passwordHash: string, ttlSeconds = 3600): string | null {
  if (!JWT_SECRET) return null;
  const derivedSecret = JWT_SECRET + passwordHash;
  return signJwt({
    iss: "relay-tty",
    sub: sessionId,
    scope: "share:read",
    pwd: true,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  }, derivedSecret);
}

/**
 * Verify a password-protected share token.
 * The caller provides the raw password; we hash it and reconstruct the derived secret.
 */
export function verifyPasswordShareToken(token: string, password: string): string | null {
  if (!JWT_SECRET) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const passwordHash = hashPassword(password);
    const derivedSecret = JWT_SECRET + passwordHash;
    const headerPayload = `${parts[0]}.${parts[1]}`;
    const signature = createHmac("sha256", derivedSecret)
      .update(headerPayload)
      .digest("base64url");

    if (signature !== parts[2]) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString()
    ) as JwtPayload;

    if (payload.iss !== "relay-tty") return null;
    if (payload.scope !== "share:read") return null;
    if (payload.pwd !== true) return null;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== "string") return null;

    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * Peek at a JWT's payload without verifying the signature.
 * Used by the share page to check the `pwd` flag before prompting.
 */
export function peekJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as JwtPayload;
  } catch {
    return null;
  }
}

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

/**
 * Express middleware: skip auth for localhost, require valid JWT cookie for remote.
 */
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

/**
 * Verify JWT (or grant cookie) from WebSocket upgrade request cookies.
 */
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
        const urlPath = req.url.split("?")[0];
        const wsMatch = urlPath.match(/^\/ws\/sessions\/([a-f0-9]+)$/);
        if (wsMatch && wsMatch[1] === sessionId) return true;
      }
    }
  }

  return false;
}
