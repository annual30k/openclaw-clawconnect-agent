import { DEFAULT_GATEWAY_SESSION_DEFAULTS, canonicalizeSessionKey, type GatewaySessionDefaults } from "./session-context.js";
import type { VoiceReplyConfig as VoiceReplySettings } from "../config/config.js";

type VoiceReplyPreferenceEntry = {
  enabled: boolean;
  settings?: VoiceReplySettings;
};

export class VoiceReplyPreferenceStore {
  private readonly runPreferences = new Map<string, VoiceReplyPreferenceEntry>();
  private readonly sessionPreferences = new Map<string, VoiceReplyPreferenceEntry>();
  private defaultVoiceReplySettings: VoiceReplySettings = {};
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

  setDefaultVoiceReplySettings(settings: VoiceReplySettings | undefined): void {
    this.defaultVoiceReplySettings = this.normalizeSettings(settings ?? {}) ?? {};
  }

  register(opts: { runId?: string; sessionKey?: string; enabled: boolean; voiceIdentifier?: string; ratePercent?: number }): void {
    const settings = this.normalizeSettings({
      voiceIdentifier: opts.voiceIdentifier,
      ratePercent: opts.ratePercent,
    });

    if (opts.runId) {
      this.runPreferences.set(opts.runId, {
        enabled: opts.enabled,
        ...(settings ? { settings } : {}),
      });
    }

    const normalizedSessionKey = this.normalizeSessionKey(opts.sessionKey);
    if (normalizedSessionKey) {
      this.sessionPreferences.set(normalizedSessionKey, {
        enabled: opts.enabled,
        ...(settings ? { settings } : {}),
      });
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
      if (runEnabled) {
        return runEnabled.enabled;
      }
    }

    const normalizedSessionKey = this.normalizeSessionKey(sessionKey);
    if (normalizedSessionKey) {
      const sessionEnabled = this.sessionPreferences.get(normalizedSessionKey);
      if (sessionEnabled) {
        return sessionEnabled.enabled;
      }
    }

    return this.defaultVoiceReplyEnabled;
  }

  resolveSettings(runId?: string, sessionKey?: string): VoiceReplySettings | undefined {
    if (runId) {
      const runEntry = this.runPreferences.get(runId);
      if (runEntry?.settings) {
        return runEntry.settings;
      }
    }

    const normalizedSessionKey = this.normalizeSessionKey(sessionKey);
    if (normalizedSessionKey) {
      const sessionEntry = this.sessionPreferences.get(normalizedSessionKey);
      if (sessionEntry?.settings) {
        return sessionEntry.settings;
      }
    }

    return this.defaultVoiceReplySettings;
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

  private normalizeSettings(settings: VoiceReplySettings): VoiceReplySettings | undefined {
    const voiceIdentifier = typeof settings.voiceIdentifier === "string" ? settings.voiceIdentifier.trim() : "";
    const ratePercent =
      typeof settings.ratePercent === "number" && Number.isFinite(settings.ratePercent)
        ? Math.max(-50, Math.min(50, Math.round(settings.ratePercent)))
        : undefined;

    if (!voiceIdentifier && ratePercent === undefined) {
      return undefined;
    }

    return {
      ...(voiceIdentifier ? { voiceIdentifier } : {}),
      ...(ratePercent !== undefined ? { ratePercent } : {}),
    };
  }
}
