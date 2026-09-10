import type { Command } from "commander";
import { openTarget, withSession } from "../directory.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

export function registerSendCommand(program: Command) {
  program
    .command("send <id> [text...]")
    .description("write text to a session's stdin (reads stdin when no text is given)")
    .option("-H, --host <url>", "server URL")
    .option("--enter", "append a carriage return")
    .action(async (id: string, parts: string[], opts) => {
      let text = parts.length ? parts.join(" ") : await readStdin();
      if (opts.enter) text += "\r";
      if (!text) {
        process.stderr.write("Nothing to send\n");
        process.exit(1);
      }
      const target = openTarget(opts.host);
      try {
        await withSession(target, id, async (stream) => {
          stream.sendData(text);
          // Give the transport a moment to flush before close.
          await new Promise((r) => setTimeout(r, 50));
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      }
      process.stderr.write(`Sent ${Buffer.byteLength(text)} bytes to ${id}\n`);
    });
}
