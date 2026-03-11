import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const RELAY_DIR = path.join(os.homedir(), ".relay-tty");
const NOTIFICATIONS_FILE = path.join(RELAY_DIR, "notifications.json");
const MAX_NOTIFICATIONS = 100;

export interface StoredNotification {
  id: string;
  sessionId: string;
  sessionName: string;
  message: string;
  timestamp: number;
}

/**
 * Server-side notification history — persisted to ~/.relay-tty/notifications.json
 * so all connected devices see the same history.
 */
export class NotificationStore {
  private notifications: StoredNotification[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(NOTIFICATIONS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.notifications = parsed;
      }
    } catch {
      this.notifications = [];
    }
  }

  private save(): void {
    fs.mkdirSync(RELAY_DIR, { recursive: true });
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(this.notifications, null, 2) + "\n");
  }

  list(): StoredNotification[] {
    return [...this.notifications];
  }

  add(sessionId: string, sessionName: string, message: string): StoredNotification {
    const entry: StoredNotification = {
      id: crypto.randomBytes(4).toString("hex"),
      sessionId,
      sessionName,
      message,
      timestamp: Date.now(),
    };
    this.notifications.push(entry);
    // Trim to max
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(-MAX_NOTIFICATIONS);
    }
    this.save();
    return entry;
  }

  delete(id: string): boolean {
    const before = this.notifications.length;
    this.notifications = this.notifications.filter(n => n.id !== id);
    if (this.notifications.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  clear(): void {
    this.notifications = [];
    this.save();
  }
}
