import type { VercelRequest, VercelResponse } from "@vercel/node";

const DEEPINFRA_API_URL = "https://api.deepinfra.com/anthropic/v1/messages";
const ZEN_API_URL = "https://opencode.ai/zen/v1/chat/completions";

const TOKEN = process.env.GATEWAY_TOKEN;
const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY;
const ZEN_API_KEY = process.env.ZEN_API_KEY;
const MODELS = JSON.parse(process.env.MODELS || "{}");

type ModelInfo = { id: string; name: string; provider?: string };

function authenticate(req: VercelRequest): boolean {
  if (!TOKEN) {
    throw new Error("GATEWAY_TOKEN is not configured");
  }

  const auth = req.headers.authorization;

  return auth === `Bearer ${TOKEN}`;
}

async function loadModels(): Promise<Record<string, ModelInfo>> {
  return MODELS;
}

async function getModelInfo(model: string): Promise<ModelInfo> {
  const map = await loadModels();
  return map[model] ?? { id: model, name: model, provider: "deepinfra" };
}

function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    default:
      return "end_turn";
  }
}

function anthropicContentToOpenAI(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "tool_result") {
        if (typeof block.content === "string") return block.content;
        if (Array.isArray(block.content)) {
          return block.content.map((b: any) => b?.text ?? "").join("");
        }
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function anthropicToOpenAI(body: any, model: string): any {
  const messages: any[] = [];

  if (body.system) {
    const systemText = Array.isArray(body.system)
      ? body.system.map((b: any) => b.text).join("\n")
      : body.system;
    messages.push({ role: "system", content: systemText });
  }

  for (const message of body.messages ?? []) {
    messages.push({
      role: message.role,
      content: anthropicContentToOpenAI(message.content),
    });
  }

  const openaiBody: any = {
    model,
    messages,
    stream: Boolean(body.stream),
  };

  if (body.max_tokens != null) openaiBody.max_tokens = body.max_tokens;
  if (body.temperature != null) openaiBody.temperature = body.temperature;
  if (body.top_p != null) openaiBody.top_p = body.top_p;
  if (body.stop_sequences) openaiBody.stop = body.stop_sequences;

  return openaiBody;
}

function openAIToAnthropic(response: any, model: string): any {
  const choice = response.choices?.[0] ?? {};
  const usage = response.usage ?? {};

  return {
    id: response.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: response.model ?? model,
    content: [{ type: "text", text: choice.message?.content ?? "" }],
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

async function handleZen(
  res: VercelResponse,
  body: any,
  zenModel: string,
): Promise<void> {
  if (!ZEN_API_KEY) {
    throw new Error("ZEN_API_KEY is not configured");
  }

  const openaiBody = anthropicToOpenAI(body, zenModel);

  const upstream = await fetch(ZEN_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ZEN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(openaiBody),
  });

  if (!upstream.ok || !upstream.body) {
    const errorBody = await upstream.text();
    console.log(errorBody);
    res.status(upstream.status).json({
      type: "error",
      error: { type: "upstream_error", message: errorBody },
    });
    return;
  }

  if (!openaiBody.stream) {
    const json = await upstream.json();
    res.status(200).json(openAIToAnthropic(json, body.model));
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let messageId: string | null = null;
  let started = false;
  let finished = false;

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const ensureStart = (chunk: any) => {
    if (started) return;
    started = true;
    messageId = chunk.id ?? `msg_${Date.now()}`;

    sendEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: chunk.model ?? body.model,
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sendEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
  };

  const finishMessage = (chunk: any) => {
    if (finished) return;
    finished = true;

    sendEvent("content_block_stop", { type: "content_block_stop", index: 0 });
    sendEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapStopReason(chunk.finish_reason),
        stop_sequence: null,
      },
      usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 },
    });
    sendEvent("message_stop", { type: "message_stop" });
  };

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

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        const chunk = JSON.parse(data);
        ensureStart(chunk);

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          sendEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta.content },
          });
        }

        if (chunk.choices?.[0]?.finish_reason) {
          finishMessage(chunk);
        }
      }
    }
  } finally {
    if (started && !finished) finishMessage({});
    reader.releaseLock();
    res.end();
  }
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
          provider: info.provider ?? "deepinfra",
        })),
      });
    }

    // /anthropic/v1/messages
    if (req.method === "POST" && path?.includes("messages")) {
      const body = req.body;
      const modelInfo = await getModelInfo(body.model);

      if (modelInfo.provider === "zen") {
        await handleZen(res, body, modelInfo.id);
        return;
      }

      if (!DEEPINFRA_API_KEY) {
        throw new Error("DEEPINFRA_API_KEY is not configured");
      }

      const response = await fetch(DEEPINFRA_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...body,
          stream: true,
          model: modelInfo.id,
          fail_fast: true,
          service_tier: "default",
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
