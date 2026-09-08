// Public surface of the gateway lib. Routes import from here so they
// need a single import and never reach into lib internals.

export {
  DEFAULT_PROVIDER,
  PROVIDERS,
  normalizeProvider,
  requireApiKey,
} from "./providers.js";
export type { ProviderConfig, ProviderName } from "./providers.js";

export { getModelInfo, getModelMap } from "./models.js";
export type { ModelInfo, ResolvedModel } from "./models.js";

export {
  getAnthropicForwardHeaders,
  getPathString,
  isAuthorized,
  isMessagesRoute,
  isModelsRoute,
  pipeAnthropicStream,
  resolveAnthropicUrl,
  sendAuthenticationError,
  sendBadRequest,
  sendNotFound,
  sendUpstreamError,
  setSseHeaders,
} from "./server.js";

export {
  anthropicContentToText,
  anthropicToOpenAI,
  mapStopReason,
  openAIToAnthropic,
} from "./translate.js";
export type {
  AnthropicRequestBody,
  OpenAiChatBody,
  OpenAiChatResponse,
  OpenAiStreamChunk,
} from "./translate.js";

export { forwardToProvider } from "./forward.js";
