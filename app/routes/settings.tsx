import { useState, useEffect, useCallback } from "react";
import { useRevalidator } from "react-router";
import { Bell, BellOff, Activity, Zap, Menu, Terminal, Check } from "lucide-react";
import {
  getGlobalNotifSettings,
  setGlobalNotifSettings,
  type NotifSettings,
} from "../lib/notif-settings";

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
  });

  // Custom commands state
  const [commandsText, setCommandsText] = useState("");
  const [commandsSaved, setCommandsSaved] = useState(false);
  const [commandsLoading, setCommandsLoading] = useState(true);

  useEffect(() => {
    setSettings(getGlobalNotifSettings());
    // Load custom commands from server
    fetch("/api/commands")
      .then((r) => r.json())
      .then(({ commands }) => {
        setCommandsText(commands.join("\n"));
        setCommandsLoading(false);
      })
      .catch(() => setCommandsLoading(false));
  }, []);

  function toggle(key: keyof NotifSettings) {
    setSettings((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      setGlobalNotifSettings(next);
      return next;
    });
  }

  const saveCommands = useCallback(async () => {
    const commands = commandsText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    await fetch("/api/commands", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    setCommandsSaved(true);
    revalidate(); // refresh sidebar
    setTimeout(() => setCommandsSaved(false), 2000);
  }, [commandsText, revalidate]);

  const notifPermission =
    typeof Notification !== "undefined" ? Notification.permission : "unsupported";

  return (
    <main className="h-dvh bg-[#0a0a0f] overflow-auto">
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
                value={commandsText}
                onChange={(e) => {
                  setCommandsText(e.target.value);
                  setCommandsSaved(false);
                }}
              />
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
          <div className="flex items-center justify-between gap-3 py-3">
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
        </section>

        <p className="text-xs font-mono text-[#64748b] mt-4 px-1">
          Both triggers are off by default and use your existing notification permissions. Per-session overrides can be set from the info panel in each session view.
        </p>
      </div>
    </main>
  );
}
