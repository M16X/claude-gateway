// Anthropic <-> OpenAI translation. Only needed for OpenAI-protocol
// providers (zen); Anthropic-native providers pass through untouched.

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

export interface OpenAiChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

export interface OpenAiChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { completion_tokens?: number };
}

export function mapStopReason(
  finishReason: string | null | undefined,
): string {
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

type ContentBlock = {
  type?: string;
  text?: string;
  content?: string | Array<{ text?: string }>;
};

function toolResultToText(content: ContentBlock["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text ?? "").join("");
}

function blockToText(block: ContentBlock): string {
  if (block?.type === "text") return block.text ?? "";
  if (block?.type === "tool_result") return toolResultToText(block.content);
  return "";
}

export function anthropicContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return (content as ContentBlock[])
    .map(blockToText)
    .filter((text) => text.length > 0)
    .join("\n");
}

export function anthropicToOpenAI(
  body: AnthropicRequestBody,
  model: string,
): OpenAiChatBody {
  const messages: OpenAiChatBody["messages"] = [];

  if (body.system) {
    const systemText = Array.isArray(body.system)
      ? body.system.map((block) => block.text ?? "").join("\n")
      : body.system;
    messages.push({ role: "system", content: systemText });
  }

  for (const message of body.messages ?? []) {
    messages.push({
      role: message.role,
      content: anthropicContentToText(message.content),
    });
  }

  const openaiBody: OpenAiChatBody = {
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

export function openAIToAnthropic(
  response: OpenAiChatResponse,
  fallbackModel: string,
): Record<string, unknown> {
  const choice = response.choices?.[0] ?? {};
  const usage = response.usage ?? {};

  return {
    id: response.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: response.model ?? fallbackModel,
    content: [{ type: "text", text: choice.message?.content ?? "" }],
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}
