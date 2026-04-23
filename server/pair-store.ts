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

    this.codes.delete(code);
    const grantId = randomBytes(32).toString("hex");

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
    for (const [ip, attempt] of this.ipAttempts) {
      if (now - attempt.windowStart > this.IP_WINDOW_MS) this.ipAttempts.delete(ip);
    }
  }

  startSweepTimer(): ReturnType<typeof setInterval> {
    const timer = setInterval(() => this.sweep(), 60 * 1000);
    timer.unref();
    return timer;
  }
}
