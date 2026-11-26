import { normalizeProfileName } from "../config/profile.js";

function profileShortcutCommand(
  verb: "reset" | "pair" | "restart",
  profile: string | undefined,
): string {
  const normalized = normalizeProfileName(profile);
  if (normalized === "openclaw") return `clawconnect ${verb}-openclaw`;
  if (normalized === "openclaw-local") return `clawconnect ${verb}-openclaw --local`;
  if (normalized === "hermes") return `clawconnect ${verb}-hermes`;
  if (normalized === "hermes-local") return `clawconnect ${verb}-hermes --local`;
  return normalized ? `clawconnect ${verb} --profile ${normalized}` : `clawconnect ${verb}`;
}

export function resetCommandForProfile(profile: string | undefined): string {
  return profileShortcutCommand("reset", profile);
}

export function pairCommandForProfile(profile: string | undefined): string {
  return profileShortcutCommand("pair", profile);
}

export function restartCommandForProfile(profile: string | undefined): string {
  return profileShortcutCommand("restart", profile);
}

export function invalidCredentialsRecoveryHint(profile: string | undefined): string {
  return `Run \`${resetCommandForProfile(profile)}\` to clear this profile config, then run \`${pairCommandForProfile(profile)}\` to re-register.`;
}

export function relayCredentialsRejectedHint(profile: string | undefined): string {
  return `Relay rejected this host's credentials (4401): the gateway was unpaired or removed on the relay. ${invalidCredentialsRecoveryHint(profile)}`;
}

export const RESET_PROFILE_HELP_TEXT = [
  "",
  "Profile recovery examples:",
  "  pair-openclaw uses profile 'openclaw':           clawconnect reset-openclaw",
  "  pair-openclaw --local uses 'openclaw-local':    clawconnect reset-openclaw --local",
  "  pair-hermes uses profile 'hermes':               clawconnect reset-hermes",
  "  pair-hermes --local uses 'hermes-local':        clawconnect reset-hermes --local",
  "  reset every profile:                            clawconnect reset-all",
  "  custom profiles:                                clawconnect reset --profile <name>",
  "",
].join("\n");

export const PAIR_OPENCLAW_HELP_TEXT = [
  "",
  "Profile isolation & recovery:",
  "  Default (online relay) uses profile 'openclaw':       clawconnect reset-openclaw",
  "  --local (127.0.0.1:8080) uses profile 'openclaw-local' (never overwrites online config):",
  "                                                        clawconnect reset-openclaw --local",
  "",
].join("\n");

export const PAIR_HERMES_HELP_TEXT = [
  "",
  "Profile isolation & recovery:",
  "  Default (online relay) uses profile 'hermes':         clawconnect reset-hermes",
  "  --local (127.0.0.1:8080) uses profile 'hermes-local' (never overwrites online config):",
  "                                                        clawconnect reset-hermes --local",
  "",
].join("\n");

export const MAIN_HELP_TEXT = [
  "",
  "Command quick reference:",
  "  pair                  Pair OpenClaw/Hermes (auto-selects profile by --gateway-type)",
  "  pair-openclaw         Pair OpenClaw using profile 'openclaw'",
  "  pair-hermes           Pair Hermes Agent using profile 'hermes'",
  "  run                   Run one profile in the foreground",
  "  status                Show all paired profiles (or one with --profile)",
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
  "  reset                 Uninstall service and clear one profile config (or --all)",
  "  reset-openclaw        Uninstall OpenClaw service and clear profile 'openclaw'",
  "  reset-hermes          Uninstall Hermes Agent service and clear profile 'hermes'",
  "  reset-all             Uninstall services and clear all paired profiles",
  "  uninstall             Remove one background service definition (or --all)",
  "  uninstall-openclaw    Remove OpenClaw background service",
  "  uninstall-hermes      Remove Hermes background service",
  "  uninstall-all         Remove all background services",
  "  set-token             Set or clear the local OpenClaw gateway token",
  "  send-file             Upload a local file into the paired chat session",
  "  update                Update the globally installed clawconnect-agent package",
  "  help                  Show detailed help for a command",
  "",
  "Short alias & target shortcuts (clawc is a drop-in alias for clawconnect):",
  "  clawc st [oc|hm|all]       Short for status (e.g. clawc st, clawc st oc --local)",
  "  clawc up                   Short for update",
  "  clawc pair <oc|hm>         Pair OpenClaw (oc) or Hermes (hm) (supports --local)",
  "  clawc rs [oc|hm|all]       Restart service (omitting target auto-selects when only 1 profile is paired)",
  "  clawc stop [oc|hm|all]     Stop service (omitting target auto-selects when only 1 profile is paired)",
  "  clawc reset <oc|hm|all>    Reset one profile or all profiles (supports --local)",
  "",
].join("\n");
