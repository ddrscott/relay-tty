/**
 * IndexedDB-backed cache for terminal output buffers.
 *
 * Stores raw terminal bytes keyed by session ID alongside the server byte
 * offset so the browser can RESUME from cache on page reload / new tab.
 *
 * Design choices:
 *   - IndexedDB over localStorage (no 5MB limit, async, doesn't block UI)
 *   - Raw bytes, not parsed xterm state — works with existing replay path
 *   - Batched writes (flush every 1s or 64KB) to avoid thrashing IndexedDB
 *   - 10MB cap per session (matches server-side ring buffer)
 *   - 24h TTL with eviction on open
 */

const DB_NAME = "relay-tty-buffer-cache";
const DB_VERSION = 1;
const STORE_NAME = "buffers";
const MAX_SIZE = 10 * 1024 * 1024; // 10MB per session
const FLUSH_INTERVAL = 1000; // 1s
const FLUSH_SIZE = 64 * 1024; // 64KB
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  sessionId: string;
  buffer: ArrayBuffer;
  byteOffset: number;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
      }
    };

    req.onsuccess = () => {
      resolve(req.result);
      // Evict stale entries in the background
      evictStale(req.result).catch(() => {});
    };

    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

/** Remove entries older than TTL_MS. */
async function evictStale(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const req = store.openCursor();
  const cutoff = Date.now() - TTL_MS;

  return new Promise((resolve) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      const entry = cursor.value as CacheEntry;
      if (entry.updatedAt < cutoff) {
        cursor.delete();
      }
      cursor.continue();
    };
    req.onerror = () => resolve();
  });
}

/** Load a cached buffer for a session. Returns null if not found or corrupt. */
export async function loadCache(
  sessionId: string
): Promise<{ buffer: Uint8Array; byteOffset: number } | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);

    return new Promise((resolve) => {
      const req = store.get(sessionId);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry | undefined;
        if (!entry || !entry.buffer || entry.byteOffset <= 0) {
          resolve(null);
          return;
        }
        // Check TTL
        if (Date.now() - entry.updatedAt > TTL_MS) {
          resolve(null);
          return;
        }
        resolve({
          buffer: new Uint8Array(entry.buffer),
          byteOffset: entry.byteOffset,
        });
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Delete a session's cache (e.g. on exit). */
export async function deleteCache(sessionId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(sessionId);
  } catch {
    // non-critical
  }
}

/**
 * Accumulator that batches writes to IndexedDB.
 *
 * Collects incoming DATA chunks in memory and flushes to IndexedDB
 * periodically (every 1s or 64KB, whichever comes first).
 *
 * The stored buffer is a capped ring: when it exceeds MAX_SIZE, the
 * oldest bytes are discarded (we keep the tail).
 */
export class BufferCacheWriter {
  private sessionId: string;
  private chunks: Uint8Array[] = [];
  private pendingSize = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentBuffer: Uint8Array | null = null;
  private currentOffset = 0;
  private disposed = false;

  constructor(sessionId: string, initial?: { buffer: Uint8Array; byteOffset: number }) {
    this.sessionId = sessionId;
    if (initial) {
      this.currentBuffer = initial.buffer;
      this.currentOffset = initial.byteOffset;
    }
  }

  /** Append incoming DATA payload (raw terminal bytes, no WS_MSG prefix). */
  append(data: Uint8Array): void {
    if (this.disposed) return;
    this.chunks.push(data);
    this.pendingSize += data.length;

    if (this.pendingSize >= FLUSH_SIZE) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, FLUSH_INTERVAL);
    }
  }

  /** Update the authoritative byte offset (from SYNC message). */
  setOffset(offset: number): void {
    this.currentOffset = offset;
  }

  /** Flush pending chunks to IndexedDB. */
  private flush(): void {
    if (this.disposed || this.chunks.length === 0) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Merge pending chunks
    const totalPending = this.pendingSize;
    const merged = new Uint8Array(totalPending);
    let pos = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, pos);
      pos += chunk.length;
    }
    this.chunks = [];
    this.pendingSize = 0;

    // Combine with existing buffer
    const existing = this.currentBuffer;
    let combined: Uint8Array;
    if (existing && existing.length > 0) {
      combined = new Uint8Array(existing.length + merged.length);
      combined.set(existing, 0);
      combined.set(merged, existing.length);
    } else {
      combined = merged;
    }

    // Cap to MAX_SIZE — keep tail
    if (combined.length > MAX_SIZE) {
      combined = combined.slice(combined.length - MAX_SIZE);
    }

    this.currentBuffer = combined;

    // Write to IndexedDB (fire-and-forget)
    const entry: CacheEntry = {
      sessionId: this.sessionId,
      buffer: combined.buffer.slice(
        combined.byteOffset,
        combined.byteOffset + combined.byteLength
      ),
      byteOffset: this.currentOffset,
      updatedAt: Date.now(),
    };

    writeEntry(entry).catch(() => {});
  }

  /** Force a final flush and stop the writer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flush();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

async function writeEntry(entry: CacheEntry): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(entry);
  } catch {
    // IndexedDB write failed — non-critical, graceful degradation
  }
}
