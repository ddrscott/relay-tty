import type { Command } from "commander";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dim, cyan, boldGreen } from "../../server/log.js";

/**
 * Parse a human-readable duration string into seconds.
 * Supports: 30s, 5m, 2h, 7d, 1y, or raw seconds.
 */
function parseDuration(input: string): number {
  const match = input.match(/^(\d+)\s*([smhdy]?)$/i);
  if (!match) {
    const n = parseInt(input, 10);
    if (isNaN(n) || n <= 0) throw new Error(`Invalid duration: ${input}`);
    return n;
  }
  const value = parseInt(match[1], 10);
  const unit = (match[2] || "s").toLowerCase();
  switch (unit) {
    case "s": return value;
    case "m": return value * 60;
    case "h": return value * 3600;
    case "d": return value * 86400;
    case "y": return value * 365 * 86400;
    default: return value;
  }
}

/** Format a TTL in seconds to a human-readable string. */
function formatTtl(seconds: number): string {
  if (seconds >= 365 * 86400) {
    const years = Math.round(seconds / (365 * 86400));
    return `${years}y`;
  }
  if (seconds >= 86400) {
    const days = Math.round(seconds / 86400);
    return `${days}d`;
  }
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    return `${hours}h`;
  }
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60);
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/** Bind to port 0 in the high range, return the OS-assigned port. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        return reject(new Error("Failed to get port"));
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export function registerServerCommand(program: Command) {
  const serverCmd = program
    .command("server")
    .description("manage the relay-tty server");

  serverCmd
    .command("start")
    .description("start the server in the foreground")
    .option("-p, --port <port>", "port to listen on", "7680")
    .option("--tunnel", "expose server via relaytty.com tunnel")
    .option("--token-ttl <duration>", "auth token lifetime (e.g., 7d, 30d, 1y; default: 1y)")
    .action(async (opts, cmd) => {
      // When --tunnel is used and the user didn't explicitly set a port,
      // pick a random available port so we don't clash with a normal server.
      const userSetPort = cmd.getOptionValueSource("port") === "cli";
      let port: string = opts.port;

      if (opts.tunnel && !userSetPort) {
        const freePort = await findFreePort();
        port = String(freePort);
        console.log(dim(`Tunnel mode: using ephemeral port ${port}`));
      }

      const __dirname = dirname(fileURLToPath(import.meta.url));
      // dist/cli/commands/ → three levels up to project root
      const serverPath = join(__dirname, "..", "..", "..", "server.js");

      // In tunnel mode, auto-generate JWT_SECRET if not set
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        PORT: port,
        NODE_ENV: "production",
      };

      if (opts.tunnel && !env.JWT_SECRET) {
        const { getOrCreateJwtSecret } = await import("../tunnel-config.js");
        const secret = getOrCreateJwtSecret();
        env.JWT_SECRET = secret;
        // Also set in current process so auth.js module (loaded for token generation) uses the same secret
        process.env.JWT_SECRET = secret;
        console.log(dim("Auto-generated JWT secret for tunnel auth"));
      }

      const child = spawn("node", [serverPath], {
        stdio: "inherit",
        env,
      });

      child.on("exit", (code) => {
        process.exit(code ?? 1);
      });

      // Forward signals
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => child.kill(sig));
      }

      // Start tunnel if requested
      if (opts.tunnel) {
        const tokenTtl = opts.tokenTtl ? parseDuration(opts.tokenTtl) : 365 * 86400; // default 1 year
        await startTunnel(parseInt(port, 10), tokenTtl);
      }
    });

  serverCmd
    .command("install")
    .description("install as a system service (launchd/systemd)")
    .option("-p, --port <port>", "port to listen on", "7680")
    .action(async (opts) => {
      const { installService } = await import("../../service/install.js");
      await installService(parseInt(opts.port, 10));
    });

  serverCmd
    .command("uninstall")
    .description("uninstall the system service")
    .action(async () => {
      const { uninstallService } = await import("../../service/install.js");
      await uninstallService();
    });

  serverCmd
    .command("new-tunnel-id")
    .description("regenerate machine ID and re-register with tunnel server")
    .action(async () => {
      const {
        MACHINE_ID_FILE,
        getMachineId,
        setupTunnel,
      } = await import("../tunnel-config.js");

      // Delete existing machine-id file
      try {
        fs.unlinkSync(MACHINE_ID_FILE);
        console.error("Deleted old machine ID");
      } catch {
        // No existing file — that's fine
      }

      // Generate new machine ID
      const newId = getMachineId();
      console.error(`Generated new machine ID: ${newId}`);

      // Re-register with tunnel server to get new slug
      try {
        const config = await setupTunnel();
        console.error(`Tunnel URL: ${config.url}`);
      } catch (err: any) {
        console.error(`Warning: tunnel registration failed: ${err.message}`);
        console.error("You can retry later with: relay server start --tunnel");
      }

      // Print the new machine ID to stdout (POSIX convention)
      console.log(newId);

      console.error(
        "\nIf the server is running with --tunnel, restart it to use the new identity."
      );
    });
}

async function startTunnel(port: number, tokenTtlSeconds: number): Promise<void> {
  const {
    readTunnelConfig,
    setupTunnel,
  } = await import("../tunnel-config.js");
  const { TunnelClient } = await import("../../server/tunnel-client.js");

  let config = readTunnelConfig();
  if (!config) {
    config = await setupTunnel();
  }

  // Wait a moment for the server to start listening
  await new Promise((r) => setTimeout(r, 2000));

  const client = new TunnelClient({
    apiKey: config.api_key,
    slug: config.slug,
    localPort: port,
    onConnected: async (url) => {
      console.log(`\n  ${boldGreen("Tunnel active")}: ${cyan(url)}\n`);
      // Generate auth token and show QR code
      try {
        const { generateAccessToken } = await import("../../server/auth.js");
        const token = generateAccessToken(tokenTtlSeconds);
        if (token) {
          const authUrl = `${url}/api/auth/callback?token=${token}`;
          const ttlLabel = formatTtl(tokenTtlSeconds);
          console.log(`  ${dim(`Auth URL (${ttlLabel}):`)} ${cyan(authUrl)}\n`);
          try {
            const qrcode = await import("qrcode-terminal");
            console.log(dim(`  Scan to authenticate (${ttlLabel}):`));
            qrcode.default.generate(authUrl, { small: true }, (qr: string) => {
              process.stderr.write(qr + "\n");
            });
          } catch {
            // qrcode-terminal not installed, skip
          }
        } else {
          console.log(`  ${dim("Warning: could not generate auth token (JWT_SECRET not set)")}`);
        }
      } catch {
        // auth module not available
      }
    },
    onDisconnected: () => {
      console.error("  Tunnel disconnected, reconnecting...");
    },
    onError: (err) => {
      console.error(`  Tunnel error: ${err.message}`);
    },
  });

  client.start();

  // Clean up tunnel on exit
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => client.stop());
  }
}
