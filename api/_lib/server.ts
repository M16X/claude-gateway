// Talking to the client as an Anthropic-compatible server:
// auth, routing, error responses, and SSE streaming.

import type { VercelRequest, VercelResponse } from "@vercel/node";

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

export function isAuthorized(req: VercelRequest): boolean {
  if (!GATEWAY_TOKEN) throw new Error("GATEWAY_TOKEN is not configured");
  return req.headers.authorization === `Bearer ${GATEWAY_TOKEN}`;
}

export function getPathString(req: VercelRequest): string {
  const path = req.query.path;
  if (Array.isArray(path)) return path.join("/");
  return path ?? "";
}

export function isModelsRoute(req: VercelRequest): boolean {
  return req.method === "GET" && getPathString(req).includes("models");
}

export function isMessagesRoute(req: VercelRequest): boolean {
  return req.method === "POST" && getPathString(req).includes("messages");
}

// Vercel's gateway expects the client's Anthropic version headers.
export function getAnthropicForwardHeaders(
  req: VercelRequest,
): Record<string, string> {
  const version = req.headers["anthropic-version"];
  const beta = req.headers["anthropic-beta"];

  const headers: Record<string, string> = {
    "anthropic-version": Array.isArray(version)
      ? version[0]
      : (version ?? "2023-06-01"),
  };
  if (beta) {
    headers["anthropic-beta"] = Array.isArray(beta) ? beta.join(",") : beta;
  }
  return headers;
}

export function resolveAnthropicUrl(
  apiUrl: string,
  pathString: string,
): string {
  if (pathString.includes("count_tokens")) {
    return apiUrl.replace(/\/messages\/?$/, "/count_tokens");
  }
  return apiUrl;
}

export function sendAuthenticationError(res: VercelResponse): void {
  res.status(401).json({
    type: "error",
    error: { type: "authentication_error", message: "Invalid bearer token" },
  });
}

export function sendBadRequest(res: VercelResponse, message: string): void {
  res.status(400).json({
    type: "error",
    error: { type: "invalid_request_error", message },
  });
}

export function sendNotFound(res: VercelResponse): void {
  res.status(404).json({ error: "Not found" });
}

export async function sendUpstreamError(
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

export async function pipeAnthropicStream(
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
