// Upstream providers. Each provider owns its separate API_URL and API_KEY.

interface ProviderConfig {
  API_URL: string;
  API_KEY: string | undefined;
  KEY_ENV: string;
}

export const PROVIDERS = {
  deepinfra: {
    API_URL: "https://api.deepinfra.com/anthropic/v1/messages",
    API_KEY: process.env.DEEPINFRA_API_KEY,
    KEY_ENV: "DEEPINFRA_API_KEY",
  },
  vercel: {
    API_URL: "https://ai-gateway.vercel.sh/v1/messages",
    API_KEY: process.env.AI_GATEWAY_API_KEY,
    KEY_ENV: "AI_GATEWAY_API_KEY",
  },
} as const satisfies Record<string, ProviderConfig>;

export type ProviderName = keyof typeof PROVIDERS;

export const DEFAULT_PROVIDER: ProviderName = "deepinfra";

export function requireApiKey(provider: ProviderName): string {
  const config = PROVIDERS[provider];
  if (!config.API_KEY) throw new Error(`${config.KEY_ENV} is not configured`);
  return config.API_KEY;
}

export function normalizeProvider(provider?: string): ProviderName {
  if (provider && provider in PROVIDERS) return provider as ProviderName;
  return DEFAULT_PROVIDER;
}
