import type { SettingsStore } from "./db.js";

/** Settings editable from the console. Values saved there win over server/.env defaults. */
export interface GatewayConfig {
  geminiApiKey?: string;
  geminiModel?: string;
  publicUrl?: string;
  webhookUrl?: string;
  docsUrl?: string;
  /** Every incoming call is answered and streamed to this agent WebSocket. */
  incomingStreamUrl?: string;
  incomingStreamFormat?: string;
}

const KEYS = [
  "geminiApiKey",
  "geminiModel",
  "publicUrl",
  "webhookUrl",
  "docsUrl",
  "incomingStreamUrl",
  "incomingStreamFormat",
] as const;
export type ConfigKey = (typeof KEYS)[number];

export class ConfigStore {
  constructor(
    private readonly settings: SettingsStore,
    private readonly defaults: GatewayConfig = {},
  ) {}

  get(key: ConfigKey): string | undefined {
    return this.saved()[key] || this.defaults[key] || undefined;
  }

  /** Empty string clears a saved value (falls back to the .env default). */
  update(patch: Partial<Record<ConfigKey, string>>): void {
    const next = { ...this.saved() };
    for (const key of KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value.trim()) next[key] = value.trim();
      else delete next[key];
    }
    this.settings.set("config", next);
  }

  /** Safe to send to the browser: secrets are reduced to whether they are set and their last digits. */
  view() {
    const saved = this.saved();
    const gemini = this.get("geminiApiKey");
    return {
      publicUrl: this.get("publicUrl") ?? null,
      webhookUrl: this.get("webhookUrl") ?? null,
      docsUrl: this.get("docsUrl") ?? null,
      incomingStreamUrl: this.get("incomingStreamUrl") ?? null,
      incomingStreamFormat: this.get("incomingStreamFormat") ?? "raw",
      geminiModel: this.get("geminiModel") ?? null,
      geminiApiKey: {
        configured: Boolean(gemini),
        hint: gemini ? `…${gemini.slice(-4)}` : null,
        source: saved.geminiApiKey ? "console" : gemini ? "env" : null,
      },
    };
  }

  private saved(): GatewayConfig {
    return this.settings.get<GatewayConfig>("config") ?? {};
  }
}
