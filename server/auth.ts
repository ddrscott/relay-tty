import type { Request, Response, NextFunction } from "express";
import { createHmac } from "node:crypto";
import * as cookie from "cookie";

const JWT_SECRET = process.env.JWT_SECRET || "";
const AUTH_LOGIN_URL = "https://auth.ljs.app/login";
const RELAY_CALLBACK_URL = "https://relay.ljs.app/api/auth/callback";

function isLocalhost(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress || "";
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  );
}

interface JwtPayload {
  sub?: string;
  iss?: string;
  exp?: number;
  [key: string]: unknown;
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

    // Check expiration
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;

    // Check issuer
    if (payload.iss && payload.iss !== "auth.ljs.app") return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Express middleware: skip auth for localhost, require valid JWT for remote.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Localhost bypass — CLI on the same machine is trusted
  if (isLocalhost(req)) {
    next();
    return;
  }

  // No JWT_SECRET configured — auth disabled
  if (!JWT_SECRET) {
    next();
    return;
  }

  // Check session cookie
  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies.session;

  if (token) {
    const payload = verifyJwt(token);
    if (payload) {
      next();
      return;
    }
  }

  // API requests get 401, browser requests get redirected
  if (req.path.startsWith("/api/") || req.path.startsWith("/ws/")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const returnTo = encodeURIComponent(RELAY_CALLBACK_URL);
  res.redirect(`${AUTH_LOGIN_URL}?returnTo=${returnTo}`);
}

/**
 * Verify JWT from WebSocket upgrade request cookies.
 * Returns true if authorized (localhost or valid JWT).
 */
export function verifyWsAuth(req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }): boolean {
  const ip = req.socket.remoteAddress || "";
  const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

  if (isLocal) return true;
  if (!JWT_SECRET) return true;

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== "string") return false;

  const cookies = cookie.parse(cookieHeader);
  const token = cookies.session;
  if (!token) return false;

  return verifyJwt(token) !== null;
}
