/**
 * Web Push subscription store — manages VAPID keys and push subscriptions.
 * Persisted to ~/.relay-tty/push/ directory.
 *
 * - VAPID keys auto-generated on first use
 * - Subscriptions stored per-endpoint (deduped)
 * - Each subscription tracks which sessions to notify about
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import webpush from "web-push";

const RELAY_DIR = path.join(os.homedir(), ".relay-tty");
const PUSH_DIR = path.join(RELAY_DIR, "push");
const VAPID_FILE = path.join(PUSH_DIR, "vapid.json");
const SUBSCRIPTIONS_FILE = path.join(PUSH_DIR, "subscriptions.json");

export interface PushSubscriptionRecord {
  /** The push endpoint URL (unique identifier) */
  endpoint: string;
  /** The PushSubscription keys */
  keys: { p256dh: string; auth: string };
  /** Session IDs this subscription wants notifications for (empty = all) */
  sessionIds: string[];
  /** Notification types enabled */
  triggers: {
    activityStopped: boolean;
    activitySpiked: boolean;
    sessionExited: boolean;
  };
  /** When the subscription was created */
  createdAt: number;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class PushStore {
  private vapidKeys: VapidKeys;
  private subscriptions: PushSubscriptionRecord[] = [];

  constructor() {
    fs.mkdirSync(PUSH_DIR, { recursive: true });
    this.vapidKeys = this.loadOrGenerateVapid();
    this.loadSubscriptions();

    // Configure web-push with VAPID
    // Apple APNs is strict about the subject — .local TLDs get rejected
    webpush.setVapidDetails(
      "mailto:push@relaytty.com",
      this.vapidKeys.publicKey,
      this.vapidKeys.privateKey
    );
  }

  get publicKey(): string {
    return this.vapidKeys.publicKey;
  }

  /** Save or update a push subscription. */
  subscribe(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    sessionIds: string[],
    triggers: PushSubscriptionRecord["triggers"]
  ): void {
    const existing = this.subscriptions.find(s => s.endpoint === subscription.endpoint);
    if (existing) {
      existing.keys = subscription.keys;
      existing.sessionIds = sessionIds;
      existing.triggers = triggers;
    } else {
      this.subscriptions.push({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        sessionIds,
        triggers,
        createdAt: Date.now(),
      });
    }
    this.saveSubscriptions();
  }

  /** Remove a push subscription by endpoint. */
  unsubscribe(endpoint: string): boolean {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(s => s.endpoint !== endpoint);
    if (this.subscriptions.length !== before) {
      this.saveSubscriptions();
      return true;
    }
    return false;
  }

  /** Get all subscriptions that should receive a notification for a given session + trigger. */
  getSubscriptionsFor(
    sessionId: string,
    trigger: "activityStopped" | "activitySpiked" | "sessionExited"
  ): PushSubscriptionRecord[] {
    return this.subscriptions.filter(sub => {
      // Check trigger is enabled
      if (!sub.triggers[trigger]) return false;
      // Check session filter (empty = all sessions)
      if (sub.sessionIds.length > 0 && !sub.sessionIds.includes(sessionId)) return false;
      return true;
    });
  }

  /** Send a push notification. Removes expired subscriptions automatically. */
  async sendPush(
    sessionId: string,
    sessionName: string,
    message: string,
    trigger: "activityStopped" | "activitySpiked" | "sessionExited",
    appUrl?: string
  ): Promise<number> {
    const subs = this.getSubscriptionsFor(sessionId, trigger);
    if (subs.length === 0) return 0;

    const payload = JSON.stringify({
      title: `relay-tty: ${sessionName}`,
      body: message,
      url: appUrl ? `${appUrl}/sessions/${sessionId}` : `/sessions/${sessionId}`,
      sessionId,
      trigger,
      timestamp: Date.now(),
    });

    let sent = 0;
    const expired: string[] = [];

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            payload,
            { TTL: 3600 } // 1 hour
          );
          sent++;
        } catch (err: any) {
          // 410 Gone or 404 = subscription expired, remove it
          if (err.statusCode === 410 || err.statusCode === 404) {
            expired.push(sub.endpoint);
          }
          // Other errors (network, etc.) — log but don't remove
          else {
            console.error(
              `Push failed for ${sub.endpoint.slice(0, 50)}...:`,
              `status=${err.statusCode}`,
              err.body || err.message || err
            );
          }
        }
      })
    );

    // Clean up expired subscriptions
    if (expired.length > 0) {
      this.subscriptions = this.subscriptions.filter(s => !expired.includes(s.endpoint));
      this.saveSubscriptions();
    }

    return sent;
  }

  /** List all subscriptions (for admin/debug). */
  list(): PushSubscriptionRecord[] {
    return [...this.subscriptions];
  }

  // --- Private ---

  private loadOrGenerateVapid(): VapidKeys {
    try {
      const raw = fs.readFileSync(VAPID_FILE, "utf-8");
      const keys = JSON.parse(raw) as VapidKeys;
      if (keys.publicKey && keys.privateKey) return keys;
    } catch {}

    // Generate new VAPID keys
    const keys = webpush.generateVAPIDKeys();
    const vapid: VapidKeys = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2) + "\n");
    console.log("Generated new VAPID keys for Web Push");
    return vapid;
  }

  private loadSubscriptions(): void {
    try {
      const raw = fs.readFileSync(SUBSCRIPTIONS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.subscriptions = parsed;
      }
    } catch {
      this.subscriptions = [];
    }
  }

  private saveSubscriptions(): void {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(this.subscriptions, null, 2) + "\n");
  }
}
