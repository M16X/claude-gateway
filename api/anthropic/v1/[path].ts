import type { VercelRequest, VercelResponse } from "@vercel/node";

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const API_URL = "https://api.deepinfra.com/anthropic/v1/messages";
const API_KEY = process.env.UPSTREAM_API_KEY;

interface ModelInfo {
  id: string;
  name: string;
}

interface AnthropicRequestBody {
  model: string;
  // Any other Anthropic params (messages, tools, metadata, ...) pass through untouched.
  [key: string]: unknown;
}

function getModelMap(): Record<string, ModelInfo> {
  try {
    return JSON.parse(process.env.MODELS ?? "{}") as Record<string, ModelInfo>;
  } catch {
    return {};
  }
}

function getModelInfo(model: string): ModelInfo {
  const found = getModelMap()[model];
  if (!found) return { id: model, name: model };
  return { id: found.id, name: found.name };
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

function sendAuthenticationError(res: VercelResponse): void {
  res.status(401).json({
    type: "error",
    error: { type: "authentication_error", message: "Invalid bearer token" },
  });
}

function sendBadRequest(res: VercelResponse, message: string): void {
  res.status(400).json({
    type: "error",
    error: { type: "invalid_request_error", message },
  });
}

function sendNotFound(res: VercelResponse): void {
  res.status(404).json({ error: "Not found" });
}

async function sendUpstreamError(
  res: VercelResponse,
  upstream: Response,
): Promise<void> {
  const message = await upstream.text();
  console.log(message);
  res.status(upstream.status).json({
    type: "error",
    error: { type: "upstream_error", message },
  });
}

function setSseHeaders(res: VercelResponse): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
}

async function pipeStream(
  upstreamBody: ReadableStream<Uint8Array>,
  res: VercelResponse,
): Promise<void> {
  setSseHeaders(res);
  const reader = upstreamBody.getReader();
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
}

async function forwardRequest(
  res: VercelResponse,
  body: AnthropicRequestBody,
): Promise<void> {
  if (!API_KEY) throw new Error("UPSTREAM_API_KEY is not configured");

  const model = getModelInfo(body.model);

  // The upstream always streams; the Anthropic wire is passed through as-is.
  const upstream = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...body,
      model: model.id,
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

function listModels(res: VercelResponse): void {
  const models = getModelMap();

  res.status(200).json({
    data: Object.entries(models).map(([id, info]) => ({
      id,
      type: "model",
      display_name: info.name,
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
      await forwardRequest(res, body);
      return;
    }

    sendNotFound(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
}
