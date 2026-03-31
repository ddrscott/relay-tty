# Usage Stats & Shareable Badge

**Date**: 2026-03-30
**Status**: Design

## Overview

Track cumulative relay-tty usage (wall-clock time and active time) per day, display stats in the web UI, and let users opt in to a shareable badge hosted at `relaytty.com/badge/<id>`.

## Goals

- Track total connected time and active terminal time with daily granularity
- Display stats on the home page (today / week / month / all-time + streaks)
- Let users share a badge via explicit opt-in (live auto-sync or one-time snapshot)
- Never send data without user consent

## Non-Goals (v1)

- CLI `relay stats` command (users can read `stats.json` directly)
- Badges with titles/ranks/gamification (future layer on top of this data)
- Per-session time breakdowns in the UI
- Heatmaps or contribution graphs (future, data model supports it)

---

## Data Layer

### Rust pty-host: `activeSeconds` Counter

Add `active_seconds: f64` to `SessionMeta`, serialized as `activeSeconds` in the session JSON.

In the existing 1-second metrics loop, after computing `bps1`:

```rust
if bps1 >= 1.0 {
    self.meta.active_seconds += 1.0;
}
```

Backward compat: `#[serde(default)]` in Rust, `activeSeconds?: number` in TypeScript (defaults to 0).

No new timers, IPC, or messages. Written to disk on the existing 5-second flush cycle and on exit.

### Server Aggregation: `stats.json`

**File**: `~/.relay-tty/stats.json`

```json
{
  "days": {
    "2026-03-30": {
      "wallSeconds": 14400,
      "activeSeconds": 3200,
      "sessionCount": 5
    }
  },
  "aggregatedIds": ["a1b2c3d4", "e5f6a7b8"],
  "badge": {
    "id": "abc123",
    "token": "secret-token",
    "mode": "live",
    "url": "https://relaytty.com/badge/abc123"
  }
}
```

**Fields**:
- `days` — daily buckets keyed by ISO date (`YYYY-MM-DD`)
  - `wallSeconds` — sum of `(exitedAt - createdAt) / 1000` for sessions exiting that day
  - `activeSeconds` — sum of `activeSeconds` from those sessions
  - `sessionCount` — number of sessions that exited that day
- `aggregatedIds` — array of session IDs already rolled up (prevents double-counting on server restart). Cap at 200 entries; when exceeded, drop the oldest half (insertion order).
- `badge` — opt-in sharing config (absent until user opts in)

**Trigger**: Called from SessionStore when a session's status transitions to `"exited"` or when `markDead()` detects a crashed process.

**Logic**:
1. Read `~/.relay-tty/stats.json` (create with `{ "days": {}, "aggregatedIds": [] }` if missing)
2. Check `aggregatedIds` — skip if session already aggregated
3. Compute exit day: `new Date(session.exitedAt).toISOString().slice(0, 10)`
4. Add `wallSeconds`: `Math.floor((exitedAt - createdAt) / 1000)`
5. Add `activeSeconds`: `session.activeSeconds ?? 0`
6. Increment `sessionCount`
7. Push session ID to `aggregatedIds`
8. Atomic write (write `.tmp`, rename)
9. If `badge.mode === "live"`, POST updated stats to Worker (see Auto-sync below)

**Edge cases**:
- No `exitedAt`: use `lastActivity` as fallback, or skip aggregation
- No `activeSeconds`: default to 0 (backward compat with pre-feature sessions)
- Server down during exit: session JSON survives ~1 hour on disk; picked up on next discovery/restart

### Stats API

**Endpoint**: `GET /api/stats`

Reads `stats.json`, computes rollups:

```json
{
  "today": { "wallSeconds": 3600, "activeSeconds": 1200, "sessionCount": 3 },
  "thisWeek": { "wallSeconds": 18000, "activeSeconds": 5400, "sessionCount": 15 },
  "thisMonth": { "wallSeconds": 72000, "activeSeconds": 21000, "sessionCount": 80 },
  "allTime": { "wallSeconds": 284000, "activeSeconds": 61000, "sessionCount": 583 },
  "currentStreak": 12,
  "longestStreak": 34,
  "badge": { "id": "abc123", "mode": "live", "url": "https://relaytty.com/badge/abc123" }
}
```

**Streak calculation**: A day counts toward the streak if `sessionCount >= 1`. Consecutive days with at least one session = streak. Computed by iterating daily keys in reverse chronological order.

---

## Web UI

### Stats Card (Home Page)

A card on the home page (`/`) showing cumulative usage.

**Display**:
| Period     | Connected    | Active      | Sessions |
|------------|-------------|-------------|----------|
| Today      | 2h 15m      | 38m         | 3        |
| This week  | 18h 42m     | 4h 12m      | 27       |
| This month | 72h 30m     | 16h 5m      | 142      |
| All time   | 284h 10m    | 61h 22m     | 583      |

Current streak: 12 days | Longest streak: 34 days

**Data**: Fetched via React Router loader from `GET /api/stats`. No live updates needed — stats change only on session exit.

### Share Button

A "Share Badge" button on the stats card.

**Flow**:
1. User clicks "Share Badge"
2. Dialog opens explaining exactly what will be shared: connected time, active time, session count, streak
3. User chooses sharing mode:
   - **"Keep my badge updated automatically"** — live mode, stats pushed on each session exit
   - **"Share a one-time snapshot"** — current stats only, never updated
4. On confirm: POST to `https://relaytty.com/api/badge` with stats payload
5. Worker stores in D1, returns `{ id, token }`
6. Save `id`, `token`, `mode` to `stats.json` under `badge` key
7. Display badge URL and a preview of the SVG
8. User can copy URL or the markdown embed snippet

### Stop Sharing / Update

- If badge exists, show "Stop Sharing" button → sends `DELETE /api/badge/<id>` with token, removes `badge` from `stats.json`
- If mode is "snapshot", show "Update Badge" button → sends `PUT` with current stats
- If mode is "live", show current sync status

---

## Worker (relaytty.com)

### D1 Schema

```sql
CREATE TABLE badges (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'snapshot')),
  stats TEXT NOT NULL,  -- JSON blob
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

`stats` column stores the same rollup structure as the `/api/stats` response (today/week/month/allTime/streaks).

### Endpoints

**`POST /api/badge`** — Create badge
- Body: `{ stats, mode }`
- Generates random ID (8 hex chars) and token (32 hex chars)
- Inserts into D1
- Returns: `{ id, token, url }`

**`GET /badge/<id>`** — Render SVG badge
- Queries D1 for stats
- Returns an SVG showing connected time and active time (shields.io flat style)
- Cache headers: `Cache-Control: public, max-age=300` (5 min)
- 404 if ID not found

**`PUT /api/badge/<id>`** — Update stats
- Header: `Authorization: Bearer <token>`
- Body: `{ stats }`
- Updates `stats` and `updated_at` in D1
- 401 if token mismatch, 404 if not found

**`DELETE /api/badge/<id>`** — Revoke badge
- Header: `Authorization: Bearer <token>`
- Deletes row from D1
- 401 if token mismatch, 404 if not found

### SVG Badge Format

Shields.io flat style. Example:

```
[relay-tty | 284h connected | 61h active]
```

Rendered as inline SVG with relay-tty brand colors. Cached at the edge for 5 minutes.

---

## Auto-sync (Live Mode)

When `badge.mode === "live"` in `stats.json`:

1. After aggregating a session's stats (in the aggregation function), check for `badge` config
2. If present and mode is `"live"`, compute fresh rollups and `PUT /api/badge/<id>` with the token
3. Fire-and-forget — log errors but don't block aggregation
4. No retry logic needed; next session exit will push fresh data anyway

---

## Documentation

- Document `stats.json` format and location in docs for power users
- Update any relevant reference pages for the new `/api/stats` endpoint
- Document the badge feature in a how-to or feature page

---

## TypeScript Type Changes

```typescript
// Add to Session interface in shared/types.ts
activeSeconds?: number;

// New types for stats
interface DayStats {
  wallSeconds: number;
  activeSeconds: number;
  sessionCount: number;
}

interface StatsFile {
  days: Record<string, DayStats>;
  aggregatedIds: string[];
  badge?: {
    id: string;
    token: string;
    mode: "live" | "snapshot";
    url: string;
  };
}

interface StatsResponse {
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
