import { OPENCLAW_SLASH_COMMAND_CATALOG as GENERATED_OPENCLAW_SLASH_COMMAND_CATALOG } from "./slash-command-catalog.generated.js";

export type RelaySlashCommandSource = "OpenClaw" | "ClawConnect";

export interface RelaySlashCommandDescriptor {
  source: RelaySlashCommandSource;
  command: string;
  title: string;
  detail: string;
}

export const OPENCLAW_SLASH_COMMAND_CATALOG: readonly RelaySlashCommandDescriptor[] =
  GENERATED_OPENCLAW_SLASH_COMMAND_CATALOG;
