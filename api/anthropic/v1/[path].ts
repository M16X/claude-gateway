import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  forwardToProvider,
  getModelMap,
  isAuthorized,
  isMessagesRoute,
  isModelsRoute,
  normalizeProvider,
  sendAuthenticationError,
  sendBadRequest,
  sendNotFound,
  type AnthropicRequestBody,
} from "../../_lib/index.js";

function listModels(res: VercelResponse): void {
  const models = getModelMap();

  res.status(200).json({
    data: Object.entries(models).map(([id, info]) => ({
      id,
      type: "model",
      display_name: info.name,
      provider: normalizeProvider(info.provider),
    })),
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (!isAuthorized(req)) {
      sendAuthenticationError(res);
      return;
    }

    if (isModelsRoute(req)) {
      listModels(res);
      return;
    }

    if (isMessagesRoute(req)) {
      const body = req.body as AnthropicRequestBody | undefined;
      if (!body?.model) {
        sendBadRequest(res, "Missing model");
        return;
      }
      await forwardToProvider(req, res, body);
      return;
    }

    sendNotFound(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
}
