#!/usr/bin/env node

import { Command } from "commander";
import { registerRunCommand } from "./commands/run.js";
import { registerAttachCommand } from "./commands/attach.js";
import { registerListCommand } from "./commands/list.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerServerCommand } from "./commands/server.js";
import { registerShareCommand } from "./commands/share.js";
import { registerTuiCommand } from "./commands/tui.js";

const program = new Command();

program
  .name("relay")
  .description("Terminal relay — run commands and access them from anywhere")
  .version("1.0.0")
  .enablePositionalOptions()
  .passThroughOptions();

// Default command: relay <command> [args...]
registerRunCommand(program);

// Subcommands
registerAttachCommand(program);
registerListCommand(program);
registerStopCommand(program);
registerShareCommand(program);
registerTuiCommand(program);
registerServerCommand(program);

program.parse();
