#!/usr/bin/env node
import { Command } from "commander";
import { ensureWindowsConsoleUtf8 } from "./platform/service-manager-common.js";
import { DEFAULT_RELAY_SERVER_URL, ensureUserEnvFile, loadAgentEnv } from "./config/env.js";
import { pairCommand, resolvePairProfile } from "./commands/pair.js";
import { sendFileCommand } from "./commands/send-file.js";
import { hermesFileTransferOutcomeCommand } from "./commands/hermes-file-transfer-outcome.js";
import { installCommand, uninstallCommand, uninstallAllCommand, stopCommand, restartCommand, resetCommand, resetAllCommand, listResettableProfiles, } from "./commands/install.js";
import { statusCommand } from "./commands/status.js";
import { setTokenCommand } from "./commands/set-token.js";
import { updateCommand } from "./commands/update.js";
import { configExists } from "./config/config.js";
import { getServiceStatus } from "./platform/service-manager.js";
import { t } from "./i18n/index.js";
import { listProfileNames, setActiveProfile } from "./config/profile.js";
import { MAIN_HELP_TEXT, PAIR_HERMES_HELP_TEXT, PAIR_OPENCLAW_HELP_TEXT, RESET_PROFILE_HELP_TEXT, resetCommandForProfile, } from "./commands/profile-hints.js";
import { CLAWCONNECT_AGENT_VERSION } from "./runtime-metadata.js";
ensureUserEnvFile();
loadAgentEnv();
ensureWindowsConsoleUtf8();
const program = new Command();
const profileOption = ["-p, --profile <name>", "Profile name (for example: hermes, openclaw). Shortcut commands use isolated profiles."];
const LOCAL_RELAY_SERVER_URL = "http://127.0.0.1:8080";
async function runPairCommand(opts) {
    const profile = resolvePairProfile(opts);
    setActiveProfile(profile);
    await pairCommand({
        ...opts,
        profile,
        server: opts.local ? LOCAL_RELAY_SERVER_URL : opts.server,
    });
}
function runWithProfile(profile, action) {
    setActiveProfile(profile);
    action();
}
function runInstallCommand(opts) {
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
program
    .name("clawconnect")
    .description("ClawConnect host agent — connects OpenClaw gateway hosts to your relay server")
    .version(CLAWCONNECT_AGENT_VERSION)
    .addHelpText("after", MAIN_HELP_TEXT);
program
    .command("pair")
    .description("Register with relay server and display QR code for mobile pairing")
    .option("-s, --server <url>", `Relay server URL (default: CLAWCONNECT_RELAY_SERVER_URL or ${DEFAULT_RELAY_SERVER_URL})`)
    .option("-n, --name <name>", "Display name for this host")
    .option("--gateway-type <type>", "Gateway type: openclaw or hermes (default profile matches type)", "openclaw")
    .option(...profileOption)
    .option("--local", `Use local relay server (${LOCAL_RELAY_SERVER_URL}) with an isolated *-local profile (never overwrites online config)`, false)
    .option("-f, --force", "Force registering a new gateway even if already paired", false)
    .option("--code-only", "Print only the access code and skip QR code output", false)
    .action(async (opts) => {
    try {
        await runPairCommand(opts);
    }
    catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program
    .command("pair-openclaw")
    .description("Shortcut: pair an OpenClaw gateway using profile 'openclaw' (or 'openclaw-local' with --local)")
    .option("-s, --server <url>", `Relay server URL (default: CLAWCONNECT_RELAY_SERVER_URL or ${DEFAULT_RELAY_SERVER_URL})`)
    .option("-n, --name <name>", "Display name for this host")
    .option("--local", `Use local relay server (${LOCAL_RELAY_SERVER_URL}) with isolated profile 'openclaw-local'`, false)
    .option("-f, --force", "Force registering a new gateway even if already paired", false)
    .option("--code-only", "Print only the access code and skip QR code output", false)
    .addHelpText("after", PAIR_OPENCLAW_HELP_TEXT)
    .action(async (opts) => {
    try {
        await runPairCommand({
            ...opts,
            gatewayType: "openclaw",
        });
    }
    catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program
    .command("pair-hermes")
    .description("Shortcut: pair a Hermes Agent gateway using profile 'hermes' (or 'hermes-local' with --local)")
    .option("-s, --server <url>", `Relay server URL (default: CLAWCONNECT_RELAY_SERVER_URL or ${DEFAULT_RELAY_SERVER_URL})`)
    .option("-n, --name <name>", "Display name for this host")
    .option("--local", `Use local relay server (${LOCAL_RELAY_SERVER_URL}) with isolated profile 'hermes-local'`, false)
    .option("-f, --force", "Force registering a new gateway even if already paired", false)
    .option("--code-only", "Print only the access code and skip QR code output", false)
    .addHelpText("after", PAIR_HERMES_HELP_TEXT)
    .action(async (opts) => {
    try {
        await runPairCommand({
            ...opts,
            gatewayType: "hermes",
        });
    }
    catch (err) {
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
    .action(async (filePath, opts) => {
    try {
        setActiveProfile(opts.profile);
        await sendFileCommand({
            filePath,
            gateway: opts.gateway,
            session: opts.session,
            sourceRunId: opts.sourceRunId,
            json: opts.json,
        });
    }
    catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program
    .command("hermes-file-transfer-outcome")
    .description("Emit a typed Hermes mobile file-transfer outcome for the terminal receipt")
    .requiredOption("--json <payload>", "JSON object with kind and sourceRunId")
    .action((opts) => {
    try {
        hermesFileTransferOutcomeCommand(opts.json);
    }
    catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program
    .command("run")
    .description("Run relay client in foreground (used by the background service manager)")
    .option(...profileOption)
    .action(async (opts) => {
    try {
        setActiveProfile(opts.profile);
        // 运行时模块包含 OpenClaw/Hermes 路径与子进程环境快照；必须在 .env 加载后再初始化。
        const { runCommand } = await import("./commands/run.js");
        await runCommand();
    }
    catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program
    .command("stop")
    .description("Stop relay client background service")
    .option(...profileOption)
    .action((opts) => {
    setActiveProfile(opts.profile);
    stopCommand();
});
program
    .command("stop-openclaw")
    .description("Shortcut: stop the OpenClaw profile service")
    .option("--local", "Target the isolated local relay profile (openclaw-local)", false)
    .action((opts) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", stopCommand);
});
program
    .command("stop-hermes")
    .description("Shortcut: stop the Hermes Agent profile service")
    .option("--local", "Target the isolated local relay profile (hermes-local)", false)
    .action((opts) => {
    runWithProfile(opts.local ? "hermes-local" : "hermes", stopCommand);
});
program
    .command("status")
    .description("Show pairing config, gateway URL, and background service status (all paired profiles by default)")
    .option(...profileOption)
    .action((opts) => {
    const explicitProfile = opts.profile !== undefined;
    setActiveProfile(opts.profile === "all" ? undefined : opts.profile);
    statusCommand({ profile: opts.profile, explicitProfile });
});
program
    .command("status-all")
    .description("Shortcut: show all paired ClawConnect profiles")
    .action(() => {
    setActiveProfile(undefined);
    statusCommand({ profile: "all", explicitProfile: true });
});
program
    .command("install")
    .description("Register as a background service (launchd on macOS, systemd --user on Linux, Windows Service on Windows, requires an elevated terminal)")
    .option(...profileOption)
    .action((opts) => {
    runInstallCommand(opts);
});
program
    .command("install-openclaw")
    .description("Shortcut: install the OpenClaw profile background service")
    .option("--local", "Target the isolated local relay profile (openclaw-local)", false)
    .action((opts) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", installCommand);
});
program
    .command("install-hermes")
    .description("Shortcut: install the Hermes Agent profile background service")
    .option("--local", "Target the isolated local relay profile (hermes-local)", false)
    .action((opts) => {
    runWithProfile(opts.local ? "hermes-local" : "hermes", installCommand);
});
program
    .command("restart")
    .description("Restart the relay background service")
    .option(...profileOption)
    .action((opts) => {
    setActiveProfile(opts.profile);
    restartCommand();
});
program
    .command("restart-openclaw")
    .description("Shortcut: restart the OpenClaw profile service")
    .option("--local", "Target the isolated local relay profile (openclaw-local)", false)
    .action((opts) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", restartCommand);
});
program
    .command("restart-hermes")
    .description("Shortcut: restart the Hermes Agent profile service")
    .option("--local", "Target the isolated local relay profile (hermes-local)", false)
    .action((opts) => {
    runWithProfile(opts.local ? "hermes-local" : "hermes", restartCommand);
});
program
    .command("uninstall")
    .description("Remove background service definition")
    .option(...profileOption)
    .option("--all", "Remove background service definitions for all profiles", false)
    .action((opts) => {
    if (opts.all) {
        uninstallAllCommand();
        return;
    }
    setActiveProfile(opts.profile);
    uninstallCommand();
});
program
    .command("uninstall-openclaw")
    .description("Shortcut: remove the OpenClaw profile background service")
    .option("--local", "Target the isolated local relay profile (openclaw-local)", false)
    .action((opts) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", uninstallCommand);
});
program
    .command("uninstall-hermes")
    .description("Shortcut: remove the Hermes Agent profile background service")
    .option("--local", "Target the isolated local relay profile (hermes-local)", false)
    .action((opts) => {
    runWithProfile(opts.local ? "hermes-local" : "hermes", uninstallCommand);
});
program
    .command("uninstall-all")
    .description("Shortcut: remove background services for all profiles")
    .action(() => {
    uninstallAllCommand();
});
program
    .command("set-token")
    .description("Set the local OpenClaw gateway token (needed when using token auth)")
    .option(...profileOption)
    .action(async (opts) => {
    try {
        setActiveProfile(opts.profile);
        await setTokenCommand();
    }
    catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program
    .command("reset")
    .description("Uninstall service and clear saved config, logs, backups, and outbox for a profile")
    .option(...profileOption)
    .option("--all", "Reset all profiles (OpenClaw, Hermes, default, and custom)", false)
    .addHelpText("after", RESET_PROFILE_HELP_TEXT)
    .action((opts) => {
    if (opts.all) {
        resetAllCommand();
        return;
    }
    if (opts.profile !== undefined) {
        setActiveProfile(opts.profile);
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
    .action((opts) => {
    runWithProfile(opts.local ? "openclaw-local" : "openclaw", resetCommand);
});
program
    .command("reset-hermes")
    .description("Shortcut: completely reset the Hermes Agent profile")
    .option("--local", "Target the isolated local relay profile (hermes-local)", false)
    .addHelpText("after", "Equivalent to: clawconnect reset --profile hermes (or hermes-local with --local)\n")
    .action((opts) => {
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
    .description("Upgrade the globally installed clawconnect-agent package to the latest npm version")
    .action(() => {
    try {
        updateCommand(import.meta.url);
    }
    catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program.parse(process.argv);
//# sourceMappingURL=index.js.map