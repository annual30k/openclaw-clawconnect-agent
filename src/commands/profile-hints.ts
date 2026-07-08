import { normalizeProfileName } from "../config/profile.js";

export function resetCommandForProfile(profile: string | undefined): string {
  const normalized = normalizeProfileName(profile);
  if (normalized === "openclaw") return "clawconnect reset-openclaw";
  if (normalized === "hermes") return "clawconnect reset-hermes";
  return normalized ? `clawconnect reset --profile ${normalized}` : "clawconnect reset";
}

export function pairCommandForProfile(profile: string | undefined): string {
  const normalized = normalizeProfileName(profile);
  if (normalized === "openclaw") return "clawconnect pair-openclaw";
  if (normalized === "hermes") return "clawconnect pair-hermes";
  return normalized ? `clawconnect pair --profile ${normalized}` : "clawconnect pair";
}

export function invalidCredentialsRecoveryHint(profile: string | undefined): string {
  return `Run \`${resetCommandForProfile(profile)}\` to clear this profile config, then run \`${pairCommandForProfile(profile)}\` to re-register.`;
}

export const RESET_PROFILE_HELP_TEXT = [
  "",
  "Profile recovery examples:",
  "  pair-openclaw uses profile 'openclaw': clawconnect reset-openclaw",
  "  pair-hermes uses profile 'hermes':   clawconnect reset-hermes",
  "  custom profiles:                    clawconnect reset --profile <name>",
  "",
].join("\n");

export const PAIR_OPENCLAW_HELP_TEXT = [
  "",
  "Profile recovery:",
  "  This shortcut uses profile 'openclaw'. If credentials become invalid, run:",
  "    clawconnect reset-openclaw",
  "",
].join("\n");

export const PAIR_HERMES_HELP_TEXT = [
  "",
  "Profile recovery:",
  "  This shortcut uses profile 'hermes'. If credentials become invalid, run:",
  "    clawconnect reset-hermes",
  "",
].join("\n");

export const MAIN_HELP_TEXT = [
  "",
  "Command quick reference:",
  "  pair                  Pair the default profile",
  "  pair-openclaw         Pair OpenClaw using profile 'openclaw'",
  "  pair-hermes           Pair Hermes Agent using profile 'hermes'",
  "  run                   Run one profile in the foreground",
  "  status                Show one profile status",
  "  status-all            Show every paired profile",
  "  install               Install every paired profile service",
  "  install-openclaw      Install OpenClaw profile service",
  "  install-hermes        Install Hermes profile service",
  "  restart               Restart one profile service",
  "  restart-openclaw      Restart OpenClaw profile service",
  "  restart-hermes        Restart Hermes profile service",
  "  stop                  Stop one profile service",
  "  stop-openclaw         Stop OpenClaw profile service",
  "  stop-hermes           Stop Hermes profile service",
  "  reset                 Stop service and clear one profile config",
  "  reset-openclaw        Stop OpenClaw service and clear profile 'openclaw'",
  "  reset-hermes          Stop Hermes Agent service and clear profile 'hermes'",
  "  uninstall             Remove one background service definition",
  "  set-token             Set or clear the local OpenClaw gateway token",
  "  send-file             Upload a local file into the paired chat session",
  "  update                Update the globally installed clawconnect-agent package",
  "  help                  Show detailed help for a command",
  "",
].join("\n");
