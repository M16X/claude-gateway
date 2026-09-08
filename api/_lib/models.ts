// Model registry: gateway model id -> upstream model id + provider.

import {
  DEFAULT_PROVIDER,
  normalizeProvider,
  type ProviderName,
} from "./providers.js";

export type ModelInfo = { id: string; name: string; provider?: string };

export type ResolvedModel = ModelInfo & { provider: ProviderName };

let cachedModels: Record<string, ModelInfo> | null = null;

export function getModelMap(): Record<string, ModelInfo> {
  if (cachedModels) return cachedModels;
  try {
    cachedModels = JSON.parse(process.env.MODELS ?? "{}") as Record<
      string,
      ModelInfo
    >;
  } catch {
    cachedModels = {};
  }
  return cachedModels;
}

export function getModelInfo(model: string): ResolvedModel {
  const found = getModelMap()[model];
  if (!found) return { id: model, name: model, provider: DEFAULT_PROVIDER };
  return {
    id: found.id,
    name: found.name,
    provider: normalizeProvider(found.provider),
  };
}
