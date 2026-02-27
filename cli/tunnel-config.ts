import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const CONFIG_DIR = path.join(os.homedir(), ".config", "relay-tty");
const TUNNEL_FILE = path.join(CONFIG_DIR, "tunnel.json");
const MACHINE_ID_FILE = path.join(CONFIG_DIR, "machine-id");

const RELAY_API = "https://relaytty.com";

export interface TunnelConfig {
  api_key: string;
  slug: string;
  url: string;
}

/** Read saved tunnel config, or null if not yet set up. */
export function readTunnelConfig(): TunnelConfig | null {
  try {
    const raw = fs.readFileSync(TUNNEL_FILE, "utf-8");
    return JSON.parse(raw) as TunnelConfig;
  } catch {
    return null;
  }
}

/** Write tunnel config to disk. */
export function writeTunnelConfig(config: TunnelConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TUNNEL_FILE, JSON.stringify(config, null, 2) + "\n");
}

/** Get or generate a stable machine ID. */
export function getMachineId(): string {
  try {
    return fs.readFileSync(MACHINE_ID_FILE, "utf-8").trim();
  } catch {
    const id = crypto.randomBytes(16).toString("hex");
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(MACHINE_ID_FILE, id + "\n");
    return id;
  }
}

/**
 * Auto-provision a tunnel — no prompts, no email required.
 *
 * 1. POST /api/account with machine_id → get API key
 * 2. POST /api/tunnels → get slug
 * 3. Save config
 *
 * If the machine_id already has an account, the server returns
 * a fresh API key for it (idempotent).
 */
export async function setupTunnel(): Promise<TunnelConfig> {
  const machineId = getMachineId();

  // Create anonymous account keyed by machine_id
  console.error("Provisioning tunnel...");
  const accountRes = await fetch(`${RELAY_API}/api/account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine_id: machineId }),
  });

  if (!accountRes.ok) {
    const text = await accountRes.text();
    throw new Error(`Account provisioning failed: ${text}`);
  }

  const account = (await accountRes.json()) as {
    id: string;
    api_key: string;
  };

  // Register tunnel with machine_id for deterministic slug
  const tunnelRes = await fetch(`${RELAY_API}/api/tunnels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.api_key}`,
    },
    body: JSON.stringify({ machine_id: machineId }),
  });

  if (!tunnelRes.ok) {
    const text = await tunnelRes.text();
    throw new Error(`Tunnel registration failed: ${text}`);
  }

  const tunnelInfo = (await tunnelRes.json()) as {
    slug: string;
    url: string;
  };

  const config: TunnelConfig = {
    api_key: account.api_key,
    slug: tunnelInfo.slug,
    url: tunnelInfo.url,
  };

  writeTunnelConfig(config);
  console.error(`Config saved to ${TUNNEL_FILE}`);

  return config;
}
