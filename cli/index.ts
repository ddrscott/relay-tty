#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerRunCommand } from "./commands/run.js";
import { registerAttachCommand } from "./commands/attach.js";
import { registerListCommand } from "./commands/list.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerServerCommand } from "./commands/server.js";
import { registerShareCommand } from "./commands/share.js";
import { registerSetPasswordCommand } from "./commands/set-password.js";
import { registerTuiCommand } from "./commands/tui.js";
import { registerInfoCommand } from "./commands/info.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf-8")
);

const program = new Command();

program
  .name("relay")
  .description("Terminal relay — run commands and access them from anywhere")
  .version(pkg.version)
  .enablePositionalOptions()
  .passThroughOptions();

// Default command: relay <command> [args...]
registerRunCommand(program);

// Subcommands
registerAttachCommand(program);
registerListCommand(program);
registerStopCommand(program);
registerShareCommand(program);
registerSetPasswordCommand(program);
registerTuiCommand(program);
registerInfoCommand(program);
registerServerCommand(program);

program.parse();
