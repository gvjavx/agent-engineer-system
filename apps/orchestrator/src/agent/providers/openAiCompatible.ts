import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ChatMessage, Provider, ProviderResponse, ToolCallRequest, ToolSchema } from "../types.js";
import { ProviderError } from "../types.js";

export interface OpenAiCompatibleProviderOptions {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export function toOpenAiMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content ?? "" };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      };
    }
    return { role: m.role as "system" | "user" | "assistant", content: m.content ?? "" };
  });
}

export function toOpenAiTools(tools: ToolSchema[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Used for any OpenAI-compatible chat-completions endpoint — Qwen/DashScope,
// OpenRouter, and any future free provider that speaks this API shape. Adding
// a new one is just a new instance of this class with a different baseURL/key/model.
export class OpenAiCompatibleProvider implements Provider {
  name: string;
  private client: OpenAI;
  private model: string;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.name = options.name;
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
    this.model = options.model;
  }

  async chat(messages: ChatMessage[], tools: ToolSchema[], signal: AbortSignal): Promise<ProviderResponse> {
    const openAiMessages = toOpenAiMessages(messages);
    const openAiTools = toOpenAiTools(tools);

    let message;
    try {
      const response = await this.client.chat.completions.create(
        { model: this.model, messages: openAiMessages, tools: openAiTools, tool_choice: "auto" },
        { signal }
      );
      message = response.choices[0]?.message;
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err), err);
    }

    if (!message) {
      throw new ProviderError(this.name, "Empty response from provider");
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      const calls: ToolCallRequest[] = message.tool_calls.map((tc) => {
        let input: Record<string, unknown> = {};
        if (tc.type === "function") {
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {
            input = { _raw: tc.function.arguments };
          }
        }
        return { id: tc.id, name: tc.type === "function" ? tc.function.name : tc.id, input };
      });
      return { type: "tool_calls", calls, text: message.content ?? undefined };
    }

    return { type: "text", text: message.content ?? "" };
  }
}
