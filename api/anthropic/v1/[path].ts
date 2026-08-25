import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readFile } from "node:fs/promises";

const DEEPINFRA_API_URL = "https://api.deepinfra.com/anthropic/v1/messages";
const MODELS_PATH = new URL("./models.json", import.meta.url);

const TOKEN = process.env.GATEWAY_TOKEN;
const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY;

type ModelInfo = { id: string; name: string };

let modelCache: Record<string, ModelInfo> | null = null;

function authenticate(req: VercelRequest): boolean {
  if (!TOKEN) {
    throw new Error("GATEWAY_TOKEN is not configured");
  }

  const auth = req.headers.authorization;

  return auth === `Bearer ${TOKEN}`;
}

async function loadModels(): Promise<Record<string, ModelInfo>> {
  if (modelCache) return modelCache;

  const raw = await readFile(MODELS_PATH, "utf8");
  modelCache = JSON.parse(raw) as Record<string, ModelInfo>;

  return modelCache;
}

async function getModel(model: string): Promise<string> {
  const map = await loadModels();

  return map[model]?.id ?? model;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  try {
    if (!authenticate(req)) {
      return res.status(401).json({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid bearer token",
        },
      });
    }

    const path = req.query.path;

    // /anthropic/v1/models
    if (req.method === "GET" && path?.includes("models")) {
      const modelMap = await loadModels();

      return res.status(200).json({
        data: Object.entries(modelMap).map(([id, info]) => ({
          id,
          type: "model",
          display_name: info.name,
        })),
      });
    }

    // /anthropic/v1/messages
    if (req.method === "POST" && path?.includes("messages")) {
      if (!DEEPINFRA_API_KEY) {
        throw new Error("DEEPINFRA_API_KEY is not configured");
      }

      const body = req.body;

      const deepInfraModel = await getModel(body.model);

      const response = await fetch(DEEPINFRA_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...body,
          stream: true,
          model: deepInfraModel,
          fail_fast: true,
          service_tier: "default"
        }),
      });

      if (!response.ok || !response.body) {
        const errorBody = await response.text();
        console.log(errorBody);
        return res.status(response.status).json({
          type: "error",
          error: {
            type: "upstream_error",
            message: errorBody,
          },
        });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
        res.end();
      }

      return;
    }

    return res.status(404).json({
      error: "Not found",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
