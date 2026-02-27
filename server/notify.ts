import type { SessionStore } from "./session-store.js";
import type { PtyManager } from "./pty-manager.js";

interface NotifyOptions {
  discordWebhook?: string;
  appUrl?: string;
}

/**
 * Wire up session event notifications.
 * Currently supports Discord webhooks with deep links to sessions.
 */
export function setupNotifications(
  ptyManager: PtyManager,
  sessionStore: SessionStore,
  opts: NotifyOptions
): void {
  if (!opts.discordWebhook || !opts.appUrl) return;

  const { discordWebhook, appUrl } = opts;

  ptyManager.on("exit", async (id: string, exitCode: number) => {
    const session = sessionStore.get(id);
    if (!session) return;

    const displayCommand = [session.command, ...session.args].join(" ");
    const cwd = session.cwd.replace(/^\/Users\/[^/]+/, "~");
    const status = exitCode === 0 ? "completed" : "failed";
    const emoji = exitCode === 0 ? "\u2705" : "\u274c";
    const sessionUrl = `${appUrl}/sessions/${id}`;

    const content = `${emoji} **${displayCommand}** ${status} (exit ${exitCode})\n\`${cwd}\`\n${sessionUrl}`;

    try {
      await fetch(discordWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    } catch (err: any) {
      console.error(`Discord notification failed for session ${id}:`, err.message);
    }
  });
}
