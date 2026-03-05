/**
 * Horizontal swipe gesture for session carousel navigation.
 *
 * Detects horizontal swipes on the terminal area and navigates between
 * sessions with inertia — a fast flick carries through multiple sessions.
 *
 * Coexists with:
 * - Vertical terminal scrolling (use-terminal-core.ts touchmove handler)
 * - Pinch-to-zoom (2-finger gesture in use-terminal-core.ts)
 * - Text selection mode
 *
 * Strategy: attach to the terminal area wrapper at capture phase. On
 * touchstart, record position but don't intercept. On touchmove, once
 * horizontal displacement exceeds the threshold (and is greater than
 * vertical), commit to swipe mode and preventDefault + stopPropagation
 * to block xterm's vertical scroll handler.
 */
import { useEffect, useRef } from "react";

/** Minimum horizontal px before committing to a swipe */
const H_THRESHOLD = 30;
/** Horizontal must exceed vertical by this ratio to be a swipe (not scroll) */
const HV_RATIO = 1.5;
/** Width of a "virtual page" for calculating session switches */
const PAGE_WIDTH = 250;
/** Friction applied per 16ms frame during inertia */
const FRICTION = 0.92;
/** Minimum velocity (px/16ms) to keep animating */
const MIN_VELOCITY = 0.5;
/** Snap animation duration (ms) */
const SNAP_DURATION = 200;

interface CarouselSwipeOpts {
  /** All session IDs in order */
  sessionIds: string[];
  /** Currently active session ID */
  activeId: string;
  /** Navigate to a session */
  goTo: (id: string) => void;
  /** Whether swipe is enabled (disable during text selection, etc.) */
  enabled?: boolean;
}

export function useCarouselSwipe(
  containerRef: React.RefObject<HTMLElement | null>,
  opts: CarouselSwipeOpts,
) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Swipe visual offset exposed for the container's translateX
  const offsetRef = useRef(0);
  // Animation frame ID for cleanup
  const rafRef = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let committed = false;  // true once we've decided this is a horizontal swipe
    let rejected = false;   // true once we've decided this is NOT a swipe (vertical, pinch)
    let lastX = 0;
    let lastTime = 0;
    let velocity = 0;       // px per 16ms
    let touching = false;

    function setOffset(px: number) {
      offsetRef.current = px;
      el!.style.transform = px !== 0 ? `translateX(${px}px)` : "";
    }

    function cancelAnimation() {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    }

    function snapTo(targetPx: number, duration: number, onDone: () => void) {
      cancelAnimation();
      const startPx = offsetRef.current;
      const dist = targetPx - startPx;
      if (Math.abs(dist) < 1) {
        setOffset(targetPx);
        onDone();
        return;
      }
      const startTime = performance.now();
      function step() {
        const elapsed = performance.now() - startTime;
        const t = Math.min(elapsed / duration, 1);
        // ease-out cubic
        const ease = 1 - Math.pow(1 - t, 3);
        setOffset(startPx + dist * ease);
        if (t < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          setOffset(targetPx);
          onDone();
        }
      }
      rafRef.current = requestAnimationFrame(step);
    }

    function resolveSwipe() {
      const { sessionIds, activeId, goTo } = optsRef.current;
      if (sessionIds.length <= 1) {
        snapTo(0, SNAP_DURATION, () => {});
        return;
      }

      const currentOffset = offsetRef.current;
      const currentVelocity = velocity;

      // Project final position using inertia
      let projectedOffset = currentOffset;
      let v = currentVelocity;
      while (Math.abs(v) > MIN_VELOCITY) {
        projectedOffset += v;
        v *= FRICTION;
      }

      // How many sessions to skip based on projected distance
      // Positive offset = swiping right = go to previous session
      // Negative offset = swiping left = go to next session
      const sessionSkip = Math.round(-projectedOffset / PAGE_WIDTH);
      const clampedSkip = Math.max(
        -(sessionIds.length - 1),
        Math.min(sessionIds.length - 1, sessionSkip),
      );

      if (clampedSkip === 0) {
        // Snap back to current
        snapTo(0, SNAP_DURATION, () => {});
        return;
      }

      const idx = sessionIds.indexOf(activeId);
      if (idx === -1) {
        snapTo(0, SNAP_DURATION, () => {});
        return;
      }

      const targetIdx = (idx + clampedSkip + sessionIds.length) % sessionIds.length;
      const targetId = sessionIds[targetIdx];
      const targetPx = -clampedSkip * PAGE_WIDTH;

      // Animate to the target position, then snap and navigate
      snapTo(targetPx, SNAP_DURATION, () => {
        setOffset(0);
        goTo(targetId);
      });
    }

    function onTouchStart(e: TouchEvent) {
      if (!(optsRef.current.enabled ?? true)) return;
      if (e.touches.length !== 1) {
        // Multi-touch — reject (let pinch-to-zoom handle it)
        rejected = true;
        return;
      }

      cancelAnimation();

      // If we were mid-animation from a previous swipe, reset
      if (offsetRef.current !== 0) {
        setOffset(0);
      }

      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      lastX = startX;
      lastTime = performance.now();
      velocity = 0;
      committed = false;
      rejected = false;
      touching = true;
    }

    function onTouchMove(e: TouchEvent) {
      if (!touching || rejected) return;
      if (!(optsRef.current.enabled ?? true)) return;
      if (e.touches.length !== 1) {
        // Multi-touch started mid-gesture — abort swipe
        rejected = true;
        if (committed) {
          setOffset(0);
          committed = false;
        }
        return;
      }

      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      const dx = x - startX;
      const dy = y - startY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (!committed) {
        // Haven't decided yet — check thresholds
        if (absDy > H_THRESHOLD / HV_RATIO && absDy > absDx) {
          // Vertical scroll — reject, let xterm handle it
          rejected = true;
          return;
        }
        if (absDx >= H_THRESHOLD && absDx > absDy * HV_RATIO) {
          // Horizontal swipe — commit!
          committed = true;
        } else {
          // Not enough movement yet — wait
          return;
        }
      }

      // We're committed to a horizontal swipe
      e.stopPropagation();
      e.preventDefault();

      // Update velocity tracking
      const now = performance.now();
      const dt = now - lastTime;
      if (dt > 0 && dt < 100) {
        const instantV = ((x - lastX) / dt) * 16; // normalize to px per 16ms
        velocity = velocity * 0.6 + instantV * 0.4;
      }
      lastX = x;
      lastTime = now;

      // Apply rubber-band effect: dampen offset as it gets larger
      const maxOffset = PAGE_WIDTH * 1.5;
      const ratio = Math.min(Math.abs(dx) / maxOffset, 1);
      const damped = dx * (1 - ratio * 0.4);
      setOffset(damped);
    }

    function onTouchEnd(e: TouchEvent) {
      if (!touching) return;
      touching = false;

      if (!committed) {
        // Was never a swipe — nothing to clean up
        return;
      }

      // Don't propagate the touchend for a committed swipe
      e.stopPropagation();

      resolveSwipe();
    }

    // Use capture phase so we see events before xterm's capture handlers.
    // We use passive: false so we can preventDefault on touchmove once
    // we commit to a horizontal swipe.
    el.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    el.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    el.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });

    return () => {
      cancelAnimation();
      el.removeEventListener("touchstart", onTouchStart, { capture: true } as any);
      el.removeEventListener("touchmove", onTouchMove, { capture: true } as any);
      el.removeEventListener("touchend", onTouchEnd, { capture: true } as any);
      if (offsetRef.current !== 0) {
        el.style.transform = "";
        offsetRef.current = 0;
      }
    };
  }, [containerRef]);

  return { offsetRef };
}
