import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchdPlist } from "./templates/launchd.plist.js";
import { systemdService } from "./templates/systemd.service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

function detectPlatform(): "macos" | "linux" {
  const platform = process.platform;
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  throw new Error(`Unsupported platform: ${platform}`);
}

function getNodePath(): string {
  return execSync("which node", { encoding: "utf-8" }).trim();
}

function getJwtSecret(): string | undefined {
  // Check .env file
  const envPath = join(PROJECT_ROOT, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^JWT_SECRET=(.+)$/m);
    if (match) return match[1].trim();
  }
  return process.env.JWT_SECRET;
}

export async function installService(port: number): Promise<void> {
  const platform = detectPlatform();
  const nodePath = getNodePath();
  const serverPath = join(PROJECT_ROOT, "server.js");
  const jwtSecret = getJwtSecret();

  if (platform === "macos") {
    const home = process.env.HOME!;
    const plistDir = join(home, "Library", "LaunchAgents");
    const plistPath = join(plistDir, "com.relay-tty.plist");
    const logDir = join(home, "Library", "Logs", "relay-tty");

    mkdirSync(logDir, { recursive: true });

    const content = launchdPlist({
      nodePath,
      serverPath,
      port,
      logDir,
      jwtSecret,
    });

    writeFileSync(plistPath, content);
    console.log(`Wrote ${plistPath}`);

    try {
      execSync(`launchctl unload ${plistPath} 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // ignore if not loaded
    }
    execSync(`launchctl load ${plistPath}`);
    console.log("Service loaded. relay-tty is running.");
    console.log(`Logs: ${logDir}/`);
  } else {
    const home = process.env.HOME!;
    const serviceDir = join(home, ".config", "systemd", "user");
    const servicePath = join(serviceDir, "relay-tty.service");

    mkdirSync(serviceDir, { recursive: true });

    const content = systemdService({
      nodePath,
      serverPath,
      port,
      jwtSecret,
    });

    writeFileSync(servicePath, content);
    console.log(`Wrote ${servicePath}`);

    execSync("systemctl --user daemon-reload");
    execSync("systemctl --user enable relay-tty");
    execSync("systemctl --user start relay-tty");
    console.log("Service enabled and started.");
    console.log("Logs: journalctl --user -u relay-tty -f");
  }
}

export async function uninstallService(): Promise<void> {
  const platform = detectPlatform();

  if (platform === "macos") {
    const home = process.env.HOME!;
    const plistPath = join(home, "Library", "LaunchAgents", "com.relay-tty.plist");

    if (!existsSync(plistPath)) {
      console.log("Service not installed.");
      return;
    }

    try {
      execSync(`launchctl unload ${plistPath}`);
    } catch {
      // ignore
    }
    unlinkSync(plistPath);
    console.log("Service uninstalled.");
  } else {
    try {
      execSync("systemctl --user stop relay-tty", { stdio: "ignore" });
      execSync("systemctl --user disable relay-tty", { stdio: "ignore" });
    } catch {
      // ignore
    }

    const home = process.env.HOME!;
    const servicePath = join(home, ".config", "systemd", "user", "relay-tty.service");
    if (existsSync(servicePath)) {
      unlinkSync(servicePath);
      execSync("systemctl --user daemon-reload");
    }
    console.log("Service uninstalled.");
  }
}
