#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "module";
import { pairCommand } from "./commands/pair.js";
import { runCommand } from "./commands/run.js";
import { installCommand, uninstallCommand, stopCommand, restartCommand, resetCommand } from "./commands/install.js";
import { statusCommand } from "./commands/status.js";
import { setTokenCommand } from "./commands/set-token.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("clawconnect")
  .description("ClawConnect host agent — connects OpenClaw gateway hosts to your relay server")
  .version(version);

program
  .command("pair")
  .description("Register with relay server and display QR code for iOS pairing")
  .option("-s, --server <url>", "Relay server URL", "http://223.109.141.71")
  .option("-n, --name <name>", "Display name for this host")
  .option("--code-only", "Print only the access code and skip QR code output", false)
  .action(async (opts: { server: string; name: string; codeOnly?: boolean }) => {
    try {
      await pairCommand(opts);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("run")
  .description("Run relay client in foreground (used by the background service manager)")
  .action(async () => {
    try {
      await runCommand();
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("stop")
  .description("Stop relay client background service")
  .action(() => {
    stopCommand();
  });

program
  .command("status")
  .description("Show pairing config, gateway URL, and background service status")
  .action(() => {
    statusCommand();
  });

program
  .command("install")
  .description("Register as a background service (launchd on macOS, systemd --user on Linux)")
  .action(() => {
    installCommand();
  });

program
  .command("restart")
  .description("Restart the relay background service")
  .action(() => {
    restartCommand();
  });

program
  .command("uninstall")
  .description("Remove background service")
  .action(() => {
    uninstallCommand();
  });

program
  .command("set-token")
  .description("Set the local OpenClaw gateway token (needed when using token auth)")
  .action(async () => {
    try {
      await setTokenCommand();
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("reset")
  .description("Clear saved config and stop service — use when switching servers or on auth errors")
  .action(() => {
    resetCommand();
  });

program.parse(process.argv);
