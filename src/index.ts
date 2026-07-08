#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "module";
import { ensureWindowsConsoleUtf8 } from "./platform/service-manager-common.js";
import { DEFAULT_RELAY_SERVER_URL, ensureUserEnvFile, loadAgentEnv } from "./config/env.js";
import { pairCommand } from "./commands/pair.js";
import { runCommand } from "./commands/run.js";
import { sendFileCommand } from "./commands/send-file.js";
import { installCommand, uninstallCommand, stopCommand, restartCommand, resetCommand } from "./commands/install.js";
import { statusCommand } from "./commands/status.js";
import { setTokenCommand } from "./commands/set-token.js";
import { updateCommand } from "./commands/update.js";
import { listProfileNames, setActiveProfile } from "./config/profile.js";
import {
  MAIN_HELP_TEXT,
  PAIR_HERMES_HELP_TEXT,
  PAIR_OPENCLAW_HELP_TEXT,
  RESET_PROFILE_HELP_TEXT,
} from "./commands/profile-hints.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
ensureUserEnvFile();
loadAgentEnv();
ensureWindowsConsoleUtf8();

const program = new Command();
const profileOption = ["-p, --profile <name>", "Profile name (for example: hermes, openclaw). Shortcut commands use isolated profiles."] as const;
const LOCAL_RELAY_SERVER_URL = "http://127.0.0.1:8080";

type PairCliOptions = {
  server?: string;
  name?: string;
  gatewayType?: string;
  profile?: string;
  codeOnly?: boolean;
  local?: boolean;
};

async function runPairCommand(opts: PairCliOptions): Promise<void> {
  setActiveProfile(opts.profile);
  await pairCommand({
    ...opts,
    server: opts.local ? LOCAL_RELAY_SERVER_URL : opts.server,
  });
}

function runWithProfile(profile: string | undefined, action: () => void): void {
  setActiveProfile(profile);
  action();
}

function runInstallCommand(opts: { profile?: string }): void {
  if (opts.profile) {
    runWithProfile(opts.profile, installCommand);
    return;
  }

  const profiles = listProfileNames();
  if (profiles.length === 0) {
    runWithProfile(undefined, installCommand);
    return;
  }

  for (const profile of profiles) {
    runWithProfile(profile === "default" ? undefined : profile, installCommand);
  }
}

program
  .name("clawconnect")
  .description("ClawConnect host agent — connects OpenClaw gateway hosts to your relay server")
  .version(version)
  .addHelpText("after", MAIN_HELP_TEXT);

program
  .command("pair")
  .description("Register with relay server and display QR code for iOS pairing")
  .option(
    "-s, --server <url>",
    `Relay server URL (default: CLAWCONNECT_RELAY_SERVER_URL or ${DEFAULT_RELAY_SERVER_URL})`
  )
  .option("-n, --name <name>", "Display name for this host")
  .option("--gateway-type <type>", "Gateway type: openclaw or hermes", "openclaw")
  .option(...profileOption)
  .option("--local", `Use local relay server (${LOCAL_RELAY_SERVER_URL})`, false)
  .option("--code-only", "Print only the access code and skip QR code output", false)
  .action(async (opts: PairCliOptions) => {
    try {
      await runPairCommand(opts);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("pair-openclaw")
  .description("Shortcut: pair an OpenClaw gateway using profile 'openclaw'")
  .option(
    "-s, --server <url>",
    `Relay server URL (default: CLAWCONNECT_RELAY_SERVER_URL or ${DEFAULT_RELAY_SERVER_URL})`
  )
  .option("-n, --name <name>", "Display name for this host", "Mac OpenClaw")
  .option("--local", `Use local relay server (${LOCAL_RELAY_SERVER_URL})`, false)
  .option("--code-only", "Print only the access code and skip QR code output", false)
  .addHelpText("after", PAIR_OPENCLAW_HELP_TEXT)
  .action(async (opts: PairCliOptions) => {
    try {
      await runPairCommand({
        ...opts,
        profile: "openclaw",
        gatewayType: "openclaw",
      });
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("pair-hermes")
  .description("Shortcut: pair a Hermes Agent gateway using profile 'hermes'")
  .option(
    "-s, --server <url>",
    `Relay server URL (default: CLAWCONNECT_RELAY_SERVER_URL or ${DEFAULT_RELAY_SERVER_URL})`
  )
  .option("-n, --name <name>", "Display name for this host", "Mac Hermes Agent")
  .option("--local", `Use local relay server (${LOCAL_RELAY_SERVER_URL})`, false)
  .option("--code-only", "Print only the access code and skip QR code output", false)
  .addHelpText("after", PAIR_HERMES_HELP_TEXT)
  .action(async (opts: PairCliOptions) => {
    try {
      await runPairCommand({
        ...opts,
        profile: "hermes",
        gatewayType: "hermes",
      });
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("send-file")
  .description("Upload a local file to the paired gateway's chat session")
  .argument("<path>", "Path to the local file")
  .option("-g, --gateway <id>", "Override gateway ID from local config")
  .option("-s, --session <key>", "Target chat session key (defaults to the latest active session)")
  .option("--source-run-id <id>", "Message/run ID this file belongs to")
  .option(...profileOption)
  .option("--json", "Print the upload result as JSON", false)
  .action(async (filePath: string, opts: { gateway?: string; session?: string; sourceRunId?: string; profile?: string; json?: boolean }) => {
    try {
      setActiveProfile(opts.profile);
      await sendFileCommand({
        filePath,
        gateway: opts.gateway,
        session: opts.session,
        sourceRunId: opts.sourceRunId,
        json: opts.json,
      });
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("run")
  .description("Run relay client in foreground (used by the background service manager)")
  .option(...profileOption)
  .action(async (opts: { profile?: string }) => {
    try {
      setActiveProfile(opts.profile);
      await runCommand();
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("stop")
  .description("Stop relay client background service")
  .option(...profileOption)
  .action((opts: { profile?: string }) => {
    setActiveProfile(opts.profile);
    stopCommand();
  });

program
  .command("stop-openclaw")
  .description("Shortcut: stop the OpenClaw profile service")
  .action(() => {
    runWithProfile("openclaw", stopCommand);
  });

program
  .command("stop-hermes")
  .description("Shortcut: stop the Hermes Agent profile service")
  .action(() => {
    runWithProfile("hermes", stopCommand);
  });

program
  .command("status")
  .description("Show pairing config, gateway URL, and background service status")
  .option(...profileOption)
  .action((opts: { profile?: string }) => {
    setActiveProfile(opts.profile === "all" ? undefined : opts.profile);
    statusCommand(opts);
  });

program
  .command("status-all")
  .description("Shortcut: show all paired ClawConnect profiles")
  .action(() => {
    setActiveProfile(undefined);
    statusCommand({ profile: "all" });
  });

program
  .command("install")
  .description("Register as a background service (launchd on macOS, systemd --user on Linux, Startup on Windows)")
  .option(...profileOption)
  .action((opts: { profile?: string }) => {
    runInstallCommand(opts);
  });

program
  .command("install-openclaw")
  .description("Shortcut: install the OpenClaw profile background service")
  .action(() => {
    runWithProfile("openclaw", installCommand);
  });

program
  .command("install-hermes")
  .description("Shortcut: install the Hermes Agent profile background service")
  .action(() => {
    runWithProfile("hermes", installCommand);
  });

program
  .command("restart")
  .description("Restart the relay background service")
  .option(...profileOption)
  .action((opts: { profile?: string }) => {
    setActiveProfile(opts.profile);
    restartCommand();
  });

program
  .command("restart-openclaw")
  .description("Shortcut: restart the OpenClaw profile service")
  .action(() => {
    runWithProfile("openclaw", restartCommand);
  });

program
  .command("restart-hermes")
  .description("Shortcut: restart the Hermes Agent profile service")
  .action(() => {
    runWithProfile("hermes", restartCommand);
  });

program
  .command("uninstall")
  .description("Remove background service")
  .option(...profileOption)
  .action((opts: { profile?: string }) => {
    setActiveProfile(opts.profile);
    uninstallCommand();
  });

program
  .command("set-token")
  .description("Set the local OpenClaw gateway token (needed when using token auth)")
  .option(...profileOption)
  .action(async (opts: { profile?: string }) => {
    try {
      setActiveProfile(opts.profile);
      await setTokenCommand();
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("reset")
  .description("Clear saved config and stop service — use with --profile when resetting pair-openclaw or pair-hermes")
  .option(...profileOption)
  .addHelpText("after", RESET_PROFILE_HELP_TEXT)
  .action((opts: { profile?: string }) => {
    setActiveProfile(opts.profile);
    resetCommand();
  });

program
  .command("reset-openclaw")
  .description("Shortcut: reset the OpenClaw profile")
  .addHelpText("after", "Equivalent to: clawconnect reset --profile openclaw\n")
  .action(() => {
    runWithProfile("openclaw", resetCommand);
  });

program
  .command("reset-hermes")
  .description("Shortcut: reset the Hermes Agent profile")
  .addHelpText("after", "Equivalent to: clawconnect reset --profile hermes\n")
  .action(() => {
    runWithProfile("hermes", resetCommand);
  });

program
  .command("update")
  .description("Upgrade the globally installed clawconnect-agent package to the latest npm version")
  .action(() => {
    try {
      updateCommand(import.meta.url);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse(process.argv);
