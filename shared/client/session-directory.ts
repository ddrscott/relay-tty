/**
 * A SessionDirectory answers "what sessions exist and what state are they
 * in" and pushes changes. Two implementations: disk (watch
 * ~/.relay-tty/sessions, Node only) and remote (HTTP API plus /ws/events).
 * Consumers never care which one they hold.
 */
import type { Session } from "../types.js";

export type DirectoryEvent =
  | { type: "created"; session: Session }
  | { type: "updated"; session: Session; changed: (keyof Session)[] }
  | { type: "exited"; session: Session }
  | { type: "removed"; id: string };

export interface SessionDirectory {
  /** Running sessions, newest first. */
  list(): Promise<Session[]>;
  get(id: string): Promise<Session | null>;
  /** Push changes. Returns an unsubscribe function. */
  subscribe(cb: (e: DirectoryEvent) => void): () => void;
  close(): void;
}

/** Field-by-field diff used by both directory implementations. */
export function changedFields(prev: Session, next: Session): (keyof Session)[] {
  const keys = new Set<keyof Session>([...Object.keys(prev), ...Object.keys(next)] as (keyof Session)[]);
  const out: (keyof Session)[] = [];
  for (const k of keys) {
    if (k === "id") continue;
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) out.push(k);
  }
  return out;
}

/**
 * Reconcile a known map against a fresh snapshot and emit the right events.
 * Shared by both implementations so the event semantics cannot drift.
 */
export function reconcileSnapshot(
  known: Map<string, Session>,
  snapshot: Session[],
  emit: (e: DirectoryEvent) => void,
): void {
  const seen = new Set<string>();
  for (const next of snapshot) {
    seen.add(next.id);
    reconcileOne(known, next.id, next, emit);
  }
  for (const id of [...known.keys()]) {
    if (!seen.has(id)) reconcileOne(known, id, null, emit);
  }
}

/** Reconcile one session (null means it is gone). */
export function reconcileOne(
  known: Map<string, Session>,
  id: string,
  next: Session | null,
  emit: (e: DirectoryEvent) => void,
): void {
  const prev = known.get(id);
  if (!next) {
    if (prev) {
      known.delete(id);
      emit({ type: "removed", id });
    }
    return;
  }
  known.set(id, next);
  if (!prev) {
    emit({ type: "created", session: next });
    return;
  }
  if (prev.status === "running" && next.status === "exited") {
    emit({ type: "exited", session: next });
    return;
  }
  const changed = changedFields(prev, next);
  if (changed.length) emit({ type: "updated", session: next, changed });
}
