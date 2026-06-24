import { OPENCLAW_SLASH_COMMAND_CATALOG } from "./slash-command-catalog.js";
import type { RelayHelloMessage } from "./relay-manager-protocol.js";

export function buildRelayHelloMessage(opts: {
  platform: string;
  agentVersion: string;
  capabilities?: string[];
}): RelayHelloMessage {
  return {
    type: "hello",
    platform: opts.platform,
    agentVersion: opts.agentVersion,
    capabilities: opts.capabilities,
    slashCommands: OPENCLAW_SLASH_COMMAND_CATALOG,
  };
}
