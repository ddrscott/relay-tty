# Usage Stats & Shareable Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track cumulative relay-tty usage (wall-clock + active time) with daily buckets, display stats on the home page, and let users opt in to a shareable SVG badge hosted at relaytty.com via Cloudflare Worker + D1.

**Architecture:** Rust pty-host adds an `activeSeconds` counter incremented each second when `bps1 >= 1`. On session exit, the Node server aggregates wall-clock and active seconds into `~/.relay-tty/stats.json` with daily buckets. A new `/api/stats` endpoint computes rollups and streaks. The home page shows a stats card with a "Share Badge" button that pushes stats to a Cloudflare Worker backed by D1.

**Tech Stack:** Rust (pty-host), TypeScript/Node (server), React (UI), Cloudflare Workers + D1 (badge hosting)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `crates/pty-host/src/main.rs` | Add `active_seconds` to `SessionMeta`, increment in metrics loop |
| Modify | `shared/types.ts` | Add `activeSeconds` to `Session` interface, add stats types |
| Create | `server/stats.ts` | Aggregation logic: read/write stats.json, compute rollups/streaks |
| Modify | `server/api.ts` | Add `GET /api/stats` and `POST/DELETE /api/badge` proxy endpoints |
| Modify | `server/session-store.ts` | Call stats aggregation on session exit |
| Modify | `app/routes/home.tsx` | Add stats card with share button to home page |
| Create | `app/components/stats-card.tsx` | Stats display + share badge UI component |
| Create | `worker/badge/` | Cloudflare Worker: D1 schema, badge endpoints, SVG renderer |

---

### Task 1: Add `activeSeconds` to Rust pty-host

**Files:**
- Modify: `crates/pty-host/src/main.rs:1184-1218` (SessionMeta struct)
- Modify: `crates/pty-host/src/main.rs:1610-1630` (meta initialization)
- Modify: `crates/pty-host/src/main.rs:2038-2048` (metrics loop)
- Modify: `crates/pty-host/src/main.rs:3340-3350` (test helper)

- [ ] **Step 1: Add `active_seconds` field to `SessionMeta`**

In `crates/pty-host/src/main.rs`, add to the `SessionMeta` struct after `foreground_process`:

```rust
    /// Cumulative seconds where bps1 >= 1 (terminal actively producing output)
    #[serde(default)]
    active_seconds: f64,
```

- [ ] **Step 2: Initialize `active_seconds` in all meta construction sites**

In the error path meta construction (~line 1573-1590), add `active_seconds: 0.0` after `foreground_process: None`:

```rust
                foreground_process: None,
                active_seconds: 0.0,
```

In the normal meta construction (~line 1610-1630), add `active_seconds: 0.0` after `foreground_process: None`:

```rust
        foreground_process: None,
        active_seconds: 0.0,
```

In all test helper `SessionMeta` constructions (~lines 3340, 3380, 3414), add:

```rust
            foreground_process: None,
            active_seconds: 0.0,
```

- [ ] **Step 3: Increment `active_seconds` in the metrics loop**

In the metrics broadcast task (~line 2043-2048), after `s.meta.bytes_per_second = bps1;` and before `s.sparkline.push(bps1);`, add:

```rust
            // Track cumulative active time
            if bps1 >= 1.0 {
                s.meta.active_seconds += 1.0;
            }
```

- [ ] **Step 4: Build and test**

Run:
```bash
cargo build --release --manifest-path crates/pty-host/Cargo.toml
cargo test --manifest-path crates/pty-host/Cargo.toml
```

Expected: Build succeeds, all existing tests pass. The `activeSeconds` field now appears in session JSON files.

- [ ] **Step 5: Commit**

```bash
git add crates/pty-host/src/main.rs
git commit -m "feat(pty-host): add activeSeconds counter to session metadata"
```

---

### Task 2: Add `activeSeconds` to TypeScript types

**Files:**
- Modify: `shared/types.ts:1-31`

- [ ] **Step 1: Add `activeSeconds` to Session interface**

In `shared/types.ts`, add after the `foregroundProcess` field (line 30):

```typescript
  /** Cumulative seconds where bps1 >= 1 (terminal actively producing output) */
  activeSeconds?: number;
```

- [ ] **Step 2: Add stats types**

At the end of `shared/types.ts`, after the `Project` interface, add:

```typescript
export interface DayStats {
  wallSeconds: number;
  activeSeconds: number;
  sessionCount: number;
}

export interface StatsFile {
  days: Record<string, DayStats>;
  aggregatedIds: string[];
  badge?: {
    id: string;
    token: string;
    mode: "live" | "snapshot";
    url: string;
  };
}

export interface StatsResponse {
  today: DayStats;
  thisWeek: DayStats;
  thisMonth: DayStats;
  allTime: DayStats;
  currentStreak: number;
  longestStreak: number;
  badge?: {
    id: string;
    mode: "live" | "snapshot";
    url: string;
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat(types): add activeSeconds and stats types"
```

---

### Task 3: Create stats aggregation module

**Files:**
- Create: `server/stats.ts`

- [ ] **Step 1: Write tests for stats aggregation**

Create `server/stats.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { aggregateSession, readStats, computeStatsResponse } from "./stats.js";
import type { Session } from "../shared/types.js";

const TEST_DIR = path.join(os.tmpdir(), `relay-stats-test-${Date.now()}`);
const STATS_PATH = path.join(TEST_DIR, "stats.json");

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test1234",
    command: "zsh",
    args: [],
    cwd: "/tmp",
    createdAt: Date.now() - 3600_000, // 1 hour ago
    lastActivity: Date.now(),
    status: "exited",
    exitCode: 0,
    exitedAt: Date.now(),
    cols: 80,
    rows: 24,
    activeSeconds: 1200,
    ...overrides,
  };
}

describe("aggregateSession", () => {
  beforeEach(() => fs.mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

  it("creates stats file if missing", () => {
    const session = makeSession();
    aggregateSession(session, STATS_PATH);
    const stats = JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"));
    const dayKey = new Date(session.exitedAt!).toISOString().slice(0, 10);
    expect(stats.days[dayKey].wallSeconds).toBe(3600);
    expect(stats.days[dayKey].activeSeconds).toBe(1200);
    expect(stats.days[dayKey].sessionCount).toBe(1);
    expect(stats.aggregatedIds).toContain("test1234");
  });

  it("skips duplicate session IDs", () => {
    const session = makeSession();
    aggregateSession(session, STATS_PATH);
    aggregateSession(session, STATS_PATH);
    const stats = JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"));
    const dayKey = new Date(session.exitedAt!).toISOString().slice(0, 10);
    expect(stats.days[dayKey].sessionCount).toBe(1);
  });

  it("accumulates multiple sessions", () => {
    aggregateSession(makeSession({ id: "aaa11111" }), STATS_PATH);
    aggregateSession(makeSession({ id: "bbb22222", activeSeconds: 600 }), STATS_PATH);
    const stats = JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"));
    const dayKey = new Date().toISOString().slice(0, 10);
    expect(stats.days[dayKey].sessionCount).toBe(2);
    expect(stats.days[dayKey].activeSeconds).toBe(1800);
  });

  it("defaults activeSeconds to 0 when missing", () => {
    const session = makeSession({ activeSeconds: undefined });
    aggregateSession(session, STATS_PATH);
    const stats = JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"));
    const dayKey = new Date(session.exitedAt!).toISOString().slice(0, 10);
    expect(stats.days[dayKey].activeSeconds).toBe(0);
  });

  it("skips sessions with no exitedAt", () => {
    const session = makeSession({ exitedAt: undefined });
    aggregateSession(session, STATS_PATH);
    expect(fs.existsSync(STATS_PATH)).toBe(false);
  });

  it("caps aggregatedIds at 200", () => {
    for (let i = 0; i < 210; i++) {
      aggregateSession(
        makeSession({ id: `id${String(i).padStart(6, "0")}`, createdAt: Date.now() - 1000, exitedAt: Date.now() }),
        STATS_PATH
      );
    }
    const stats = JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"));
    expect(stats.aggregatedIds.length).toBeLessThanOrEqual(200);
  });
});

describe("computeStatsResponse", () => {
  it("computes rollups and streaks", () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const stats = {
      days: {
        [today]: { wallSeconds: 3600, activeSeconds: 1200, sessionCount: 3 },
        [yesterday]: { wallSeconds: 7200, activeSeconds: 2400, sessionCount: 5 },
      },
      aggregatedIds: [],
    };
    const response = computeStatsResponse(stats);
    expect(response.today.wallSeconds).toBe(3600);
    expect(response.allTime.wallSeconds).toBe(10800);
    expect(response.allTime.sessionCount).toBe(8);
    expect(response.currentStreak).toBe(2);
  });

  it("returns zeros for empty stats", () => {
    const response = computeStatsResponse({ days: {}, aggregatedIds: [] });
    expect(response.today.wallSeconds).toBe(0);
    expect(response.allTime.sessionCount).toBe(0);
    expect(response.currentStreak).toBe(0);
    expect(response.longestStreak).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/stats.test.ts`
Expected: FAIL — module `./stats.js` not found

- [ ] **Step 3: Implement `server/stats.ts`**

Create `server/stats.ts`:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Session, StatsFile, StatsResponse, DayStats } from "../shared/types.js";

const DATA_DIR = path.join(os.homedir(), ".relay-tty");
const DEFAULT_STATS_PATH = path.join(DATA_DIR, "stats.json");
const MAX_AGGREGATED_IDS = 200;

function emptyStats(): StatsFile {
  return { days: {}, aggregatedIds: [] };
}

function emptyDay(): DayStats {
  return { wallSeconds: 0, activeSeconds: 0, sessionCount: 0 };
}

export function readStats(statsPath = DEFAULT_STATS_PATH): StatsFile {
  try {
    return JSON.parse(fs.readFileSync(statsPath, "utf-8"));
  } catch {
    return emptyStats();
  }
}

function writeStats(stats: StatsFile, statsPath: string): void {
  const dir = path.dirname(statsPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = statsPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(stats, null, 2) + "\n");
  fs.renameSync(tmpPath, statsPath);
}

export function aggregateSession(session: Session, statsPath = DEFAULT_STATS_PATH): void {
  if (!session.exitedAt) return;

  const stats = readStats(statsPath);

  // Dedup check
  if (stats.aggregatedIds.includes(session.id)) return;

  const dayKey = new Date(session.exitedAt).toISOString().slice(0, 10);
  const day = stats.days[dayKey] || emptyDay();

  day.wallSeconds += Math.floor((session.exitedAt - session.createdAt) / 1000);
  day.activeSeconds += Math.floor(session.activeSeconds ?? 0);
  day.sessionCount += 1;
  stats.days[dayKey] = day;

  stats.aggregatedIds.push(session.id);
  // Cap aggregatedIds
  if (stats.aggregatedIds.length > MAX_AGGREGATED_IDS) {
    stats.aggregatedIds = stats.aggregatedIds.slice(-MAX_AGGREGATED_IDS);
  }

  writeStats(stats, statsPath);
}

/** Get the ISO date string for a Date in local time. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function computeStatsResponse(stats: StatsFile): StatsResponse {
  const now = new Date();
  const todayKey = localDateKey(now);

  // Start of this week (Monday)
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);

  // Start of this month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const today = emptyDay();
  const thisWeek = emptyDay();
  const thisMonth = emptyDay();
  const allTime = emptyDay();

  for (const [key, day] of Object.entries(stats.days)) {
    allTime.wallSeconds += day.wallSeconds;
    allTime.activeSeconds += day.activeSeconds;
    allTime.sessionCount += day.sessionCount;

    if (key === todayKey) {
      today.wallSeconds += day.wallSeconds;
      today.activeSeconds += day.activeSeconds;
      today.sessionCount += day.sessionCount;
    }

    const d = new Date(key + "T00:00:00");
    if (d >= weekStart) {
      thisWeek.wallSeconds += day.wallSeconds;
      thisWeek.activeSeconds += day.activeSeconds;
      thisWeek.sessionCount += day.sessionCount;
    }
    if (d >= monthStart) {
      thisMonth.wallSeconds += day.wallSeconds;
      thisMonth.activeSeconds += day.activeSeconds;
      thisMonth.sessionCount += day.sessionCount;
    }
  }

  // Compute streaks
  const sortedDays = Object.keys(stats.days).sort().reverse();
  let currentStreak = 0;
  let longestStreak = 0;
  let streak = 0;
  let expectedDate = new Date(now);

  // Current streak: count consecutive days ending today (or yesterday)
  for (const key of sortedDays) {
    const expected = localDateKey(expectedDate);
    if (key === expected) {
      currentStreak++;
      expectedDate.setDate(expectedDate.getDate() - 1);
    } else if (currentStreak === 0 && key === localDateKey(new Date(now.getTime() - 86400_000))) {
      // Allow streak to start from yesterday
      currentStreak = 1;
      expectedDate = new Date(now.getTime() - 86400_000);
      expectedDate.setDate(expectedDate.getDate() - 1);
    } else {
      break;
    }
  }

  // Longest streak: scan all days
  const allDaysSorted = Object.keys(stats.days).sort();
  for (let i = 0; i < allDaysSorted.length; i++) {
    if (i === 0) {
      streak = 1;
    } else {
      const prev = new Date(allDaysSorted[i - 1] + "T00:00:00");
      const curr = new Date(allDaysSorted[i] + "T00:00:00");
      const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86400_000);
      streak = diffDays === 1 ? streak + 1 : 1;
    }
    longestStreak = Math.max(longestStreak, streak);
  }

  return {
    today,
    thisWeek,
    thisMonth,
    allTime,
    currentStreak,
    longestStreak,
    badge: stats.badge ? { id: stats.badge.id, mode: stats.badge.mode, url: stats.badge.url } : undefined,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/stats.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/stats.ts server/stats.test.ts
git commit -m "feat(stats): add session stats aggregation with daily buckets and streaks"
```

---

### Task 4: Wire aggregation into session exit

**Files:**
- Modify: `server/session-store.ts:170-187` (markExited method)
- Modify: `server/pty-manager.ts:428-434` (markDead method)

- [ ] **Step 1: Import and call `aggregateSession` in `SessionStore.markExited`**

In `server/session-store.ts`, add the import at the top:

```typescript
import { aggregateSession } from "./stats.js";
```

In the `markExited` method, after the `this.emitChange()` call at line 187, add:

```typescript
    // Aggregate stats for the exited session
    const session = this.get(id);
    if (session) {
      aggregateSession(session);
    }
```

- [ ] **Step 2: Call `aggregateSession` in `PtyManager.markDead`**

In `server/pty-manager.ts`, add the import at the top:

```typescript
import { aggregateSession } from "./stats.js";
```

In the `markDead` method (~line 428-434), after `meta.exitedAt = Date.now();` and before the `writeFileSync`, add:

```typescript
    aggregateSession(meta);
```

- [ ] **Step 3: Test manually**

Start a session, let it run briefly, exit it. Check that `~/.relay-tty/stats.json` was created with the correct daily bucket.

Run: `cat ~/.relay-tty/stats.json`
Expected: JSON with a `days` entry for today, showing non-zero `wallSeconds` and `sessionCount`.

- [ ] **Step 4: Commit**

```bash
git add server/session-store.ts server/pty-manager.ts
git commit -m "feat(stats): aggregate session stats on exit"
```

---

### Task 5: Add `/api/stats` endpoint

**Files:**
- Modify: `server/api.ts`

- [ ] **Step 1: Add the stats endpoint**

In `server/api.ts`, add the import at the top alongside other imports:

```typescript
import { readStats, computeStatsResponse } from "./stats.js";
```

In the `createApiRouter` function, add a new route (before the final `return router`):

```typescript
  router.get("/stats", (_req, res) => {
    const stats = readStats();
    const response = computeStatsResponse(stats);
    res.json(response);
  });
```

- [ ] **Step 2: Test the endpoint**

Run: `curl -s http://localhost:7680/api/stats | jq .`
Expected: JSON response with `today`, `thisWeek`, `thisMonth`, `allTime`, `currentStreak`, `longestStreak` fields.

- [ ] **Step 3: Commit**

```bash
git add server/api.ts
git commit -m "feat(api): add GET /api/stats endpoint for usage stats"
```

---

### Task 6: Create the stats card component

**Files:**
- Create: `app/components/stats-card.tsx`

- [ ] **Step 1: Create the stats card component**

Create `app/components/stats-card.tsx`:

```tsx
import { useState } from "react";
import { Share2, X, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import type { StatsResponse } from "../../shared/types";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function StatRow({ label, wall, active, sessions }: { label: string; wall: number; active: number; sessions: number }) {
  if (sessions === 0) return null;
  return (
    <div className="flex items-baseline gap-3 text-sm font-mono">
      <span className="text-[#64748b] w-24 shrink-0">{label}</span>
      <span className="text-[#e2e8f0]">{formatDuration(wall)}</span>
      <span className="text-[#64748b]">connected</span>
      <span className="text-[#22c55e]">{formatDuration(active)}</span>
      <span className="text-[#64748b]">active</span>
      <span className="text-[#64748b] ml-auto">{sessions} sessions</span>
    </div>
  );
}

export function StatsCard({ stats }: { stats: StatsResponse }) {
  const [showShare, setShowShare] = useState(false);
  const [shareMode, setShareMode] = useState<"live" | "snapshot">("live");
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasAnyData = stats.allTime.sessionCount > 0;
  if (!hasAnyData) return null;

  async function handleShare() {
    setSharing(true);
    setError(null);
    try {
      const res = await fetch("/api/badge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: shareMode }),
      });
      if (!res.ok) throw new Error(await res.text());
      // Reload to show badge URL
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create badge");
    } finally {
      setSharing(false);
    }
  }

  async function handleStopSharing() {
    setSharing(true);
    try {
      await fetch("/api/badge", { method: "DELETE" });
      window.location.reload();
    } catch {
      setError("Failed to remove badge");
    } finally {
      setSharing(false);
    }
  }

  function copyBadgeUrl() {
    if (!stats.badge?.url) return;
    navigator.clipboard.writeText(stats.badge.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="bg-[#111118] border border-[#2d2d44] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#94a3b8] uppercase tracking-wider">Usage Stats</h3>
        {stats.badge ? (
          <div className="flex items-center gap-2">
            <button
              className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
              onClick={copyBadgeUrl}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              {copied ? <Check className="w-3.5 h-3.5 text-[#22c55e]" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <a
              href={stats.badge.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <button
              className="btn btn-ghost btn-xs text-[#ef4444] hover:text-[#f87171]"
              onClick={handleStopSharing}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              Stop sharing
            </button>
          </div>
        ) : (
          <button
            className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0] gap-1"
            onClick={() => setShowShare(true)}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
          >
            <Share2 className="w-3.5 h-3.5" />
            Share badge
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        <StatRow label="Today" wall={stats.today.wallSeconds} active={stats.today.activeSeconds} sessions={stats.today.sessionCount} />
        <StatRow label="This week" wall={stats.thisWeek.wallSeconds} active={stats.thisWeek.activeSeconds} sessions={stats.thisWeek.sessionCount} />
        <StatRow label="This month" wall={stats.thisMonth.wallSeconds} active={stats.thisMonth.activeSeconds} sessions={stats.thisMonth.sessionCount} />
        <StatRow label="All time" wall={stats.allTime.wallSeconds} active={stats.allTime.activeSeconds} sessions={stats.allTime.sessionCount} />
      </div>

      {(stats.currentStreak > 0 || stats.longestStreak > 0) && (
        <div className="flex gap-4 text-xs font-mono text-[#64748b] pt-1 border-t border-[#2d2d44]">
          {stats.currentStreak > 0 && <span>Current streak: <span className="text-[#f59e0b]">{stats.currentStreak}d</span></span>}
          {stats.longestStreak > 0 && <span>Longest: <span className="text-[#94a3b8]">{stats.longestStreak}d</span></span>}
        </div>
      )}

      {stats.badge && (
        <div className="text-xs font-mono text-[#64748b] pt-1 border-t border-[#2d2d44]">
          Badge: <span className="text-[#94a3b8]">{stats.badge.mode}</span> &middot;{" "}
          <code className="text-[#64748b] select-all">{stats.badge.url}</code>
        </div>
      )}

      {/* Share dialog */}
      {showShare && (
        <div className="border border-[#2d2d44] rounded-lg p-3 space-y-3 bg-[#0a0a0f]">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-[#e2e8f0]">Share your stats</span>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => setShowShare(false)}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              <X className="w-3.5 h-3.5 text-[#64748b]" />
            </button>
          </div>
          <p className="text-xs text-[#64748b]">
            This will share your connected time, active time, session count, and streak to a public badge URL at relaytty.com.
          </p>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="shareMode"
                className="radio radio-xs radio-primary"
                checked={shareMode === "live"}
                onChange={() => setShareMode("live")}
              />
              <span className="text-xs text-[#e2e8f0]">Keep badge updated automatically</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="shareMode"
                className="radio radio-xs radio-primary"
                checked={shareMode === "snapshot"}
                onChange={() => setShareMode("snapshot")}
              />
              <span className="text-xs text-[#e2e8f0]">One-time snapshot</span>
            </label>
          </div>
          {error && <p className="text-xs text-[#ef4444]">{error}</p>}
          <button
            className="btn btn-primary btn-sm w-full"
            onClick={handleShare}
            disabled={sharing}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
          >
            {sharing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create badge"}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/components/stats-card.tsx
git commit -m "feat(ui): add StatsCard component with share badge dialog"
```

---

### Task 7: Add stats card to home page

**Files:**
- Modify: `app/routes/home.tsx:21-24` (loader)
- Modify: `app/routes/home.tsx:86-87` (component props)
- Modify: `app/routes/home.tsx:168-213` (desktop layout)

- [ ] **Step 1: Update the loader to fetch stats**

In `app/routes/home.tsx`, add the imports at the top:

```typescript
import type { StatsResponse } from "../../shared/types";
import { StatsCard } from "../components/stats-card";
import { readStats, computeStatsResponse } from "../../server/stats";
```

Update the loader to compute stats directly (replace the existing loader):

```typescript
export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  let stats: StatsResponse | null = null;
  try {
    stats = computeStatsResponse(readStats());
  } catch {}
  return { sessions, version: context.version, hostname: context.hostname, stats };
}
```

- [ ] **Step 2: Render the StatsCard in the desktop layout**

In the `Home` component, destructure `stats` from loaderData:

```typescript
const { sessions: realSessions, stats } = loaderData as { sessions: Session[]; version: string; hostname: string; stats: StatsResponse | null };
```

In the desktop layout section, add the StatsCard below the phone frame container. Replace the existing `sessions.length === 0` ternary block and the phone frame block (~lines 182-199) with:

```tsx
      {sessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <QuickLaunch />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-4">
          <div className="flex-1 min-h-0">
            {previewSessionId ? (
              <PhoneFrame
                key={previewSessionId}
                session={sessions.find((s) => s.id === previewSessionId)!}
                onNavigate={(id) => navigate(`/sessions/${id}`)}
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-[#64748b] font-mono text-sm">Select a session</p>
              </div>
            )}
          </div>
          {stats && stats.allTime.sessionCount > 0 && (
            <div className="w-80 shrink-0 hidden xl:block">
              <StatsCard stats={stats} />
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 3: Verify it renders**

Run `npm run dev`, open `http://localhost:7680` on desktop. The stats card should appear to the right of the phone frame if there's usage data.

- [ ] **Step 4: Commit**

```bash
git add app/routes/home.tsx
git commit -m "feat(ui): add stats card to home page desktop layout"
```

---

### Task 8: Add badge proxy endpoints to server API

**Files:**
- Modify: `server/api.ts`
- Modify: `server/stats.ts`

- [ ] **Step 1: Add badge save/delete helpers to stats.ts**

In `server/stats.ts`, add these functions:

```typescript
export function saveBadge(badge: StatsFile["badge"], statsPath = DEFAULT_STATS_PATH): void {
  const stats = readStats(statsPath);
  stats.badge = badge;
  writeStats(stats, statsPath);
}

export function removeBadge(statsPath = DEFAULT_STATS_PATH): StatsFile["badge"] | undefined {
  const stats = readStats(statsPath);
  const badge = stats.badge;
  delete stats.badge;
  writeStats(stats, statsPath);
  return badge;
}

export function getBadge(statsPath = DEFAULT_STATS_PATH): StatsFile["badge"] | undefined {
  return readStats(statsPath).badge;
}
```

- [ ] **Step 2: Add badge proxy endpoints to api.ts**

In `server/api.ts`, update the stats import:

```typescript
import { readStats, computeStatsResponse, saveBadge, removeBadge, getBadge } from "./stats.js";
```

Add these routes in the `createApiRouter` function:

```typescript
  const BADGE_API_BASE = "https://relaytty.com/api/badge";

  router.post("/badge", async (req, res) => {
    const { mode } = req.body as { mode: "live" | "snapshot" };
    if (mode !== "live" && mode !== "snapshot") {
      res.status(400).json({ error: "mode must be 'live' or 'snapshot'" });
      return;
    }
    const stats = readStats();
    const response = computeStatsResponse(stats);
    try {
      const upstream = await fetch(BADGE_API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stats: response, mode }),
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: await upstream.text() });
        return;
      }
      const { id, token, url } = (await upstream.json()) as { id: string; token: string; url: string };
      saveBadge({ id, token, mode, url });
      res.json({ id, url, mode });
    } catch (err) {
      res.status(502).json({ error: "Failed to reach badge service" });
    }
  });

  router.delete("/badge", async (_req, res) => {
    const badge = removeBadge();
    if (!badge) {
      res.status(404).json({ error: "No badge configured" });
      return;
    }
    try {
      await fetch(`${BADGE_API_BASE}/${badge.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${badge.token}` },
      });
    } catch {
      // Best effort — badge may already be gone
    }
    res.json({ ok: true });
  });
```

- [ ] **Step 3: Add live sync call to aggregateSession**

In `server/stats.ts`, add a function to sync badge stats and call it from `aggregateSession`:

```typescript
async function syncBadge(stats: StatsFile): Promise<void> {
  if (!stats.badge || stats.badge.mode !== "live") return;
  const response = computeStatsResponse(stats);
  try {
    await fetch(`https://relaytty.com/api/badge/${stats.badge.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${stats.badge.token}`,
      },
      body: JSON.stringify({ stats: response }),
    });
  } catch {
    // Fire and forget — next session exit will retry
  }
}
```

At the end of `aggregateSession`, after `writeStats(stats, statsPath)`, add:

```typescript
  // Fire-and-forget badge sync
  syncBadge(stats);
```

- [ ] **Step 4: Commit**

```bash
git add server/stats.ts server/api.ts
git commit -m "feat(api): add badge create/delete proxy endpoints with live sync"
```

---

### Task 9: Create Cloudflare Worker for badge service

**Files:**
- Create: `worker/badge/wrangler.toml`
- Create: `worker/badge/src/index.ts`
- Create: `worker/badge/schema.sql`
- Create: `worker/badge/package.json`
- Create: `worker/badge/tsconfig.json`

- [ ] **Step 1: Create worker directory and config**

Create `worker/badge/package.json`:

```json
{
  "name": "relay-tty-badge",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^3.0.0",
    "@cloudflare/workers-types": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

Create `worker/badge/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

Create `worker/badge/wrangler.toml`:

```toml
name = "relay-tty-badge"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "relay-tty-badges"
database_id = "" # Fill after `wrangler d1 create relay-tty-badges`
```

- [ ] **Step 2: Create D1 schema**

Create `worker/badge/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS badges (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'snapshot')),
  stats TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

- [ ] **Step 3: Create the Worker**

Create `worker/badge/src/index.ts`:

```typescript
interface Env {
  DB: D1Database;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function renderBadgeSvg(stats: { allTime: { wallSeconds: number; activeSeconds: number } }): string {
  const connectedHours = Math.floor(stats.allTime.wallSeconds / 3600);
  const activeHours = Math.floor(stats.allTime.activeSeconds / 3600);

  const label = "relay-tty";
  const connected = `${connectedHours}h connected`;
  const active = `${activeHours}h active`;
  const value = `${connected} \u00B7 ${active}`;

  // Approximate character widths for the font
  const labelWidth = label.length * 7.2 + 16;
  const valueWidth = value.length * 6.5 + 16;
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#1a1a2e"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#22c55e"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelWidth / 2}" y="14" fill="#e2e8f0">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="#fff">${value}</text>
  </g>
</svg>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // POST /api/badge — create badge
    if (method === "POST" && url.pathname === "/api/badge") {
      const body = (await request.json()) as { stats: unknown; mode: string };
      const id = randomHex(4);
      const token = randomHex(16);
      const mode = body.mode === "snapshot" ? "snapshot" : "live";

      await env.DB.prepare(
        "INSERT INTO badges (id, token, mode, stats) VALUES (?, ?, ?, ?)"
      )
        .bind(id, token, mode, JSON.stringify(body.stats))
        .run();

      return json({ id, token, url: `https://relaytty.com/badge/${id}` }, 201);
    }

    // GET /badge/:id — render SVG
    const badgeMatch = url.pathname.match(/^\/badge\/([a-f0-9]+)$/);
    if (method === "GET" && badgeMatch) {
      const id = badgeMatch[1];
      const row = await env.DB.prepare("SELECT stats FROM badges WHERE id = ?")
        .bind(id)
        .first<{ stats: string }>();

      if (!row) {
        return new Response("Not found", { status: 404 });
      }

      const stats = JSON.parse(row.stats);
      const svg = renderBadgeSvg(stats);
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=300",
          ...corsHeaders(),
        },
      });
    }

    // PUT /api/badge/:id — update stats
    const updateMatch = url.pathname.match(/^\/api\/badge\/([a-f0-9]+)$/);
    if (method === "PUT" && updateMatch) {
      const id = updateMatch[1];
      const auth = request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const row = await env.DB.prepare("SELECT token FROM badges WHERE id = ?")
        .bind(id)
        .first<{ token: string }>();

      if (!row) return json({ error: "Not found" }, 404);
      if (row.token !== auth) return json({ error: "Unauthorized" }, 401);

      const body = (await request.json()) as { stats: unknown };
      await env.DB.prepare(
        "UPDATE badges SET stats = ?, updated_at = unixepoch() WHERE id = ?"
      )
        .bind(JSON.stringify(body.stats), id)
        .run();

      return json({ ok: true });
    }

    // DELETE /api/badge/:id — revoke badge
    const deleteMatch = url.pathname.match(/^\/api\/badge\/([a-f0-9]+)$/);
    if (method === "DELETE" && deleteMatch) {
      const id = deleteMatch[1];
      const auth = request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const row = await env.DB.prepare("SELECT token FROM badges WHERE id = ?")
        .bind(id)
        .first<{ token: string }>();

      if (!row) return json({ error: "Not found" }, 404);
      if (row.token !== auth) return json({ error: "Unauthorized" }, 401);

      await env.DB.prepare("DELETE FROM badges WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add worker/badge/
git commit -m "feat(worker): add Cloudflare Worker badge service with D1"
```

---

### Task 10: Update documentation

**Files:**
- Modify: docs site (relevant reference pages)

- [ ] **Step 1: Document stats.json format**

Add documentation for the `stats.json` file format to the docs site, explaining:
- File location: `~/.relay-tty/stats.json`
- Daily bucket structure
- How wall-clock and active time are calculated
- Badge configuration fields

Check the docs-site skill for the appropriate location and format conventions.

- [ ] **Step 2: Document the badge feature**

Add a how-to page or section covering:
- How to share your badge
- Live vs snapshot mode
- How to stop sharing
- Example badge embed markdown: `![relay-tty](https://relaytty.com/badge/<id>)`

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: add usage stats and shareable badge documentation"
```
