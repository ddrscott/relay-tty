import type { Request, Response, NextFunction } from "express";
import { createHmac } from "node:crypto";
import * as cookie from "cookie";

const JWT_SECRET = process.env.JWT_SECRET || "";

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

  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies.session;

  if (token && verifyJwt(token)) {
    next();
    return;
  }

  if (req.path.startsWith("/api/") || req.path.startsWith("/ws/")) {
    res.status(401).json({ error: "Unauthorized" });
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
 * Verify JWT from WebSocket upgrade request cookies.
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
