import { DEFAULT_GATEWAY_SESSION_DEFAULTS, canonicalizeSessionKey, type GatewaySessionDefaults } from "./session-context.js";

export class VoiceReplyPreferenceStore {
  private readonly runPreferences = new Map<string, boolean>();
  private readonly sessionPreferences = new Map<string, boolean>();
  private sessionDefaults: GatewaySessionDefaults;
  private defaultVoiceReplyEnabled: boolean;

  constructor(
    defaultVoiceReplyEnabled = false,
    sessionDefaults: GatewaySessionDefaults = DEFAULT_GATEWAY_SESSION_DEFAULTS,
  ) {
    this.defaultVoiceReplyEnabled = defaultVoiceReplyEnabled;
    this.sessionDefaults = sessionDefaults;
  }

  setDefaultVoiceReplyEnabled(enabled: boolean | undefined): void {
    this.defaultVoiceReplyEnabled = enabled ?? false;
  }

  setSessionDefaults(sessionDefaults: GatewaySessionDefaults): void {
    this.sessionDefaults = sessionDefaults;
  }

  register(opts: { runId?: string; sessionKey?: string; enabled: boolean }): void {
    if (opts.runId) {
      this.runPreferences.set(opts.runId, opts.enabled);
    }

    const normalizedSessionKey = this.normalizeSessionKey(opts.sessionKey);
    if (normalizedSessionKey) {
      this.sessionPreferences.set(normalizedSessionKey, opts.enabled);
    }
  }

  clearRun(runId?: string): void {
    if (!runId) {
      return;
    }
    this.runPreferences.delete(runId);
  }

  shouldUse(runId?: string, sessionKey?: string): boolean {
    if (runId) {
      const runEnabled = this.runPreferences.get(runId);
      if (typeof runEnabled === "boolean") {
        return runEnabled;
      }
    }

    const normalizedSessionKey = this.normalizeSessionKey(sessionKey);
    if (normalizedSessionKey) {
      const sessionEnabled = this.sessionPreferences.get(normalizedSessionKey);
      if (typeof sessionEnabled === "boolean") {
        return sessionEnabled;
      }
    }

    return this.defaultVoiceReplyEnabled;
  }

  private normalizeSessionKey(sessionKey?: string): string | undefined {
    if (!sessionKey) {
      return undefined;
    }

    const canonical = canonicalizeSessionKey(sessionKey, this.sessionDefaults);
    if (typeof canonical !== "string") {
      return undefined;
    }

    const normalized = canonical.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
}
