import { useEffect, useRef } from "react";
import type { Session } from "../../shared/types";
import {
  filterByProject,
  filterByRecency,
  setStoredProjectFilter,
  setStoredRecencyFilter,
  type RecencyFilter,
} from "../components/project-filter";

/**
 * Cross-tree "reveal a session" channel.
 *
 * The sidebar lives in `root.tsx` while the multi-session views (grid, lanes,
 * tiles) are child routes, so the sidebar cannot call into them directly. A
 * view registers a handler while it is mounted; the sidebar asks the registry
 * to reveal a session and falls back to navigation when nothing is registered
 * or the handler declines. Same shape as `sidebar-toggle.ts`.
 */
export type SessionRevealHandler = (sessionId: string) => boolean;

let handler: SessionRevealHandler | null = null;

/** Register the reveal handler for the currently mounted view. */
export function registerSessionRevealHandler(next: SessionRevealHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * Ask the mounted view to reveal a session. Returns false when no view is
 * registered, or when the view declined (e.g. it does not know the session),
 * so the caller can navigate instead.
 */
export function revealSession(sessionId: string): boolean {
  if (!handler) return false;
  return handler(sessionId) === true;
}

/**
 * Register a reveal handler for the lifetime of the component. The latest
 * callback is always used, so callers do not need a stable identity.
 */
export function useSessionReveal(onReveal: SessionRevealHandler): void {
  const ref = useRef(onReveal);
  ref.current = onReveal;
  useEffect(() => registerSessionRevealHandler((id) => ref.current(id)), []);
}

/** Filter state shared by the grid, lanes and tiles views. */
export interface RevealFilterState {
  showInactive: boolean;
  recency: RecencyFilter;
  projectFilter: string[];
}

/**
 * Work out the smallest change to the filter state that makes `session`
 * visible. Returns null when nothing is hiding it, so a filter the user set on
 * purpose is only touched when it is the one doing the hiding.
 */
export function relaxFiltersForSession(
  session: Session,
  state: RevealFilterState
): Partial<RevealFilterState> | null {
  const patch: Partial<RevealFilterState> = {};

  if (!state.showInactive && session.status !== "running") {
    patch.showInactive = true;
  }
  if (filterByRecency([session], state.recency).length === 0) {
    patch.recency = { ...state.recency, enabled: false };
  }
  if (filterByProject([session], state.projectFilter).length === 0) {
    // Widen the project selection to include this session's project rather
    // than clearing it. A session with no cwd can only be shown by clearing.
    patch.projectFilter = session.cwd
      ? [...state.projectFilter, session.cwd]
      : [];
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/** Persist whichever parts of a relaxation patch have their own storage. */
export function persistRelaxation(patch: Partial<RevealFilterState>): void {
  if (patch.recency) setStoredRecencyFilter(patch.recency);
  if (patch.projectFilter) setStoredProjectFilter(patch.projectFilter);
}
