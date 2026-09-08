// Public surface of the gateway lib. Routes import from here so they
// need a single import and never reach into lib internals.

export { normalizeProvider } from "./providers.js";

export { getModelMap } from "./models.js";

export {
  isAuthorized,
  isMessagesRoute,
  isModelsRoute,
  sendAuthenticationError,
  sendBadRequest,
  sendNotFound,
} from "./server.js";

export { forwardToProvider } from "./forward.js";
export type { AnthropicRequestBody } from "./forward.js";
