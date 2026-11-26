import { normalizeProfileName } from "../config/profile.js";

export type CliGatewayTarget = "openclaw" | "hermes";

export type ResolvedProfileTarget =
  | { kind: "all" }
  | { kind: "profile"; profile: string | undefined; explicit: boolean };

export type ResolvedImplicitProfileTarget =
  | { kind: "profile"; profile: string | undefined }
  | { kind: "ambiguous"; profiles: string[] };

export function parseGatewayTargetAlias(rawTarget: string | undefined): CliGatewayTarget | undefined {
  const normalized = rawTarget?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "oc" || normalized === "openclaw") return "openclaw";
  if (normalized === "hm" || normalized === "hermes") return "hermes";
  return undefined;
}

export function parsePairGatewayTarget(
  rawTarget: string | undefined,
  explicitGatewayType?: string,
): CliGatewayTarget | undefined {
  const trimmedTarget = rawTarget?.trim();
  const targetGateway = parseGatewayTargetAlias(trimmedTarget);
  if (trimmedTarget && !targetGateway) {
    throw new Error(`Unknown pair target "${trimmedTarget}". Use openclaw (oc) or hermes (hm).`);
  }

  const trimmedOption = explicitGatewayType?.trim();
  const optionGateway = parseGatewayTargetAlias(trimmedOption);
  if (trimmedOption && !optionGateway) {
    throw new Error(`Unknown gateway type "${trimmedOption}". Use openclaw or hermes.`);
  }

  if (targetGateway && optionGateway && targetGateway !== optionGateway) {
    throw new Error(`Conflicting gateway target "${trimmedTarget}" and --gateway-type "${trimmedOption}".`);
  }

  return targetGateway ?? optionGateway;
}

export function resolveProfileCommandTarget(options: {
  target?: string;
  profile?: string;
  local?: boolean;
  all?: boolean;
  allowAll?: boolean;
}): ResolvedProfileTarget {
  const trimmedTarget = options.target?.trim() || undefined;
  const trimmedProfile = options.profile?.trim() || undefined;
  const isLocal = Boolean(options.local);
  const targetIsAll = trimmedTarget?.toLowerCase() === "all";
  const profileIsAll = trimmedProfile?.toLowerCase() === "all";
  const wantsAll = Boolean(options.all || targetIsAll || profileIsAll);

  if (trimmedTarget && trimmedProfile) {
    throw new Error(`Do not pass both target "${trimmedTarget}" and --profile "${trimmedProfile}".`);
  }

  if (wantsAll) {
    if (!options.allowAll) {
      throw new Error('Target "all" is not supported for this command.');
    }
    if (options.all && trimmedTarget && !targetIsAll) {
      throw new Error(`Do not combine --all with target "${trimmedTarget}".`);
    }
    if (options.all && trimmedProfile && !profileIsAll) {
      throw new Error(`Do not combine --all with --profile "${trimmedProfile}".`);
    }
    if (isLocal) {
      throw new Error('Do not combine --local with "all".');
    }
    return { kind: "all" };
  }

  if (trimmedProfile) {
    if (isLocal) {
      throw new Error('Do not combine --local with --profile; use a gateway target (oc/hm) or pass the *-local profile directly.');
    }
    return {
      kind: "profile",
      profile: normalizeProfileName(trimmedProfile),
      explicit: true,
    };
  }

  if (trimmedTarget) {
    const gatewayTarget = parseGatewayTargetAlias(trimmedTarget);
    if (gatewayTarget) {
      return {
        kind: "profile",
        profile: isLocal ? `${gatewayTarget}-local` : gatewayTarget,
        explicit: true,
      };
    }
    if (isLocal) {
      throw new Error(`--local can only be used with openclaw (oc) or hermes (hm), not "${trimmedTarget}".`);
    }
    return {
      kind: "profile",
      profile: normalizeProfileName(trimmedTarget),
      explicit: true,
    };
  }

  if (isLocal) {
    throw new Error("--local requires a gateway target (openclaw/oc or hermes/hm).");
  }

  return {
    kind: "profile",
    profile: undefined,
    explicit: false,
  };
}

export function resolveImplicitSingleProfileTarget(options: {
  defaultHasState: boolean;
  profiles: readonly string[];
}): ResolvedImplicitProfileTarget {
  if (options.defaultHasState) {
    return { kind: "profile", profile: undefined };
  }
  const unique = Array.from(new Set(options.profiles.map((item) => item.trim()).filter(Boolean)));
  if (unique.length === 1) {
    return {
      kind: "profile",
      profile: unique[0] === "default" ? undefined : unique[0],
    };
  }
  if (unique.length > 1) {
    return { kind: "ambiguous", profiles: unique };
  }
  return { kind: "profile", profile: undefined };
}

export function formatShortTargetHint(verb: "restart" | "stop" | "set-token", profile: string): string {
  if (profile === "openclaw") return `clawc ${verb === "restart" ? "rs" : verb} oc`;
  if (profile === "openclaw-local") return `clawc ${verb === "restart" ? "rs" : verb} oc --local`;
  if (profile === "hermes") return `clawc ${verb === "restart" ? "rs" : verb} hm`;
  if (profile === "hermes-local") return `clawc ${verb === "restart" ? "rs" : verb} hm --local`;
  return `clawc ${verb === "restart" ? "rs" : verb} ${profile}`;
}
