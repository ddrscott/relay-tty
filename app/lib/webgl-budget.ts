/**
 * Deterministic WebGL context budgeting for gallery terminal cells.
 *
 * Browsers cap active WebGL contexts at ~16 per page. Loading a WebglAddon
 * for every gallery cell means the 17th context evicts the oldest ("Oldest
 * context will be lost"), the addon silently falls back to xterm's DOM
 * renderer, and WHICH cells lose WebGL is effectively random. A DOM-rendered
 * cell rebuilds row <span>s on every dirty write — thousands of DOM
 * mutations per second for a busy TUI.
 *
 * This module replaces that context-loss roulette with a deterministic
 * budget: gallery cells register here instead of loading WebglAddon at init,
 * and the top-N cells by priority are granted a context. Priority is recent
 * output activity (most recently active wins); the selected/zoomed cell is
 * "pinned" and always outranks activity.
 *
 * Only gallery cells (webglMode: 'budgeted' in useTerminalCore) participate.
 * Main session view, tiles, share view, and the expand modal keep loading
 * WebGL unconditionally — MAX_GALLERY_WEBGL leaves headroom for them under
 * the ~16 browser cap.
 *
 * Rebalancing runs on a coarse 2s interval (plus register/unregister/pin) —
 * never per DATA frame. Revocation has 5s hysteresis so two cells
 * alternating output don't thrash contexts (each grant compiles shaders and
 * uploads a texture atlas — churn is worse than a briefly suboptimal mix).
 */

/** Max simultaneous WebGL contexts granted to gallery cells. */
export const MAX_GALLERY_WEBGL = 8;

/** Rebalance cadence while any cell is registered. */
const REBALANCE_INTERVAL_MS = 2000;

/** A granted cell keeps its context until it has been outprioritized this long. */
const REVOKE_HYSTERESIS_MS = 5000;

export interface WebglBudgetHandlers {
  /** Load a WebglAddon into the cell's terminal. Must be idempotent. */
  acquire: () => void;
  /** Dispose the cell's WebglAddon (reverts to DOM renderer). Must be idempotent. */
  release: () => void;
}

interface BudgetEntry extends WebglBudgetHandlers {
  id: string;
  /** Timestamp of the most recent output activity (registration counts). */
  lastActivity: number;
  /** Pinned cells (selected/zoomed) always outrank activity. */
  pinned: boolean;
  granted: boolean;
  /**
   * Timestamp when this granted entry first fell out of the top-N.
   * 0 = currently wanted (hysteresis clock not running).
   */
  outprioritizedSince: number;
}

const entries = new Map<string, BudgetEntry>();
let rebalanceTimer: ReturnType<typeof setInterval> | null = null;

function effectivePriority(e: BudgetEntry): number {
  return e.pinned ? Infinity : e.lastActivity;
}

function countGranted(): number {
  let n = 0;
  for (const e of entries.values()) if (e.granted) n++;
  return n;
}

function grant(e: BudgetEntry) {
  e.granted = true;
  e.outprioritizedSince = 0;
  try { e.acquire(); } catch {}
}

function revoke(e: BudgetEntry) {
  e.granted = false;
  e.outprioritizedSince = 0;
  try { e.release(); } catch {}
}

function rebalance() {
  const now = Date.now();
  // `|| 0` guards the Infinity - Infinity = NaN case (two pinned cells).
  const sorted = [...entries.values()].sort(
    (a, b) => (effectivePriority(b) - effectivePriority(a)) || 0
  );
  const wanted = new Set(sorted.slice(0, MAX_GALLERY_WEBGL));

  // Revoke pass: granted entries outside the top-N lose their context only
  // after the hysteresis window; entries back in the top-N reset the clock.
  for (const e of entries.values()) {
    if (!e.granted) continue;
    if (wanted.has(e)) {
      e.outprioritizedSince = 0;
    } else if (e.outprioritizedSince === 0) {
      e.outprioritizedSince = now;
    } else if (now - e.outprioritizedSince >= REVOKE_HYSTERESIS_MS) {
      revoke(e);
    }
  }

  // Grant pass: highest priority first, never exceeding the budget.
  // Hysteresis-held losers can occupy slots; ordinary challengers wait for
  // the hold to expire (≤5s), but a pinned cell (user is looking at it)
  // force-evicts the lowest-priority held context immediately.
  for (const e of wanted) {
    if (e.granted) continue;
    if (countGranted() >= MAX_GALLERY_WEBGL) {
      if (!e.pinned) continue;
      let victim: BudgetEntry | null = null;
      for (const g of entries.values()) {
        if (!g.granted || wanted.has(g)) continue;
        if (!victim || effectivePriority(g) < effectivePriority(victim)) victim = g;
      }
      if (!victim) continue; // budget fully held by wanted entries
      revoke(victim);
    }
    grant(e);
  }
}

function ensureTimer() {
  if (rebalanceTimer || entries.size === 0) return;
  rebalanceTimer = setInterval(rebalance, REBALANCE_INTERVAL_MS);
}

function stopTimerIfIdle() {
  if (entries.size > 0 || !rebalanceTimer) return;
  clearInterval(rebalanceTimer);
  rebalanceTimer = null;
}

export const webglBudget = {
  /**
   * Register a gallery cell. May synchronously call `acquire` if a context
   * is available. The cell starts unpinned with activity = now.
   */
  register(id: string, handlers: WebglBudgetHandlers): void {
    entries.set(id, {
      id,
      ...handlers,
      lastActivity: Date.now(),
      pinned: false,
      granted: false,
      outprioritizedSince: 0,
    });
    ensureTimer();
    rebalance();
  },

  /**
   * Remove a cell from the budget. Does NOT call `release` — the caller's
   * cleanup path owns addon disposal. Frees the slot for other cells.
   */
  unregister(id: string): void {
    if (!entries.delete(id)) return;
    stopTimerIfIdle();
    if (entries.size > 0) rebalance();
  },

  /**
   * Record output activity for a cell. Cheap (map lookup + assignment) but
   * deliberately does NOT rebalance — callers may invoke this per DATA
   * frame; the interval tick picks up the new ordering.
   */
  bumpActivity(id: string): void {
    const e = entries.get(id);
    if (e) e.lastActivity = Date.now();
  },

  /**
   * Pin/unpin a cell (selected or zoomed — the user is actively looking at
   * it). Pinned cells get Infinity priority; pinning rebalances immediately
   * so the grant lands without waiting for the next tick.
   */
  setPinned(id: string, pinned: boolean): void {
    const e = entries.get(id);
    if (!e || e.pinned === pinned) return;
    e.pinned = pinned;
    if (pinned) rebalance();
    // Unpinning: no urgency — the next interval tick demotes it naturally.
  },

  /**
   * Notify that a granted cell's context was lost by the browser (the addon
   * is already disposed by its onContextLoss handler). Marks the slot free;
   * the next interval tick re-grants — deliberately not immediate, so a
   * page-wide context shortage can't cause a tight grant/loss loop.
   */
  contextLost(id: string): void {
    const e = entries.get(id);
    if (!e) return;
    e.granted = false;
    e.outprioritizedSince = 0;
  },
};
