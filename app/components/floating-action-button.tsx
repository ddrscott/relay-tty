import { useRef, useState, useCallback, useEffect, memo, type TouchEvent as ReactTouchEvent } from "react";
import { History, Ellipsis, X } from "lucide-react";

const SCROLL_TAP_THRESHOLD = 10; // px — movement beyond this is a drag
const FAB_SIZE = 48; // px — button diameter
const CORNER_MARGIN = 16; // px — distance from screen edge
const IDLE_DELAY_MS = 3000; // ms — time before reducing opacity
const LS_KEY = "relay-tty-fab-corner";

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

function getStoredCorner(): Corner {
  if (typeof window === "undefined") return "bottom-right";
  return (localStorage.getItem(LS_KEY) as Corner) || "bottom-right";
}

function cornerPosition(corner: Corner, safeBottom: number) {
  const top = corner.startsWith("top") ? CORNER_MARGIN : undefined;
  const bottom = corner.startsWith("bottom") ? CORNER_MARGIN + safeBottom : undefined;
  const left = corner.endsWith("left") ? CORNER_MARGIN : undefined;
  const right = corner.endsWith("right") ? CORNER_MARGIN : undefined;
  return { top, bottom, left, right };
}

function nearestCorner(x: number, y: number, viewW: number, viewH: number): Corner {
  const midX = viewW / 2;
  const midY = viewH / 2;
  const isLeft = x < midX;
  const isTop = y < midY;
  if (isTop && isLeft) return "top-left";
  if (isTop && !isLeft) return "top-right";
  if (!isTop && isLeft) return "bottom-left";
  return "bottom-right";
}

interface FloatingActionButtonProps {
  onOpenHistory: () => void;
  historyDisabled?: boolean;
  visible?: boolean;
}

export const FloatingActionButton = memo(function FloatingActionButton({
  onOpenHistory,
  historyDisabled,
  visible = true,
}: FloatingActionButtonProps) {
  const [corner, setCorner] = useState<Corner>(getStoredCorner);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [idle, setIdle] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const didDragRef = useRef(false);

  // Safe area bottom for positioning
  const [safeBottom, setSafeBottom] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const compute = () => {
      const sab = parseInt(getComputedStyle(document.documentElement).getPropertyValue("env(safe-area-inset-bottom)") || "0", 10) || 0;
      setSafeBottom(sab);
    };
    compute();
  }, []);

  // Reset idle timer on interaction
  const resetIdle = useCallback(() => {
    setIdle(false);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setIdle(true), IDLE_DELAY_MS);
  }, []);

  // Start idle timer on mount
  useEffect(() => {
    idleTimerRef.current = setTimeout(() => setIdle(true), IDLE_DELAY_MS);
    return () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current); };
  }, []);

  // Close menu on outside touch
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-fab-menu]") || target.closest("[data-fab-button]")) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const handleTouchStart = useCallback((e: ReactTouchEvent) => {
    e.stopPropagation();
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
    didDragRef.current = false;
    resetIdle();
  }, [resetIdle]);

  const handleTouchMove = useCallback((e: ReactTouchEvent) => {
    e.stopPropagation();
    if (!touchStartRef.current) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - touchStartRef.current.x);
    const dy = Math.abs(t.clientY - touchStartRef.current.y);
    if (dx > SCROLL_TAP_THRESHOLD || dy > SCROLL_TAP_THRESHOLD) {
      didDragRef.current = true;
      setDragging(true);
      setMenuOpen(false);
      setDragPos({ x: t.clientX - FAB_SIZE / 2, y: t.clientY - FAB_SIZE / 2 });
    }
  }, []);

  const handleTouchEnd = useCallback((e: ReactTouchEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (didDragRef.current && dragPos) {
      // Snap to nearest corner
      const centerX = dragPos.x + FAB_SIZE / 2;
      const centerY = dragPos.y + FAB_SIZE / 2;
      const newCorner = nearestCorner(centerX, centerY, window.innerWidth, window.innerHeight);
      setCorner(newCorner);
      localStorage.setItem(LS_KEY, newCorner);
    } else {
      // Tap — toggle menu
      setMenuOpen(v => !v);
    }
    setDragging(false);
    setDragPos(null);
    touchStartRef.current = null;
    resetIdle();
  }, [dragPos, resetIdle]);

  // Desktop click fallback
  const handleClick = useCallback(() => {
    if (didDragRef.current) return;
    setMenuOpen(v => !v);
    resetIdle();
  }, [resetIdle]);

  const handleHistoryClick = useCallback(() => {
    setMenuOpen(false);
    onOpenHistory();
  }, [onOpenHistory]);

  if (!visible) return null;

  // Compute numeric positions for FAB and menu
  const toolbarOffset = safeBottom + 52; // 52px = toolbar height approximation
  const cornerPos = cornerPosition(corner, toolbarOffset);

  const fabStyle: React.CSSProperties = dragging && dragPos
    ? { position: "fixed", left: dragPos.x, top: dragPos.y }
    : { position: "fixed", ...cornerPos };

  // Menu opens toward the center of the screen
  const menuOnLeft = corner.endsWith("right");
  const menuOnTop = corner.startsWith("bottom");

  // Menu position — computed from corner positions (always numeric)
  const menuStyle: React.CSSProperties = { position: "fixed" };
  if (menuOnTop) {
    menuStyle.bottom = (cornerPos.bottom ?? 0) + FAB_SIZE + 8;
  } else {
    menuStyle.top = (cornerPos.top ?? 0) + FAB_SIZE + 8;
  }
  if (menuOnLeft) {
    menuStyle.right = cornerPos.right ?? CORNER_MARGIN;
  } else {
    menuStyle.left = cornerPos.left ?? CORNER_MARGIN;
  }

  return (
    <>
      {/* FAB button */}
      <button
        data-fab-button
        className={`z-[100] rounded-full shadow-lg flex items-center justify-center transition-opacity duration-300 border border-[#2d2d44] ${
          menuOpen ? "bg-[#1a1a2e] opacity-100" : idle ? "bg-[#0f0f1a]/60 opacity-40" : "bg-[#0f0f1a]/90 opacity-80"
        }`}
        style={{
          ...fabStyle,
          width: FAB_SIZE,
          height: FAB_SIZE,
          touchAction: "none",
        }}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handleClick}
        aria-label="Quick actions"
      >
        {menuOpen
          ? <X className="w-5 h-5 text-[#94a3b8]" />
          : <Ellipsis className="w-5 h-5 text-[#94a3b8]" />
        }
      </button>

      {/* Flyout menu */}
      {menuOpen && (
        <div
          data-fab-menu
          className="fixed z-[100] bg-[#0f0f1a] border border-[#2d2d44] rounded-xl shadow-xl py-1.5 min-w-[10rem] animate-banner-in"
          style={menuStyle}
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <button
            className="flex items-center gap-2.5 w-full px-4 py-2.5 text-left hover:bg-[#1a1a2e] active:bg-[#1a1a2e] transition-colors disabled:opacity-30"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); handleHistoryClick(); }}
            onClick={handleHistoryClick}
            disabled={historyDisabled}
          >
            <History className="w-4 h-4 text-[#7dd3fc]" />
            <span className="text-sm font-mono text-[#e2e8f0]">History</span>
          </button>
        </div>
      )}
    </>
  );
});
