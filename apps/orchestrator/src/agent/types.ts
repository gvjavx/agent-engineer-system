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

// Every provider call in this codebase (classifiers included) used to have
// no timeout at all: Gemini's SDK is unbounded unless httpOptions.timeout is
// set, and the openai SDK defaults to 10 minutes per attempt with 2 retries
// (~30 min worst case). A slow/hung provider silently stalled the whole
// message — no fallback to the next provider, no feedback to the user. Both
// provider adapters bound every request to this, converting a hang into a
// fast, bounded failure that existing fail-safe defaults (classifiers) or
// the fallback chain (agent loop) already handle gracefully.
export const PROVIDER_REQUEST_TIMEOUT_MS = 60_000;

export type ProviderResponse =
  | { type: "tool_calls"; calls: ToolCallRequest[]; text?: string }
  | { type: "text"; text: string };

export interface Provider {
  name: string;
  // Optional: which model this instance talks to. Lets loop.ts's fallback
  // messaging say "ganti model" instead of "ganti API key" when two entries
  // in the chain share a name but not a model. Test doubles that don't care
  // (most of them) just omit it.
  model?: string;
  chat(messages: ChatMessage[], tools: ToolSchema[], signal: AbortSignal): Promise<ProviderResponse>;
  // Optional: only providers whose underlying API actually supports vision
  // implement this. Absent means "this provider can't see images" —
  // agent/imageDescription.ts skips it rather than calling and catching a
  // throw. Kept off the required Provider shape so the many test doubles
  // across this codebase that construct a bare {name, chat} don't need to
  // grow one just to satisfy the compiler.
  describeImage?(base64Data: string, mimeType: string, prompt: string, signal: AbortSignal): Promise<string>;
}

// Both the Gemini SDK's ApiError and the openai package's APIError expose a
// numeric .status on the thrown error; this reads it without either provider
// adapter needing to import the other SDK's types.
export function extractHttpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return undefined;
}

export class ProviderError extends Error {
  constructor(
    public providerName: string,
    message: string,
    public cause?: unknown,
    // HTTP status of the underlying API error, when the SDK exposes one
    // (Gemini's ApiError and the openai package's APIError both do). Lets
    // callers tell a transient 429 apart from a dead key/auth failure
    // without string-matching the message.
    public status?: number
  ) {
    super(`[${providerName}] ${message}`);
  }
}
