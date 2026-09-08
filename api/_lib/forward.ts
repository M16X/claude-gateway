// Talking to upstream providers. DeepInfra and Vercel speak Anthropic
// natively; Zen speaks OpenAI, so it goes through the bridge.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getModelInfo } from "./models.js";
import { PROVIDERS, requireApiKey } from "./providers.js";
import {
  getAnthropicForwardHeaders,
  getPathString,
  pipeAnthropicStream,
  resolveAnthropicUrl,
  sendUpstreamError,
  setSseHeaders,
} from "./server.js";
import {
  anthropicToOpenAI,
  mapStopReason,
  openAIToAnthropic,
  type AnthropicRequestBody,
  type OpenAiStreamChunk,
} from "./translate.js";

// Single entry point: the request's model decides the upstream.
export async function forwardToProvider(
  req: VercelRequest,
  res: VercelResponse,
  body: AnthropicRequestBody,
): Promise<void> {
  const model = getModelInfo(body.model);

  if (model.provider === "zen") return forwardToZen(res, body, model.id);
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

async function forwardToZen(
  res: VercelResponse,
  body: AnthropicRequestBody,
  zenModel: string,
): Promise<void> {
  const openaiBody = anthropicToOpenAI(body, zenModel);

  const upstream = await fetch(PROVIDERS.zen.API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey("zen")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(openaiBody),
  });

  if (!upstream.ok || !upstream.body) {
    await sendUpstreamError(res, upstream);
    return;
  }

  if (!openaiBody.stream) {
    res.status(200).json(openAIToAnthropic(await upstream.json(), body.model));
    return;
  }

  await streamOpenAiAsAnthropic(upstream.body, res, body.model);
}

// Reads an OpenAI SSE stream and re-emits it as Anthropic SSE events.
async function streamOpenAiAsAnthropic(
  upstreamBody: ReadableStream<Uint8Array>,
  res: VercelResponse,
  fallbackModel: string,
): Promise<void> {
  setSseHeaders(res);
  const writer = new AnthropicStreamWriter(res, fallbackModel);

  try {
    for await (const data of readSsePayloads(upstreamBody)) {
      let chunk: OpenAiStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAiStreamChunk;
      } catch {
        continue;
      }

      writer.start(chunk);

      const text = chunk.choices?.[0]?.delta?.content;
      if (text) writer.appendText(text);

      if (chunk.choices?.[0]?.finish_reason) writer.finish(chunk);
    }
  } finally {
    writer.close();
  }
}

// Yields each `data:` payload from an SSE stream, handling chunk
// boundaries, keep-alives, and the terminal `[DONE]` marker.
async function* readSsePayloads(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice("data:".length).trim();
        if (data === "" || data === "[DONE]") continue;
        yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Writes the Anthropic message SSE sequence (start -> deltas -> stop).
// `close()` always ends the response, finishing an open message first.
class AnthropicStreamWriter {
  private started = false;
  private finished = false;

  constructor(
    private res: VercelResponse,
    private fallbackModel: string,
  ) {}

  start(chunk: OpenAiStreamChunk): void {
    if (this.started) return;
    this.started = true;

    this.event("message_start", {
      type: "message_start",
      message: {
        id: chunk.id ?? `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: chunk.model ?? this.fallbackModel,
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    this.event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
  }

  appendText(text: string): void {
    this.event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
  }

  finish(chunk: OpenAiStreamChunk): void {
    if (this.finished) return;
    this.finished = true;

    this.event("content_block_stop", { type: "content_block_stop", index: 0 });
    this.event("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapStopReason(chunk.choices?.[0]?.finish_reason),
        stop_sequence: null,
      },
      usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 },
    });
    this.event("message_stop", { type: "message_stop" });
  }

  close(): void {
    if (this.started && !this.finished) this.finish({});
    this.res.end();
  }

  private event(name: string, data: unknown): void {
    this.res.write(`event: ${name}\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
