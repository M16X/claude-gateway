/**
 * Anthropic-compatible gateway.
 *
 * Public model ids use the `anthropic/claude-gateway-*` prefix required by
 * Claude clients and are resolved back to upstream ids before forwarding.
 */

import { createHash } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY;
const UPSTREAM_URL = "https://api.deepinfra.com/anthropic/v1/messages";
const GATEWAY_MODEL_PREFIX = "anthropic/claude-gateway-";

type ModelInfo = {
  /** Upstream model id. */
  id: string;
  /** Human-readable name exposed by the models endpoint. */
  name: string;
  
  gatewayId?: string;
};

type AnthropicRequestBody = {
  model: string;
  // All other Anthropic params (messages, tools, metadata, ...) pass through.
  [key: string]: unknown;
};

type ErrorType =
  | "authentication_error"
  | "invalid_request_error"
  | "upstream_error";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function readModels(): Record<string, ModelInfo> {
  try {
    return JSON.parse(process.env.MODELS ?? "{}") as Record<string, ModelInfo>;
  } catch {
    return {};
  }
}

/**
 * Claude clients only accept model ids with the gateway prefix, so derive a
 * stable public id from the upstream model id.
 */
function toGatewayModelId(model: ModelInfo): string {
  if (model.gatewayId) {
    return model.gatewayId;
  }

  const digest = createHash("sha1")
    .update(model.id)
    .digest("hex")
    .slice(0, 8);

  return `${GATEWAY_MODEL_PREFIX}${digest}`;
}

function toUpstreamModelId(gatewayId: string): string {
  const match = Object.values(readModels()).find(
    (model) => toGatewayModelId(model) === gatewayId,
  );

  return match?.id ?? gatewayId;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function isAuthorized(req: VercelRequest): boolean {
  if (!GATEWAY_TOKEN) throw new Error("GATEWAY_TOKEN is not configured");
  return req.headers.authorization === `Bearer ${GATEWAY_TOKEN}`;
}

function getPath(req: VercelRequest): string {
  const path = req.query.path;
  return Array.isArray(path) ? path.join("/") : (path ?? "");
}

function hasPathSegment(req: VercelRequest, segment: string): boolean {
  return getPath(req).split("/").includes(segment);
}

function isModelsRoute(req: VercelRequest): boolean {
  return req.method === "GET" && hasPathSegment(req, "models");
}

function isMessagesRoute(req: VercelRequest): boolean {
  return req.method === "POST" && hasPathSegment(req, "messages");
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendError(
  res: VercelResponse,
  status: number,
  type: ErrorType,
  message: string,
): void {
  res.status(status).json({ type: "error", error: { type, message } });
}

async function streamResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  res: VercelResponse,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

async function forwardToUpstream(
  res: VercelResponse,
  body: AnthropicRequestBody,
): Promise<void> {
  if (!UPSTREAM_API_KEY) {
    throw new Error("UPSTREAM_API_KEY is not configured");
  }

  const upstream = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTREAM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...body,
      model: toUpstreamModelId(body.model),
      // The upstream always streams, so the client always receives SSE.
      stream: true,
      fail_fast: true,
      service_tier: "default",
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const message = await upstream.text();
    sendError(res, upstream.status, "upstream_error", message);
    return;
  }

  await streamResponse(upstream.body, res);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function handleModels(res: VercelResponse): void {
  const data = Object.values(readModels()).map((model) => ({
    id: toGatewayModelId(model),
    type: "model",
    display_name: model.name,
  }));

  res.json({ data });
}

async function handleMessages(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const body = req.body as AnthropicRequestBody | undefined;

  if (!body?.model) {
    sendError(res, 400, "invalid_request_error", "Missing model");
    return;
  }

  await forwardToUpstream(res, body);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    if (!isAuthorized(req)) {
      sendError(res, 401, "authentication_error", "Invalid bearer token");
      return;
    }

    if (isModelsRoute(req)) {
      handleModels(res);
      return;
    }

    if (isMessagesRoute(req)) {
      await handleMessages(req, res);
      return;
    }

    res.status(404).json({ error: "Not found" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
}
