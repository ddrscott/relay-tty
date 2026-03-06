import { useState, useEffect } from "react";
import { Link } from "react-router";
import { ArrowLeft, Bell, BellOff, Activity, Zap } from "lucide-react";
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
  const [settings, setSettings] = useState<NotifSettings>({
    activityStopped: false,
    activitySpiked: false,
  });

  // Load from localStorage on mount (client-side only)
  useEffect(() => {
    setSettings(getGlobalNotifSettings());
  }, []);

  function toggle(key: keyof NotifSettings) {
    setSettings((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      setGlobalNotifSettings(next);
      return next;
    });
  }

  const notifPermission =
    typeof Notification !== "undefined" ? Notification.permission : "unsupported";

  return (
    <main className="h-dvh bg-[#0a0a0f] overflow-auto">
      <div className="container mx-auto p-4 max-w-lg">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            to="/"
            className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0]"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <h1 className="text-xl font-bold font-mono text-[#e2e8f0]">Settings</h1>
        </div>

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

        {/* Info note */}
        <p className="text-xs font-mono text-[#64748b] mt-4 px-1">
          Both triggers are off by default and use your existing notification permissions. Per-session overrides can be set from the info panel in each session view.
        </p>
      </div>
    </main>
  );
}
