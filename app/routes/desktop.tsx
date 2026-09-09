import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "./+types/desktop";
import { toggleSidebarDrawer } from "../lib/sidebar-toggle";
import { Menu, Monitor, Eye, EyeOff, Keyboard, ClipboardPaste, Maximize2, Move, Unplug, RefreshCw, Loader2, Gauge } from "lucide-react";
import { LayoutSwitcher } from "../components/layout-switcher";
import { PlainInput } from "../components/plain-input";
import { NoKbButton } from "../components/no-kb-button";

type RfbInstance = {
  scaleViewport: boolean;
  clipViewport: boolean;
  dragViewport: boolean;
  resizeSession: boolean;
  showDotCursor: boolean;
  focus(opts?: FocusOptions): void;
  disconnect(): void;
  sendCredentials(creds: { username?: string; password?: string }): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  clipboardPasteFrom(text: string): void;
  addEventListener(type: string, handler: (e: CustomEvent) => void): void;
  /** noVNC internals: the raw WebSocket, used only to tag close codes for the server log. */
  _sock?: { _websocket?: WebSocket | null };
  /** noVNC internals: the display holds the full framebuffer and the clipped viewport. */
  _display?: {
    _backbuffer: HTMLCanvasElement;
    _viewportLoc: { x: number; y: number; w: number; h: number };
    _fbWidth: number;
    _fbHeight: number;
    viewportChangePos(dx: number, dy: number): void;
    viewportChangeSize(w: number, h: number): void;
    scale: number;
  };
};

type DesktopDisplay = { name: string; x: number; y: number; w: number; h: number; main: boolean };
const DISPLAY_KEY = "relay-desktop-display";

/** True when the displays tile exactly the framebuffer the server announced. */
function displaysMatchFramebuffer(displays: DesktopDisplay[], fbW: number, fbH: number): boolean {
  if (displays.length < 2 || !fbW || !fbH) return false;
  const right = Math.max(...displays.map((d) => d.x + d.w));
  const bottom = Math.max(...displays.map((d) => d.y + d.h));
  return right === fbW && bottom === fbH;
}

/** Frame rate cap choices. 0 means "as fast as the server answers". */
const FPS_STEPS = [5, 10, 20, 0] as const;
const FPS_KEY = "relay-desktop-fps";

/**
 * noVNC asks for the next screen update the instant one arrives, so a busy
 * desktop saturates the tunnel. This wraps the request encoder once, per
 * page load, and delays incremental requests to honor `fpsCap`. Full
 * (non-incremental) requests always go straight through.
 */
let fpsCap = 5;
function installFpsThrottle(RFB: { messages: Record<string, (...a: any[]) => void> & { __relayThrottled?: boolean } }) {
  const msgs = RFB.messages;
  if (msgs.__relayThrottled) return;
  msgs.__relayThrottled = true;
  const orig = msgs.fbUpdateRequest;
  const lastSent = new WeakMap<object, number>();
  const pending = new WeakMap<object, number>();
  msgs.fbUpdateRequest = function (sock: object, incremental: boolean, x: number, y: number, w: number, h: number) {
    const now = performance.now();
    if (!incremental || fpsCap <= 0) {
      lastSent.set(sock, now);
      return orig.call(msgs, sock, incremental, x, y, w, h);
    }
    if (pending.has(sock)) return;
    const wait = 1000 / fpsCap - (now - (lastSent.get(sock) ?? 0));
    if (wait <= 0) {
      lastSent.set(sock, now);
      return orig.call(msgs, sock, true, x, y, w, h);
    }
    pending.set(sock, window.setTimeout(() => {
      pending.delete(sock);
      lastSent.set(sock, performance.now());
      try { orig.call(msgs, sock, true, x, y, w, h); } catch {}
    }, wait));
  };
}

/**
 * Thumbnail of the whole desktop with the visible region outlined. Shown in
 * 1:1 mode, where the phone sees a fraction of the screen. Tap or drag on it
 * to move the viewport there.
 */
function Minimap({ rfbRef, displays, onPickDisplay }: {
  rfbRef: React.RefObject<RfbInstance | null>;
  /** When given, taps choose the display under the finger instead of panning. */
  displays?: DesktopDisplay[];
  onPickDisplay?: (index: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 250) return; // 4 Hz is plenty for a thumbnail
      last = t;
      const canvas = canvasRef.current;
      const d = rfbRef.current?._display;
      if (!canvas || !d || !d._fbWidth || !d._fbHeight) return;
      const targetW = 160;
      const scale = targetW / d._fbWidth;
      const w = targetW, h = Math.max(1, Math.round(d._fbHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(d._backbuffer, 0, 0, d._fbWidth, d._fbHeight, 0, 0, w, h);
      if (displays) {
        ctx.strokeStyle = "rgba(226,232,240,0.5)";
        ctx.lineWidth = 1;
        for (const disp of displays) ctx.strokeRect(disp.x * scale + 0.5, disp.y * scale + 0.5, disp.w * scale - 1, disp.h * scale - 1);
      }
      const vp = d._viewportLoc;
      ctx.strokeStyle = "#E85D00";
      ctx.lineWidth = 2;
      ctx.strokeRect(vp.x * scale + 1, vp.y * scale + 1, Math.max(2, vp.w * scale - 2), Math.max(2, vp.h * scale - 2));
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [rfbRef, displays]);

  const moveTo = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = rfbRef.current?._display;
    const canvas = canvasRef.current;
    if (!d || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * d._fbWidth;
    const fy = ((e.clientY - rect.top) / rect.height) * d._fbHeight;
    if (displays && onPickDisplay) {
      const i = displays.findIndex((disp) => fx >= disp.x && fx < disp.x + disp.w && fy >= disp.y && fy < disp.y + disp.h);
      if (i >= 0) onPickDisplay(i);
      return;
    }
    const vp = d._viewportLoc;
    d.viewportChangePos(fx - vp.w / 2 - vp.x, fy - vp.h / 2 - vp.y);
  }, [rfbRef, displays, onPickDisplay]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute bottom-2 right-2 border border-[#2d2d44] bg-black/80 shadow-lg"
      style={{ width: 160, touchAction: "none", imageRendering: "auto" }}
      onPointerDown={(e) => { draggingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); moveTo(e); }}
      onPointerMove={(e) => { if (draggingRef.current && !displays) moveTo(e); }}
      onPointerUp={() => { draggingRef.current = false; }}
      onPointerCancel={() => { draggingRef.current = false; }}
      aria-label="Desktop minimap"
    />
  );
}

/** Close the underlying socket with a distinguishable code before noVNC's own teardown. */
function closeTagged(rfb: RfbInstance, code: number, reason: string) {
  try { rfb._sock?._websocket?.close(code, reason); } catch {}
  try { rfb.disconnect(); } catch {}
}

type Phase =
  | { kind: "connecting" }
  | { kind: "credentials"; error?: string }
  | { kind: "connected" }
  | { kind: "unavailable" }
  | { kind: "disconnected"; reason?: string };

const USERNAME_KEY = "relay-desktop-username";

export function meta({ data }: Route.MetaArgs) {
  const hostname = data?.hostname ?? "";
  const title = hostname ? `Desktop — ${hostname} — relay-tty` : "Desktop — relay-tty";
  return [{ title }, { name: "description", content: "Remote desktop of the relay host" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const available = context.desktopAvailable ? await context.desktopAvailable() : false;
  const displays = available && context.desktopDisplays ? await context.desktopDisplays() : [];
  return { available, hostname: context.hostname, displays };
}

/** Pull the bridge's WS close reason out of noVNC's "Connection closed (code: N, reason: X)" text. */
function bridgeReason(text: string | undefined): string | null {
  const m = text?.match(/reason: ([a-z-]+)/);
  return m ? m[1] : null;
}

export default function DesktopPage({ loaderData }: Route.ComponentProps) {
  const { available, hostname, displays } = loaderData as { available: boolean; hostname: string; displays: DesktopDisplay[] };
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbInstance | null>(null);
  const [phase, setPhase] = useState<Phase>(available ? { kind: "connecting" } : { kind: "unavailable" });
  const [desktopName, setDesktopName] = useState("");
  const [fit, setFit] = useState(true);
  /** Index into `displays` to fit on its own, or null for the whole desktop. */
  const [display, setDisplay] = useState<number | null>(null);
  const [fbSize, setFbSize] = useState<{ w: number; h: number } | null>(null);
  const [fps, setFps] = useState<number>(5);
  const [attempt, setAttempt] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Credentials to send automatically on the next credentialsrequired event
  // (set when retrying after a failed handshake, which tears the socket down).
  const pendingCredsRef = useRef<{ username: string; password: string } | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(USERNAME_KEY);
      if (saved) setUsername(saved);
      const savedDisplay = localStorage.getItem(DISPLAY_KEY);
      if (savedDisplay) {
        const i = displays.findIndex((d) => d.name === savedDisplay);
        if (i >= 0) setDisplay(i);
      }
      const savedFps = localStorage.getItem(FPS_KEY);
      if (savedFps !== null && (FPS_STEPS as readonly number[]).includes(Number(savedFps))) setFps(Number(savedFps));
    } catch {}
  }, []);

  // Connect (and reconnect on `attempt` bump). noVNC is loaded lazily so the
  // terminal bundle never pays for it.
  useEffect(() => {
    if (!available || !screenRef.current) return;
    let cancelled = false;
    let rfb: RfbInstance | null = null;
    setPhase({ kind: "connecting" });

    // noVNC reports failure details only through console.error (its disconnect
    // event carries just a clean flag). Capture them so the page can say why.
    let lastError = "";
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (/^Failed |RFB failure|Connection closed|Unexpected server/.test(text)) lastError = text.replace(/^Failed (while connected|when connecting): /, "");
      origError.apply(console, args);
    };

    (async () => {
      const mod = await import("@novnc/novnc");
      if (cancelled || !screenRef.current) return;
      const RFB = mod.default as unknown as new (target: HTMLElement, url: string, opts?: object) => RfbInstance;
      installFpsThrottle(mod.default);
      const proto = location.protocol === "https:" ? "wss" : "ws";
      rfb = new RFB(screenRef.current, `${proto}://${location.host}/ws/desktop`);
      rfbRef.current = rfb;
      rfb.scaleViewport = true;
      rfb.resizeSession = false; // Apple's server ignores SetDesktopSize anyway
      rfb.showDotCursor = true;

      rfb.addEventListener("credentialsrequired", () => {
        const pending = pendingCredsRef.current;
        if (pending && rfb) {
          pendingCredsRef.current = null;
          rfb.sendCredentials(pending);
          setPhase({ kind: "connecting" });
          return;
        }
        setPhase({ kind: "credentials" });
      });
      rfb.addEventListener("securityfailure", (e) => {
        setPhase({ kind: "credentials", error: e.detail?.reason || "Authentication failed" });
      });
      rfb.addEventListener("connect", () => {
        const d = rfb?._display;
        setFbSize(d ? { w: d._fbWidth, h: d._fbHeight } : null);
        setPhase({ kind: "connected" });
      });
      rfb.addEventListener("desktopname", (e) => setDesktopName(e.detail?.name ?? ""));
      rfb.addEventListener("clipboard", (e) => {
        const text = e.detail?.text;
        if (text && navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
      });
      rfb.addEventListener("disconnect", (e) => {
        if (cancelled) return;
        const reason = bridgeReason(e.detail?.reason);
        if (reason === "vnc-unavailable") {
          setPhase({ kind: "unavailable" });
          return;
        }
        // A securityfailure already set the credentials phase with its error;
        // noVNC fires disconnect right after and we must not clobber it.
        const el = screenRef.current;
        const size = el ? `${el.clientWidth}x${el.clientHeight}` : "?";
        const detail = e.detail?.clean === false ? `${lastError || "noVNC internal failure"} (viewer ${size})` : lastError || undefined;
        setPhase((p) => (p.kind === "credentials" ? p : { kind: "disconnected", reason: detail }));
      });
    })().catch((err: unknown) => {
      if (!cancelled) setPhase({ kind: "disconnected", reason: err instanceof Error ? err.message : String(err) });
    });

    return () => {
      cancelled = true;
      console.error = origError;
      rfbRef.current = null;
      if (rfb) closeTagged(rfb, 4100, `page-cleanup available=${available} attempt=${attempt}`);
    };
  }, [available, attempt]);

  // Frame rate cap lives in module scope so the throttle can read it without re-wrapping
  useEffect(() => {
    fpsCap = fps;
    try { localStorage.setItem(FPS_KEY, String(fps)); } catch {}
  }, [fps]);

  const canPickDisplay = phase.kind === "connected" && !!fbSize && displaysMatchFramebuffer(displays, fbSize.w, fbSize.h);
  const region = canPickDisplay && display !== null ? displays[display] ?? null : null;

  useEffect(() => {
    try {
      if (display === null) localStorage.removeItem(DISPLAY_KEY);
      else if (displays[display]) localStorage.setItem(DISPLAY_KEY, displays[display].name);
    } catch {}
  }, [display, displays]);

  // Apply fit / pan / single-display mode to the live client.
  //
  // Single-display mode is not something noVNC offers: it can scale the whole
  // framebuffer or clip a container-sized window into it. To show one display
  // we clip the viewport to that display's rectangle and scale the clipped
  // canvas to fit. noVNC re-clips to the container size inside a frame
  // callback whenever the container resizes, so the region is re-applied two
  // frames after every resize to land after noVNC's own pass.
  useEffect(() => {
    const rfb = rfbRef.current;
    const el = screenRef.current;
    if (!rfb || phase.kind !== "connected") return;
    if (!region) {
      rfb.scaleViewport = fit;
      rfb.clipViewport = !fit;
      rfb.dragViewport = !fit;
      return;
    }
    rfb.scaleViewport = false;
    rfb.clipViewport = true;
    rfb.dragViewport = false;
    const apply = () => {
      const d = rfb._display;
      if (!d || !el) return;
      d.viewportChangeSize(region.w, region.h);
      const vp = d._viewportLoc;
      d.viewportChangePos(region.x - vp.x, region.y - vp.y);
      d.scale = Math.min(el.clientWidth / region.w, el.clientHeight / region.h);
    };
    apply();
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = requestAnimationFrame(apply); });
    });
    if (el) ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [fit, region, phase.kind]);

  const submitCredentials = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const rfb = rfbRef.current;
      if (phase.kind !== "credentials") return;
      try { localStorage.setItem(USERNAME_KEY, username); } catch {}
      if (phase.error) {
        // The failed handshake already tore the socket down; dial again and
        // let the fresh credentialsrequired event submit these for us.
        pendingCredsRef.current = { username, password };
        setPassword("");
        setAttempt((n) => n + 1);
        return;
      }
      rfb?.sendCredentials({ username, password });
      setPassword("");
      setPhase({ kind: "connecting" });
    },
    [phase, username, password],
  );

  const pasteToHost = useCallback(async () => {
    const rfb = rfbRef.current;
    if (!rfb || !navigator.clipboard?.readText) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) rfb.clipboardPasteFrom(text);
    } catch {}
  }, []);

  // Mobile typing. noVNC's canvas never opens a virtual keyboard, so a hidden
  // textarea collects what the phone types and forwards it as key events.
  // The textarea is kept at one sentinel space so Backspace registers as a
  // deletion instead of a no-op on an empty field.
  const kbRef = useRef<HTMLTextAreaElement>(null);
  const KB_SENTINEL = " ";
  const onKbInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const rfb = rfbRef.current;
    const el = e.currentTarget;
    const val = el.value;
    if (rfb) {
      if (val.length < KB_SENTINEL.length) {
        rfb.sendKey(0xff08, "Backspace"); // XK_BackSpace
      } else {
        for (const ch of val.slice(KB_SENTINEL.length)) {
          const cp = ch.codePointAt(0)!;
          if (cp === 0x0a) rfb.sendKey(0xff0d, "Enter"); // XK_Return
          else if (cp === 0x09) rfb.sendKey(0xff09, "Tab"); // XK_Tab
          else rfb.sendKey(cp < 0x100 ? cp : 0x01000000 | cp, null); // X11 Unicode keysym rule
        }
      }
    }
    el.value = KB_SENTINEL;
  }, []);
  const onKbKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter and Backspace are the only keys Android/iOS reliably deliver as
    // keydown; everything else comes through the input event above.
    const rfb = rfbRef.current;
    if (!rfb) return;
    if (e.key === "Enter") { e.preventDefault(); rfb.sendKey(0xff0d, "Enter"); }
    else if (e.key === "Backspace" && e.currentTarget.value.length <= KB_SENTINEL.length) { e.preventDefault(); rfb.sendKey(0xff08, "Backspace"); }
    else if (e.key === "Escape") { e.preventDefault(); rfb.sendKey(0xff1b, "Escape"); }
  }, []);

  const connected = phase.kind === "connected";

  return (
    <main className="h-full bg-[#0a0a0f] flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 sm:px-4 py-2 border-b border-[#1e1e2e] shrink-0">
        <button
          className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0] cursor-pointer"
          onClick={() => toggleSidebarDrawer()}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Monitor className="w-4 h-4 text-[#64748b] shrink-0" />
          <h1 className="text-lg font-bold font-mono text-[#64748b] sidebar-redundant truncate">
            Desktop
            {(desktopName || hostname) && (
              <span className="text-sm font-normal text-[#94a3b8] ml-2">@{desktopName || hostname}</span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="hidden lg:block mr-1"><LayoutSwitcher /></div>
          {connected && (
            <>
              {canPickDisplay && (
                <div className="flex items-center border border-[#2d2d44] font-mono text-xs mr-1" role="group" aria-label="Display">
                  <NoKbButton
                    className={`px-2 h-7 ${display === null ? "text-[#e2e8f0] bg-[#19191f]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
                    onPress={() => setDisplay(null)}
                    title="All displays"
                  >
                    all
                  </NoKbButton>
                  {displays.map((d, i) => (
                    <NoKbButton
                      key={d.name + i}
                      className={`px-2 h-7 border-l border-[#2d2d44] ${display === i ? "text-[#e2e8f0] bg-[#19191f]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
                      onPress={() => setDisplay(i)}
                      title={`${d.name} (${d.w}×${d.h})`}
                    >
                      {i + 1}
                    </NoKbButton>
                  ))}
                </div>
              )}
              <NoKbButton
                className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0]"
                onPress={() => { setDisplay(null); setFit((f) => (region ? false : !f)); }}
                title={region ? "Switch to 1:1 (drag to pan)" : fit ? "Switch to 1:1 (drag to pan)" : "Fit to screen"}
                aria-label={region || fit ? "Switch to 1:1" : "Fit to screen"}
              >
                {region || fit ? <Move className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </NoKbButton>
              <NoKbButton
                className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0] gap-1 font-mono text-xs"
                onPress={() => setFps((f) => FPS_STEPS[(FPS_STEPS.indexOf(f as typeof FPS_STEPS[number]) + 1) % FPS_STEPS.length])}
                title="Frame rate cap"
                aria-label="Frame rate cap"
              >
                <Gauge className="w-4 h-4" />
                <span>{fps === 0 ? "max" : `${fps}fps`}</span>
              </NoKbButton>
              <NoKbButton
                className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0]"
                onPress={pasteToHost}
                title="Paste clipboard to host"
                aria-label="Paste clipboard to host"
                
              >
                <ClipboardPaste className="w-4 h-4" />
              </NoKbButton>
              <button
                className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0] lg:hidden"
                onClick={() => kbRef.current?.focus({ preventScroll: true })}
                onMouseDown={(e) => e.preventDefault()}
                title="Show keyboard"
                aria-label="Show keyboard"
              >
                <Keyboard className="w-4 h-4" />
              </button>
              <NoKbButton
                className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#ef4444]"
                onPress={() => { if (rfbRef.current) closeTagged(rfbRef.current, 4101, "user-disconnect"); }}
                title="Disconnect"
                aria-label="Disconnect"
                
              >
                <Unplug className="w-4 h-4" />
              </NoKbButton>
            </>
          )}
          <span className="text-xs font-mono text-[#64748b] hidden sm:inline">
            {phase.kind === "connecting" && "connecting"}
            {phase.kind === "credentials" && "sign in"}
            {phase.kind === "connected" && "live"}
            {phase.kind === "disconnected" && "disconnected"}
            {phase.kind === "unavailable" && "off"}
          </span>
        </div>
      </div>

      {/* Screen */}
      <div className="flex-1 min-h-0 relative overflow-hidden bg-black">
        <div ref={screenRef} className="absolute inset-0" style={{ touchAction: "none" }} />
        <textarea
          ref={kbRef}
          defaultValue={KB_SENTINEL}
          onInput={onKbInput}
          onKeyDown={onKbKeyDown}
          onFocus={(e) => { e.currentTarget.value = KB_SENTINEL; }}
          className="absolute opacity-0 w-px h-px -left-px top-0 pointer-events-none"
          aria-hidden="true"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />

        {connected && region && <Minimap rfbRef={rfbRef} displays={displays} onPickDisplay={setDisplay} />}
        {connected && !region && !fit && <Minimap rfbRef={rfbRef} />}

        {phase.kind === "connecting" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 className="w-6 h-6 text-[#64748b] animate-spin" />
          </div>
        )}

        {phase.kind === "credentials" && (
          <div className="absolute inset-0 flex items-center justify-center p-4 bg-[#0a0a0f]/90">
            <form onSubmit={submitCredentials} className="w-full max-w-xs space-y-3">
              <div className="text-center mb-2">
                <Monitor className="w-8 h-8 text-[#2d2d44] mx-auto mb-2" />
                <p className="text-[#e2e8f0] font-mono text-sm">Sign in to {desktopName || hostname}</p>
                <p className="text-[#64748b] text-xs mt-1">Your macOS account, checked by Screen Sharing on the host.</p>
              </div>
              {phase.error && (
                <p className="text-[#ef4444] text-xs font-mono text-center">{phase.error}</p>
              )}
              <PlainInput
                className="toolbar-input w-full"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus={!username}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.currentTarget.form?.elements.namedItem("password") as HTMLInputElement | null)?.focus();
                  }
                }}
              />
              <div className="relative">
                <input
                  name="password"
                  type={showPassword ? "text" : "password"}
                  className="toolbar-input w-full pr-8"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus={!!username}
                  autoComplete="off"
                />
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#64748b] hover:text-[#94a3b8]"
                  onClick={() => setShowPassword((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  tabIndex={-1}
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <button type="submit" className="btn btn-sm w-full bg-[#19191f] border-[#2d2d44] text-[#e2e8f0] hover:border-[#3b82f6]">
                {phase.error ? "Try again" : "Connect"}
              </button>
            </form>
          </div>
        )}

        {phase.kind === "disconnected" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 bg-[#0a0a0f]/90">
            <Unplug className="w-8 h-8 text-[#2d2d44]" />
            <p className="text-[#64748b] font-mono text-sm">Disconnected</p>
            {phase.reason && <p className="text-[#64748b]/60 text-xs font-mono text-center max-w-sm">{phase.reason}</p>}
            <NoKbButton
              className="btn btn-sm bg-[#19191f] border-[#2d2d44] text-[#e2e8f0] hover:border-[#3b82f6]"
              onPress={() => setAttempt((n) => n + 1)}
              
            >
              <RefreshCw className="w-4 h-4 mr-1" /> Reconnect
            </NoKbButton>
          </div>
        )}

        {phase.kind === "unavailable" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <Monitor className="w-10 h-10 text-[#2d2d44]" />
            <p className="text-[#64748b] font-mono text-sm">No VNC server on the host</p>
            <p className="text-[#64748b]/60 text-xs max-w-sm">
              relay looks for a VNC server on port 5900 of the machine running <span className="font-mono">relay server</span>.
              On macOS, turn on <span className="font-mono">System Settings → General → Sharing → Screen Sharing</span>.
              On Linux, start any VNC server on 5900.
            </p>
            <NoKbButton
              className="btn btn-sm bg-[#19191f] border-[#2d2d44] text-[#e2e8f0] hover:border-[#3b82f6]"
              onPress={() => location.reload()}
              
            >
              <RefreshCw className="w-4 h-4 mr-1" /> Check again
            </NoKbButton>
          </div>
        )}
      </div>
    </main>
  );
}
