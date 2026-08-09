// Provider-agnostic message/tool format. Every provider adapter converts
// to/from this shape, so the agent loop and fallback logic never need to
// know which vendor is currently in use.

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
  // Opaque provider-specific data that must be echoed back verbatim when this
  // call is replayed into history (e.g. Gemini's thoughtSignature — required
  // on replayed functionCall parts or the API rejects the next turn). Other
  // providers ignore fields they don't recognize.
  providerData?: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  // Text content. Empty/undefined for an assistant message that is pure tool_calls.
  content?: string;
  // Present on assistant messages that invoked tools.
  toolCalls?: ToolCallRequest[];
  // Present on role:'tool' messages — which call this result answers.
  toolCallId?: string;
  toolName?: string;
}

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [key: string]: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ProviderResponse =
  | { type: "tool_calls"; calls: ToolCallRequest[]; text?: string }
  | { type: "text"; text: string };

export interface Provider {
  name: string;
  chat(messages: ChatMessage[], tools: ToolSchema[], signal: AbortSignal): Promise<ProviderResponse>;
}

export class ProviderError extends Error {
  constructor(
    public providerName: string,
    message: string,
    public cause?: unknown
  ) {
    super(`[${providerName}] ${message}`);
  }
}
