#!/usr/bin/env node
import { Command } from "commander";
import { ensureWindowsConsoleUtf8 } from "./platform/service-manager-common.js";
import { DEFAULT_RELAY_SERVER_URL, ensureUserEnvFile, loadAgentEnv } from "./config/env.js";
import { pairCommand, resolvePairProfile } from "./commands/pair.js";
import { sendFileCommand } from "./commands/send-file.js";
import { hermesFileTransferOutcomeCommand } from "./commands/hermes-file-transfer-outcome.js";
import {
  installCommand,
  uninstallCommand,
  uninstallAllCommand,
  stopCommand,
  stopAllCommand,
  restartCommand,
  restartAllCommand,
  resetCommand,
  resetAllCommand,
  listManageableServiceProfiles,
  listResettableProfiles,
} from "./commands/install.js";
import {
  formatShortTargetHint,
  parsePairGatewayTarget,
  resolveImplicitSingleProfileTarget,
  resolveProfileCommandTarget,
} from "./commands/cli-target.js";
import { statusCommand } from "./commands/status.js";
import { setTokenCommand } from "./commands/set-token.js";
import { updateCommand } from "./commands/update.js";
import { configExists } from "./config/config.js";
import { getServiceStatus } from "./platform/service-manager.js";
import { t } from "./i18n/index.js";
import { listProfileNames, setActiveProfile } from "./config/profile.js";
import {
  MAIN_HELP_TEXT,
  PAIR_HERMES_HELP_TEXT,
  PAIR_OPENCLAW_HELP_TEXT,
  RESET_PROFILE_HELP_TEXT,
  resetCommandForProfile,
} from "./commands/profile-hints.js";
import { CLAWCONNECT_AGENT_VERSION } from "./runtime-metadata.js";

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
  force?: boolean;
};

async function runPairCommand(opts: PairCliOptions): Promise<void> {
  const profile = resolvePairProfile(opts);
  setActiveProfile(profile);
  await pairCommand({
    ...opts,
    profile,
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
    process.exitCode = 1;
    console.error(t("install.noPairedProfiles"));
    return;
  }

  for (const profile of profiles) {
    runWithProfile(profile === "default" ? undefined : profile, installCommand);
  }
}

function runProfileError(err: unknown): never {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
}

function defaultProfileHasRuntimeState(): boolean {
  return configExists(undefined) || getServiceStatus(undefined).installed;
}

function runServiceLifecycleCommand(
  verb: "restart" | "stop",
  target: string | undefined,
  opts: { profile?: string; local?: boolean; all?: boolean },
): void {
  let resolved;
  try {
    resolved = resolveProfileCommandTarget({
      target,
      profile: opts.profile,
      local: opts.local,
      all: opts.all,
      allowAll: true,
    });
  } catch (err) {
    runProfileError(err);
  }

  if (resolved.kind === "all") {
    if (verb === "restart") restartAllCommand();
    else stopAllCommand();
    return;
  }

  const action = verb === "restart" ? restartCommand : stopCommand;
  if (resolved.explicit) {
    runWithProfile(resolved.profile, action);
    return;
  }

  const implicit = resolveImplicitSingleProfileTarget({
    defaultHasState: defaultProfileHasRuntimeState(),
    profiles: listManageableServiceProfiles(),
  });
  if (implicit.kind === "ambiguous") {
    process.exitCode = 1;
    const hints = [
      ...implicit.profiles.map((name) => formatShortTargetHint(verb, name)),
      `clawc ${verb === "restart" ? "rs" : "stop"} all`,
    ];
    console.error(
      `Multiple profiles detected (${implicit.profiles.join(", ")}). Specify a target:\n  ${hints.join("\n  ")}`,
    );
    return;
  }
  runWithProfile(implicit.profile, action);
}

program
  .name("clawconnect")
  .description("ClawConnect host agent (short alias: clawc) — connects OpenClaw/Hermes hosts to your relay server")
  .version(CLAWCONNECT_AGENT_VERSION)
  .addHelpText("after", MAIN_HELP_TEXT);

program
  .command("pair [target]")
  .description("Register with relay server and display QR code (target: openclaw/oc or hermes/hm)")
  .option(
    "-s, --server <url>",
    `Relay server URL (default: CLAWCONNECT_RELAY_SERVER_URL or ${DEFAULT_RELAY_SERVER_URL})`
  )
  .option("-n, --name <name>", "Display name for this host")
  .option("--gateway-type <type>", "Gateway type: openclaw or hermes (default profile matches type)")
  .option(...profileOption)
  .option("--local", `Use local relay server (${LOCAL_RELAY_SERVER_URL}) with an isolated *-local profile (never overwrites online config)`, false)
  .option("-f, --force", "Force registering a new gateway even if already paired", false)
  .option("--code-only", "Print only the access code and skip QR code output", false)
  .action(async (target: string | undefined, opts: PairCliOptions) => {
    try {
      const gatewayType = parsePairGatewayTarget(target, opts.gatewayType) ?? "openclaw";
      await runPairCommand({
        ...opts,
        gatewayType,
      });
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("pair-openclaw")
  .description("Shortcut: pair an OpenClaw gateway using profile 'openclaw' (or 'openclaw-local' with --local)")
  .option(
    "-s, --server <url>",
    `Relay server URL (default: CLAWCONNECT_RELAY_SERVER_URL or ${DEFAULT_RELAY_SERVER_URL})`
  )
  .option("-n, --name <name>", "Display name for this host")
  .option("--local", `Use local relay server (${LOCAL_RELAY_SERVER_URL}) with isolated profile 'openclaw-local'`, false)
  .option("-f, --force", "Force registering a new gateway even if already paired", false)
  .option("--code-only", "Print only the access code and skip QR code output", false)
  .addHelpText("after", PAIR_OPENCLAW_HELP_TEXT)
  .action(async (opts: PairCliOptions) => {
    try {
      await runPairCommand({
        ...opts,
        gatewayType: "openclaw",
      });
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("pair-hermes")
  .description("Shortcut: pair a Hermes Agent gateway using profile 'hermes' (or 'hermes-local' with --local)")
  .option(
    "-s, --server <url>",
    `Relay server URL (default: CLAWCONNECT_RELAY_SERVER_URL or ${DEFAULT_RELAY_SERVER_URL})`
  )
  .option("-n, --name <name>", "Display name for this host")
  .option("--local", `Use local relay server (${LOCAL_RELAY_SERVER_URL}) with isolated profile 'hermes-local'`, false)
  .option("-f, --force", "Force registering a new gateway even if already paired", false)
  .option("--code-only", "Print only the access code and skip QR code output", false)
  .addHelpText("after", PAIR_HERMES_HELP_TEXT)
  .action(async (opts: PairCliOptions) => {
    try {
      await runPairCommand({
        ...opts,
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
  .option("-s, --session <key>", "Explicit target chat session key (required for OpenClaw)")
  .option("--source-run-id <id>", "Explicit message/run ID this file belongs to (required for OpenClaw)")
  .option("--hermes-session-id <id>", "Hermes session ID (passed by clawconnect-mobile plugin)")
  .option(...profileOption)
  .option("--json", "Print the upload result as JSON", false)
  .action(async (filePath: string, opts: { gateway?: string; session?: string; sourceRunId?: string; hermesSessionId?: string; profile?: string; json?: boolean }) => {
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
  .command("hermes-file-transfer-outcome")
  .description("Emit a typed Hermes mobile file-transfer outcome for the terminal receipt")
  .requiredOption("--json <payload>", "JSON object with kind and sourceRunId")
  .action((opts: { json: string }) => {
    try {
      hermesFileTransferOutcomeCommand(opts.json);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("run [target]")
  .description("Run relay client in foreground (used by the background service manager)")
  .option(...profileOption)
  .option("--local", "Target the isolated local relay profile (with oc/hm target)", false)
  .action(async (target: string | undefined, opts: { profile?: string; local?: boolean }) => {
    try {
      const resolved = resolveProfileCommandTarget({
        target,
        profile: opts.profile,
        local: opts.local,
        allowAll: false,
      });
      if (resolved.kind !== "profile") return;
      setActiveProfile(resolved.profile);
      // 运行时模块包含 OpenClaw/Hermes 路径与子进程环境快照；必须在 .env 加载后再初始化。
      const { runCommand } = await import("./commands/run.js");
      await runCommand();
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("stop [target]")
  .description("Stop relay client background service (target: oc/openclaw, hm/hermes, all, or profile)")
  .option(...profileOption)
  .option("--local", "Target the isolated local relay profile (with oc/hm target)", false)
  .option("--all", "Stop background services for all profiles", false)
  .action((target: string | undefined, opts: { profile?: string; local?: boolean; all?: boolean }) => {
    runServiceLifecycleCommand("stop", target, opts);
  });

program
  .command("stop-openclaw")
  .description("Shortcut: stop the OpenClaw profile service")
  .option("--local", "Target the isolated local relay profile (openclaw-local)", false)
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", stopCommand);
  });

program
  .command("stop-hermes")
  .description("Shortcut: stop the Hermes Agent profile service")
  .option("--local", "Target the isolated local relay profile (hermes-local)", false)
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "hermes-local" : "hermes", stopCommand);
  });

program
  .command("status [target]")
  .alias("st")
  .description("Show pairing config, gateway URL, and background service status (all paired profiles by default)")
  .option(...profileOption)
  .option("--local", "Target the isolated local relay profile (with oc/hm target)", false)
  .action((target: string | undefined, opts: { profile?: string; local?: boolean }) => {
    let resolved;
    try {
      resolved = resolveProfileCommandTarget({
        target,
        profile: opts.profile,
        local: opts.local,
        allowAll: true,
      });
    } catch (err) {
      runProfileError(err);
    }
    if (resolved.kind === "all") {
      setActiveProfile(undefined);
      statusCommand({ profile: "all", explicitProfile: true });
      return;
    }
    setActiveProfile(resolved.profile);
    statusCommand({
      profile: resolved.explicit ? (resolved.profile ?? "default") : undefined,
      explicitProfile: resolved.explicit,
    });
  });

program
  .command("status-all")
  .description("Shortcut: show all paired ClawConnect profiles")
  .action(() => {
    setActiveProfile(undefined);
    statusCommand({ profile: "all", explicitProfile: true });
  });

program
  .command("install [target]")
  .description("Register as a background service (launchd on macOS, systemd --user on Linux, Windows Service on Windows, requires an elevated terminal)")
  .option(...profileOption)
  .option("--local", "Target the isolated local relay profile (with oc/hm target)", false)
  .action((target: string | undefined, opts: { profile?: string; local?: boolean }) => {
    let resolved;
    try {
      resolved = resolveProfileCommandTarget({
        target,
        profile: opts.profile,
        local: opts.local,
        allowAll: true,
      });
    } catch (err) {
      runProfileError(err);
    }
    if (resolved.kind === "all" || !resolved.explicit) {
      runInstallCommand({});
      return;
    }
    runWithProfile(resolved.profile, installCommand);
  });

program
  .command("install-openclaw")
  .description("Shortcut: install the OpenClaw profile background service")
  .option("--local", "Target the isolated local relay profile (openclaw-local)", false)
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", installCommand);
  });

program
  .command("install-hermes")
  .description("Shortcut: install the Hermes Agent profile background service")
  .option("--local", "Target the isolated local relay profile (hermes-local)", false)
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "hermes-local" : "hermes", installCommand);
  });

program
  .command("restart [target]")
  .alias("rs")
  .description("Restart the relay background service (target: oc/openclaw, hm/hermes, all, or profile)")
  .option(...profileOption)
  .option("--local", "Target the isolated local relay profile (with oc/hm target)", false)
  .option("--all", "Restart background services for all profiles", false)
  .action((target: string | undefined, opts: { profile?: string; local?: boolean; all?: boolean }) => {
    runServiceLifecycleCommand("restart", target, opts);
  });

program
  .command("restart-openclaw")
  .description("Shortcut: restart the OpenClaw profile service")
  .option("--local", "Target the isolated local relay profile (openclaw-local)", false)
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", restartCommand);
  });

program
  .command("restart-hermes")
  .description("Shortcut: restart the Hermes Agent profile service")
  .option("--local", "Target the isolated local relay profile (hermes-local)", false)
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "hermes-local" : "hermes", restartCommand);
  });

program
  .command("uninstall [target]")
  .description("Remove background service definition (target: oc/openclaw, hm/hermes, all, or profile)")
  .option(...profileOption)
  .option("--local", "Target the isolated local relay profile (with oc/hm target)", false)
  .option("--all", "Remove background service definitions for all profiles", false)
  .action((target: string | undefined, opts: { profile?: string; local?: boolean; all?: boolean }) => {
    let resolved;
    try {
      resolved = resolveProfileCommandTarget({
        target,
        profile: opts.profile,
        local: opts.local,
        all: opts.all,
        allowAll: true,
      });
    } catch (err) {
      runProfileError(err);
    }
    if (resolved.kind === "all") {
      uninstallAllCommand();
      return;
    }
    setActiveProfile(resolved.profile);
    uninstallCommand();
  });

program
  .command("uninstall-openclaw")
  .description("Shortcut: remove the OpenClaw profile background service")
  .option("--local", "Target the isolated local relay profile (openclaw-local)", false)
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", uninstallCommand);
  });

program
  .command("uninstall-hermes")
  .description("Shortcut: remove the Hermes Agent profile background service")
  .option("--local", "Target the isolated local relay profile (hermes-local)", false)
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "hermes-local" : "hermes", uninstallCommand);
  });

program
  .command("uninstall-all")
  .description("Shortcut: remove background services for all profiles")
  .action(() => {
    uninstallAllCommand();
  });

program
  .command("set-token [target]")
  .description("Set the local OpenClaw gateway token (needed when using token auth)")
  .option(...profileOption)
  .option("--local", "Target the isolated local relay profile (with oc/hm target)", false)
  .action(async (target: string | undefined, opts: { profile?: string; local?: boolean }) => {
    try {
      const resolved = resolveProfileCommandTarget({
        target,
        profile: opts.profile,
        local: opts.local,
        allowAll: false,
      });
      if (resolved.kind !== "profile") return;
      if (resolved.explicit) {
        setActiveProfile(resolved.profile);
      } else {
        const implicit = resolveImplicitSingleProfileTarget({
          defaultHasState: configExists(undefined),
          profiles: listProfileNames(),
        });
        if (implicit.kind === "ambiguous") {
          const hints = implicit.profiles.map((name) => formatShortTargetHint("set-token", name));
          throw new Error(`Multiple profiles detected (${implicit.profiles.join(", ")}). Specify a target:\n  ${hints.join("\n  ")}`);
        }
        setActiveProfile(implicit.profile);
      }
      await setTokenCommand();
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("reset [target]")
  .description("Uninstall service and clear saved config, logs, backups, and outbox for a profile")
  .option(...profileOption)
  .option("--local", "Target the isolated local relay profile (with oc/hm target)", false)
  .option("--all", "Reset all profiles (OpenClaw, Hermes, default, and custom)", false)
  .addHelpText("after", RESET_PROFILE_HELP_TEXT)
  .action((target: string | undefined, opts: { profile?: string; local?: boolean; all?: boolean }) => {
    let resolved;
    try {
      resolved = resolveProfileCommandTarget({
        target,
        profile: opts.profile,
        local: opts.local,
        all: opts.all,
        allowAll: true,
      });
    } catch (err) {
      runProfileError(err);
    }
    if (resolved.kind === "all") {
      resetAllCommand();
      return;
    }
    if (resolved.explicit) {
      setActiveProfile(resolved.profile);
      resetCommand();
      return;
    }
    const defaultHasState = configExists(undefined) || getServiceStatus(undefined).installed;
    if (defaultHasState) {
      setActiveProfile(undefined);
      resetCommand();
      return;
    }
    const others = listResettableProfiles().filter((name) => name !== "default");
    if (others.length > 0) {
      const commands = [...others.map((name) => resetCommandForProfile(name)), "clawconnect reset-all"];
      console.log(t("install.resetDefaultNotFoundWithOthers", others.join(", "), commands.join("\n  ")));
      return;
    }
    setActiveProfile(undefined);
    resetCommand();
  });

program
  .command("reset-openclaw")
  .description("Shortcut: completely reset the OpenClaw profile")
  .option("--local", "Target the isolated local relay profile (openclaw-local)", false)
  .addHelpText("after", "Equivalent to: clawconnect reset --profile openclaw (or openclaw-local with --local)\n")
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", resetCommand);
  });

program
  .command("reset-hermes")
  .description("Shortcut: completely reset the Hermes Agent profile")
  .option("--local", "Target the isolated local relay profile (hermes-local)", false)
  .addHelpText("after", "Equivalent to: clawconnect reset --profile hermes (or hermes-local with --local)\n")
  .action((opts: { local?: boolean }) => {
    runWithProfile(opts.local ? "hermes-local" : "hermes", resetCommand);
  });

program
  .command("reset-all")
  .description("Shortcut: completely reset all paired profiles")
  .action(() => {
    resetAllCommand();
  });

program
  .command("update")
  .alias("up")
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
