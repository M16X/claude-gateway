import { createHash } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const API_URL = "https://api.deepinfra.com/anthropic/v1/messages";
const API_KEY = process.env.UPSTREAM_API_KEY;

type ModelInfo = { id: string; name: string };

type AnthropicRequestBody = {
  model: string;
  // Any other Anthropic params (messages, tools, metadata, ...) pass through untouched.
  [key: string]: unknown;
};

function getModelMap(): Record<string, ModelInfo> {
  try {
    return JSON.parse(process.env.MODELS ?? "{}") as Record<string, ModelInfo>;
  } catch {
    return {};
  }
}

function gatewayModelId(modelId: string): string {
  const hash = createHash("sha1").update(modelId).digest("hex").slice(0, 8);
  return `anthropic/claude-gateway-${hash}`;
}

function toUpstreamModelId(gatewayId: string): string {
  for (const info of Object.values(getModelMap())) {
    if (gatewayModelId(info.id) === gatewayId) return info.id;
  }
  return gatewayId;
}

function isAuthorized(req: VercelRequest): boolean {
  if (!GATEWAY_TOKEN) throw new Error("GATEWAY_TOKEN is not configured");
  return req.headers.authorization === `Bearer ${GATEWAY_TOKEN}`;
}

function getPathString(req: VercelRequest): string {
  const path = req.query.path;
  if (Array.isArray(path)) return path.join("/");
  return path ?? "";
}

function isModelsRoute(req: VercelRequest): boolean {
  return req.method === "GET" && getPathString(req).includes("models");
}

function isMessagesRoute(req: VercelRequest): boolean {
  return req.method === "POST" && getPathString(req).includes("messages");
}

async function sendUpstreamError(
  res: VercelResponse,
  upstream: Response,
): Promise<void> {
  const message = await upstream.text();
  res.status(upstream.status).json({
    type: "error",
    error: { type: "upstream_error", message },
  });
}

async function pipeStream(
  upstreamBody: ReadableStream<Uint8Array>,
  res: VercelResponse,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } finally {
    res.end();
  }
}

async function forwardRequest(
  res: VercelResponse,
  body: AnthropicRequestBody,
): Promise<void> {
  if (!API_KEY) throw new Error("UPSTREAM_API_KEY is not configured");

  // The upstream always streams; the Anthropic wire is passed through as-is.
  const upstream = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...body,
      model: toUpstreamModelId(body.model),
      stream: true,
      fail_fast: true,
      service_tier: "default",
    }),
  });

  if (!upstream.ok || !upstream.body) {
    await sendUpstreamError(res, upstream);
    return;
  }

  await pipeStream(upstream.body, res);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (!isAuthorized(req)) {
      res.status(401).json({
        type: "error",
        error: { type: "authentication_error", message: "Invalid bearer token" },
      });
      return;
    }

    if (isModelsRoute(req)) {
      res.json({
        data: Object.values(getModelMap()).map((info) => ({
          id: gatewayModelId(info.id),
          type: "model",
          display_name: info.name,
        })),
      });
      return;
    }

    if (isMessagesRoute(req)) {
      const body = req.body as AnthropicRequestBody | undefined;
      if (!body?.model) {
        res.status(400).json({
          type: "error",
          error: { type: "invalid_request_error", message: "Missing model" },
        });
        return;
      }
      await forwardRequest(res, body);
      return;
    }

    res.status(404).json({ error: "Not found" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
}
