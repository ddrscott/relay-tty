import { useState, useEffect, useCallback } from "react";
import { useRevalidator } from "react-router";
import { Bell, BellOff, Activity, Zap, Menu, Terminal, Check, Upload, Command, Power } from "lucide-react";
import { PlainInput } from "../components/plain-input";
import {
  getGlobalNotifSettings,
  setGlobalNotifSettings,
  type NotifSettings,
} from "../lib/notif-settings";
import { syncPushTriggers } from "../hooks/use-push-subscription";
import {
  getCtrlShortcuts,
  setCtrlShortcuts,
  shortcutsToText,
  textToShortcuts,
  DEFAULT_SHORTCUTS,
} from "../lib/ctrl-shortcuts";

export function meta() {
  return [
    { title: "Settings — relay-tty" },
    { name: "description", content: "relay-tty notification settings" },
  ];
}

export default function Settings() {
  const { revalidate } = useRevalidator();
  const [settings, setSettings] = useState<NotifSettings>({
    activityStopped: false,
    activitySpiked: false,
    sessionExited: true,
  });

  // Custom commands state
  const [commandsText, setCommandsText] = useState("");
  const [commandsSaved, setCommandsSaved] = useState(false);
  const [commandsError, setCommandsError] = useState<string | null>(null);
  const [commandsLoading, setCommandsLoading] = useState(true);

  // Upload directory state
  const [uploadDir, setUploadDir] = useState("");
  const [uploadDirSaved, setUploadDirSaved] = useState(false);
  const [uploadDirError, setUploadDirError] = useState<string | null>(null);
  const [uploadDirLoading, setUploadDirLoading] = useState(true);

  // Ctrl shortcuts state
  const [ctrlText, setCtrlText] = useState("");
  const [ctrlSaved, setCtrlSaved] = useState(false);
  const [ctrlError, setCtrlError] = useState<string | null>(null);

  useEffect(() => {
    setSettings(getGlobalNotifSettings());
    // Load ctrl shortcuts from localStorage
    setCtrlText(shortcutsToText(getCtrlShortcuts()));
    // Load custom commands from server
    fetch("/api/commands")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(({ commands }) => {
        setCommandsText(commands.join("\n"));
        setCommandsLoading(false);
      })
      .catch((err) => {
        setCommandsError(`Failed to load commands: ${err.message}`);
        setCommandsLoading(false);
      });
    // Load upload directory from server
    fetch("/api/upload-dir")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(({ uploadDir: dir }) => {
        setUploadDir(dir);
        setUploadDirLoading(false);
      })
      .catch((err) => {
        setUploadDirError(`Failed to load: ${err.message}`);
        setUploadDirLoading(false);
      });
  }, []);

  function toggle(key: keyof NotifSettings) {
    setSettings((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      setGlobalNotifSettings(next);
      // Sync updated triggers to the server-side push subscription
      syncPushTriggers();
      return next;
    });
  }

  const saveUploadDir = useCallback(async () => {
    setUploadDirError(null);
    try {
      const res = await fetch("/api/upload-dir", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadDir }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { uploadDir: dir } = await res.json();
      setUploadDir(dir);
      setUploadDirSaved(true);
      setTimeout(() => setUploadDirSaved(false), 2000);
    } catch (err: any) {
      setUploadDirError(`Failed to save: ${err.message}`);
    }
  }, [uploadDir]);

  const saveCtrlShortcuts = useCallback(() => {
    setCtrlError(null);
    const parsed = textToShortcuts(ctrlText);
    if (parsed.length === 0) {
      setCtrlError("No valid shortcuts found. Format: one per line, letter then label (e.g. \"R recall\")");
      return;
    }
    setCtrlShortcuts(parsed);
    setCtrlSaved(true);
    setTimeout(() => setCtrlSaved(false), 2000);
  }, [ctrlText]);

  const resetCtrlShortcuts = useCallback(() => {
    setCtrlText(shortcutsToText(DEFAULT_SHORTCUTS));
    setCtrlShortcuts(DEFAULT_SHORTCUTS);
    setCtrlSaved(true);
    setCtrlError(null);
    setTimeout(() => setCtrlSaved(false), 2000);
  }, []);

  const saveCommands = useCallback(async () => {
    setCommandsError(null);
    try {
      const commands = commandsText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      const res = await fetch("/api/commands", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCommandsSaved(true);
      revalidate(); // refresh sidebar
      setTimeout(() => setCommandsSaved(false), 2000);
    } catch (err: any) {
      setCommandsError(`Failed to save: ${err.message}`);
    }
  }, [commandsText, revalidate]);

  const notifPermission =
    typeof Notification !== "undefined" ? Notification.permission : "unsupported";

  return (
    <main className="h-app bg-[#0a0a0f] overflow-auto">
      <div className="container mx-auto p-4 max-w-lg">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <label
            htmlFor="sidebar-drawer"
            className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0] cursor-pointer lg:hidden"
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
          >
            <Menu className="w-4 h-4" />
          </label>
          <h1 className="text-xl font-bold font-mono text-[#e2e8f0]">Settings</h1>
        </div>

        {/* Custom Commands section */}
        <section className="bg-[#0f0f1a] border border-[#2d2d44] rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold font-mono text-[#e2e8f0] mb-1 flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[#64748b]" />
            Quick Launch Commands
          </h2>
          <p className="text-xs font-mono text-[#64748b] mb-3">
            Custom commands shown in the new session menu. One command per line.
          </p>

          {commandsLoading ? (
            <div className="flex items-center justify-center py-4">
              <span className="loading loading-spinner loading-sm text-[#64748b]" />
            </div>
          ) : (
            <>
              <textarea
                className="w-full bg-[#0a0a0f] border border-[#2d2d44] rounded-lg px-3 py-2 text-sm font-mono text-[#e2e8f0] placeholder-[#64748b] focus:outline-none focus:border-[#3d3d5c] resize-none"
                rows={5}
                placeholder={"htop\nnpm run dev\npython3 -m http.server"}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={commandsText}
                onChange={(e) => {
                  setCommandsText(e.target.value);
                  setCommandsSaved(false);
                }}
              />
              {commandsError && (
                <div className="mt-2 px-3 py-2 rounded-lg bg-[#1a1a2e] border border-[#ef4444]/30 text-xs font-mono text-[#ef4444]">
                  {commandsError}
                </div>
              )}
              <div className="flex items-center justify-end gap-2 mt-2">
                {commandsSaved && (
                  <span className="text-xs font-mono text-[#22c55e] flex items-center gap-1">
                    <Check className="w-3 h-3" /> Saved
                  </span>
                )}
                <button
                  className="btn btn-sm btn-primary font-mono text-xs"
                  onClick={saveCommands}
                >
                  Save
                </button>
              </div>
            </>
          )}
        </section>

        {/* Ctrl Shortcuts section */}
        <section className="bg-[#0f0f1a] border border-[#2d2d44] rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold font-mono text-[#e2e8f0] mb-1 flex items-center gap-2">
            <Command className="w-4 h-4 text-[#64748b]" />
            Ctrl Shortcuts
          </h2>
          <p className="text-xs font-mono text-[#64748b] mb-3">
            Quick-access Ctrl combos in the mobile toolbar. One per line: letter then label (e.g. "R recall"). Tap Ctrl to open, long-press for sticky modifier.
          </p>

          <textarea
            className="w-full bg-[#0a0a0f] border border-[#2d2d44] rounded-lg px-3 py-2 text-sm font-mono text-[#e2e8f0] placeholder-[#64748b] focus:outline-none focus:border-[#3d3d5c] resize-none"
            rows={6}
            placeholder={"R recall\nW del word\nA home\nE end"}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={ctrlText}
            onChange={(e) => {
              setCtrlText(e.target.value);
              setCtrlSaved(false);
            }}
          />
          {ctrlError && (
            <div className="mt-2 px-3 py-2 rounded-lg bg-[#1a1a2e] border border-[#ef4444]/30 text-xs font-mono text-[#ef4444]">
              {ctrlError}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 mt-2">
            {ctrlSaved && (
              <span className="text-xs font-mono text-[#22c55e] flex items-center gap-1">
                <Check className="w-3 h-3" /> Saved
              </span>
            )}
            <button
              className="btn btn-sm btn-ghost font-mono text-xs text-[#64748b]"
              onClick={resetCtrlShortcuts}
            >
              Reset
            </button>
            <button
              className="btn btn-sm btn-primary font-mono text-xs"
              onClick={saveCtrlShortcuts}
            >
              Save
            </button>
          </div>
        </section>

        {/* Upload Directory section */}
        <section className="bg-[#0f0f1a] border border-[#2d2d44] rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold font-mono text-[#e2e8f0] mb-1 flex items-center gap-2">
            <Upload className="w-4 h-4 text-[#64748b]" />
            Upload Directory
          </h2>
          <p className="text-xs font-mono text-[#64748b] mb-3">
            Where uploaded files are saved. The file path is inserted into the terminal after upload.
          </p>

          {uploadDirLoading ? (
            <div className="flex items-center justify-center py-4">
              <span className="loading loading-spinner loading-sm text-[#64748b]" />
            </div>
          ) : (
            <>
              <PlainInput
                className="w-full bg-[#0a0a0f] border border-[#2d2d44] rounded-lg px-3 py-2 text-sm font-mono text-[#e2e8f0] placeholder-[#64748b] focus:outline-none focus:border-[#3d3d5c]"
                type="text"
                placeholder="~/.relay-tty/uploads"
                value={uploadDir}
                onChange={(e) => {
                  setUploadDir(e.target.value);
                  setUploadDirSaved(false);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
              />
              {uploadDirError && (
                <div className="mt-2 px-3 py-2 rounded-lg bg-[#1a1a2e] border border-[#ef4444]/30 text-xs font-mono text-[#ef4444]">
                  {uploadDirError}
                </div>
              )}
              <div className="flex items-center justify-end gap-2 mt-2">
                {uploadDirSaved && (
                  <span className="text-xs font-mono text-[#22c55e] flex items-center gap-1">
                    <Check className="w-3 h-3" /> Saved
                  </span>
                )}
                <button
                  className="btn btn-sm btn-primary font-mono text-xs"
                  onClick={saveUploadDir}
                >
                  Save
                </button>
              </div>
            </>
          )}
        </section>

        {/* Notifications section */}
        <section className="bg-[#0f0f1a] border border-[#2d2d44] rounded-xl p-4">
          <h2 className="text-sm font-semibold font-mono text-[#e2e8f0] mb-1 flex items-center gap-2">
            <Bell className="w-4 h-4 text-[#64748b]" />
            Smart Notifications
          </h2>
          <p className="text-xs font-mono text-[#64748b] mb-4">
            Automatic notifications based on session activity patterns. These are global defaults — override per-session in the session info panel.
          </p>

          {notifPermission !== "granted" && notifPermission !== "unsupported" && (
            <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-[#1a1a2e] border border-[#3d3d5c] text-xs font-mono text-[#eab308]">
              <BellOff className="w-4 h-4 shrink-0" />
              <span>
                System notifications are not enabled. Grant permission in a session view first.
              </span>
            </div>
          )}

          {/* Activity stopped toggle */}
          <div className="flex items-center justify-between gap-3 py-3 border-b border-[#1e1e2e]">
            <div className="flex items-start gap-3">
              <Activity className="w-4 h-4 text-[#64748b] mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-mono text-[#e2e8f0]">Activity stopped</div>
                <div className="text-xs font-mono text-[#64748b] mt-0.5">
                  Notify when a busy session goes idle (e.g. build finished)
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={settings.activityStopped}
              onChange={() => toggle("activityStopped")}
            />
          </div>

          {/* Activity spiked toggle */}
          <div className="flex items-center justify-between gap-3 py-3 border-b border-[#1e1e2e]">
            <div className="flex items-start gap-3">
              <Zap className="w-4 h-4 text-[#64748b] mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-mono text-[#e2e8f0]">Activity spiked</div>
                <div className="text-xs font-mono text-[#64748b] mt-0.5">
                  Notify when an idle session suddenly gets busy (e.g. errors, output burst)
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={settings.activitySpiked}
              onChange={() => toggle("activitySpiked")}
            />
          </div>

          {/* Session exited toggle */}
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="flex items-start gap-3">
              <Power className="w-4 h-4 text-[#64748b] mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-mono text-[#e2e8f0]">Session exited</div>
                <div className="text-xs font-mono text-[#64748b] mt-0.5">
                  Notify when a session's process exits
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={settings.sessionExited}
              onChange={() => toggle("sessionExited")}
            />
          </div>
        </section>

        <p className="text-xs font-mono text-[#64748b] mt-4 px-1">
          Activity triggers are off by default. Session exited is on by default. All use your existing notification permissions. Per-session overrides can be set from the info panel in each session view.
        </p>
      </div>
    </main>
  );
}
