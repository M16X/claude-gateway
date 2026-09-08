// Talking to upstream providers. DeepInfra and Vercel speak Anthropic
// natively, so requests pass through untouched.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getModelInfo } from "./models.js";
import { PROVIDERS, requireApiKey } from "./providers.js";
import {
  getAnthropicForwardHeaders,
  getPathString,
  pipeAnthropicStream,
  resolveAnthropicUrl,
  sendUpstreamError,
} from "./server.js";

export interface AnthropicRequestBody {
  model: string;
  system?: string | Array<{ text?: string }>;
  messages?: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  // Any other Anthropic params (tools, metadata, ...) pass through untouched.
  [key: string]: unknown;
}

// Single entry point: the request's model decides the upstream.
export async function forwardToProvider(
  req: VercelRequest,
  res: VercelResponse,
  body: AnthropicRequestBody,
): Promise<void> {
  const model = getModelInfo(body.model);

  if (model.provider === "vercel") {
    return forwardToVercel(req, res, body, model.id);
  }
  return forwardToDeepinfra(res, body, model.id);
}

async function forwardToDeepinfra(
  res: VercelResponse,
  body: AnthropicRequestBody,
  model: string,
): Promise<void> {
  // DeepInfra always streams; the Anthropic wire is passed through as-is.
  return forwardAnthropic(res, {
    targetUrl: PROVIDERS.deepinfra.API_URL,
    apiKey: requireApiKey("deepinfra"),
    payload: {
      ...body,
      model,
      stream: true,
      fail_fast: true,
      service_tier: "default",
    },
    stream: true,
  });
}

async function forwardToVercel(
  req: VercelRequest,
  res: VercelResponse,
  body: AnthropicRequestBody,
  model: string,
): Promise<void> {
  return forwardAnthropic(res, {
    targetUrl: resolveAnthropicUrl(
      PROVIDERS.vercel.API_URL,
      getPathString(req),
    ),
    apiKey: requireApiKey("vercel"),
    payload: { ...body, model },
    extraHeaders: getAnthropicForwardHeaders(req),
    stream: Boolean(body.stream),
  });
}

interface AnthropicForwardOptions {
  targetUrl: string;
  apiKey: string;
  payload: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  stream: boolean;
}

async function forwardAnthropic(
  res: VercelResponse,
  { targetUrl, apiKey, payload, extraHeaders, stream }: AnthropicForwardOptions,
): Promise<void> {
  const upstream = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    await sendUpstreamError(res, upstream);
    return;
  }

  if (!stream) {
    res.status(200).json(await upstream.json());
    return;
  }

  await pipeAnthropicStream(upstream.body, res);
}
