export type RelaySlashCommandSource = "OpenClaw" | "Hermes" | "ClawConnect";

export interface RelaySlashCommandDescriptor {
  source: RelaySlashCommandSource;
  command: string;
  title: string;
  detail: string;
}
