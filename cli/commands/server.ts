import type { Command } from "commander";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dim, cyan, boldGreen } from "../../server/log.js";

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

      const child = spawn("node", [serverPath], {
        stdio: "inherit",
        env: {
          ...process.env,
          PORT: port,
          NODE_ENV: "production",
        },
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
        await startTunnel(parseInt(port, 10));
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
}

async function startTunnel(port: number): Promise<void> {
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
      // Try to show QR code
      try {
        const qrcode = await import("qrcode-terminal");
        qrcode.default.generate(url, { small: true }, (qr: string) => {
          console.log(qr);
        });
      } catch {
        // qrcode-terminal not installed, skip
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
