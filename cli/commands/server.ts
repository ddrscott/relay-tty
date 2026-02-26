import type { Command } from "commander";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function registerServerCommand(program: Command) {
  const serverCmd = program
    .command("server")
    .description("manage the relay-tty server");

  serverCmd
    .command("start")
    .description("start the server in the foreground")
    .option("-p, --port <port>", "port to listen on", "7680")
    .action(async (opts) => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const serverPath = join(__dirname, "..", "..", "server.js");

      const child = spawn("node", [serverPath], {
        stdio: "inherit",
        env: {
          ...process.env,
          PORT: opts.port,
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
