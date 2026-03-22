import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { createHash } from "node:crypto";

const RELAY_DIR = path.join(os.homedir(), ".relay-tty");
const PASSWD_FILE = path.join(RELAY_DIR, "passwd");

function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    // Hide input on TTY
    if (process.stdin.isTTY) {
      process.stderr.write(prompt);
      const stdin = process.stdin as typeof process.stdin & { setRawMode?: (mode: boolean) => void };
      stdin.setRawMode?.(true);
      let password = "";
      const onData = (ch: Buffer) => {
        const c = ch.toString();
        if (c === "\n" || c === "\r" || c === "\u0004") {
          stdin.setRawMode?.(false);
          process.stdin.removeListener("data", onData);
          process.stderr.write("\n");
          rl.close();
          resolve(password);
        } else if (c === "\u0003") {
          // Ctrl+C
          stdin.setRawMode?.(false);
          process.exit(1);
        } else if (c === "\u007f" || c === "\b") {
          // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
          }
        } else {
          password += c;
        }
      };
      process.stdin.on("data", onData);
    } else {
      // Non-TTY: read from stdin
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

export function registerSetPasswordCommand(program: Command) {
  program
    .command("set-password")
    .description("set or clear the global relay password for share links")
    .option("--clear", "remove the stored password")
    .action(async (opts) => {
      if (opts.clear) {
        try {
          fs.unlinkSync(PASSWD_FILE);
          process.stderr.write("Password cleared.\n");
        } catch {
          process.stderr.write("No password was set.\n");
        }
        return;
      }

      const password = await readPassword("New relay password: ");
      if (!password) {
        process.stderr.write("Error: password cannot be empty.\n");
        process.exit(1);
      }

      const confirm = await readPassword("Confirm password: ");
      if (password !== confirm) {
        process.stderr.write("Error: passwords do not match.\n");
        process.exit(1);
      }

      const hash = createHash("sha256").update(password).digest("hex");
      fs.mkdirSync(RELAY_DIR, { recursive: true });
      fs.writeFileSync(PASSWD_FILE, hash + "\n", { mode: 0o600 });
      process.stderr.write("Password set.\n");
    });
}
