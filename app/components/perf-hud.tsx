import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { perfRegistry } from "../lib/perf-registry";
import { getWindowPref, setWindowPref } from "../lib/window-prefs";

/**
 * Dev-only perf HUD for the gallery views (/grid, /lanes).
 *
 * Hidden by default. Enable with `?perf=1` or Ctrl+Shift+` (persisted via
 * window prefs like other grid preferences). Shows frame time, mounted cell
 * count, WebGL vs DOM renderer mix, PTY write throughput, and JS heap
 * (Chrome only).
 *
 * Zero cost when hidden: the rAF sampler and the 1 Hz snapshot interval only
 * run while visible. The perfRegistry counters it reads are always-on but are
 * just Set mutations / integer adds in the terminal core.
 */

const PREF_KEY = "relay-tty-perf-hud";

interface PerfStats {
  frameMs: number;
  cells: number;
  webgl: number;
  bytesPerSec: number;
  heapBytes: number | null;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export function PerfHud() {
  const [visible, setVisible] = useState(false);
  const [stats, setStats] = useState<PerfStats | null>(null);

  // Initial visibility: ?perf=1 query param or persisted pref.
  // Runs in an effect (not lazy state) so SSR markup stays deterministic.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("perf") === "1" || getWindowPref(PREF_KEY) === "1") {
      setVisible(true);
    }
  }, []);

  // Toggle shortcut: Ctrl+Shift+` (Backquote). Always attached — a single
  // keydown listener is negligible; all sampling stays gated on `visible`.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === "Backquote") {
        e.preventDefault();
        setVisible((v) => {
          setWindowPref(PREF_KEY, v ? "0" : "1");
          return !v;
        });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Sampling — only while visible. The rAF loop keeps a frame-time EMA in a
  // local; a 1 Hz interval snapshots everything into React state so the HUD
  // re-renders once per second, never per frame.
  useEffect(() => {
    if (!visible) {
      setStats(null);
      return;
    }

    let raf = 0;
    let last = performance.now();
    let ema = 16.7;
    const loop = (t: number) => {
      const dt = t - last;
      last = t;
      // Ignore pathological deltas from tab backgrounding / debugger pauses
      if (dt > 0 && dt < 1000) ema = ema * 0.9 + dt * 0.1;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    let lastBytes = perfRegistry.bytesWritten;
    let lastSample = performance.now();
    const sample = () => {
      const now = performance.now();
      const bytes = perfRegistry.bytesWritten;
      const dtSec = (now - lastSample) / 1000;
      const bytesPerSec = dtSec > 0 ? (bytes - lastBytes) / dtSec : 0;
      lastBytes = bytes;
      lastSample = now;
      // performance.memory is Chrome-only and not in the TS lib types
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      setStats({
        frameMs: ema,
        cells: perfRegistry.terms.size,
        webgl: perfRegistry.webgl.size,
        bytesPerSec,
        heapBytes: mem ? mem.usedJSHeapSize : null,
      });
    };
    sample();
    const interval = setInterval(sample, 1000);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(interval);
    };
  }, [visible]);

  if (!visible || !stats) return null;

  const fps = stats.frameMs > 0 ? 1000 / stats.frameMs : 0;
  const dom = Math.max(0, stats.cells - stats.webgl);

  const rows: [string, string][] = [
    ["frame", `${stats.frameMs.toFixed(1)}ms ${Math.round(fps)}fps`],
    ["cells", `${stats.cells}`],
    ["render", `${stats.webgl} webgl / ${dom} dom`],
    ["write", `${formatBytes(stats.bytesPerSec)}B/s`],
  ];
  if (stats.heapBytes != null) {
    rows.push(["heap", `${formatBytes(stats.heapBytes)}B`]);
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-50 pointer-events-none select-none font-mono text-[10px] leading-4 text-[#94a3b8] bg-[#0a0a0f]/90 border border-[#2d2d44] px-2 py-1.5 min-w-44"
      role="status"
      aria-label="Performance HUD"
    >
      <div className="flex items-center justify-between gap-2 mb-1 text-[#64748b]">
        <span>PERF</span>
        <button
          className="pointer-events-auto cursor-pointer hover:text-[#e2e8f0] transition-colors"
          onClick={() => {
            setVisible(false);
            setWindowPref(PREF_KEY, "0");
          }}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-label="Close perf HUD"
          title="Close (Ctrl+Shift+`)"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-3">
          <span className="text-[#64748b]">{label}</span>
          <span className="text-[#e2e8f0]">{value}</span>
        </div>
      ))}
    </div>
  );
}
