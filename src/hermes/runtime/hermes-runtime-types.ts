
export type HermesChatResult = {
  output: string;
  sessionKey: string;
  artifactPaths: string[];
  usage?: HermesUsageSnapshot;
};

export type HermesUsageSnapshot = {
  currentModel?: string;
  provider?: string;
  contextUsage?: number;
  contextLimit?: number;
  hermesSessionId?: string;
};

export type HermesToolLogEvent = {
  toolName: string;
  phase: "streaming" | "completed" | "failed";
  text: string;
  isError?: boolean;
};
