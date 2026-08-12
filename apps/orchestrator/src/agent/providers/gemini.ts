import crypto from "node:crypto";
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type { ChatMessage, Provider, ProviderResponse, ToolCallRequest, ToolSchema } from "../types.js";
import { ProviderError, PROVIDER_REQUEST_TIMEOUT_MS, extractHttpStatus } from "../types.js";

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
}

// Gemini's Content.role only accepts 'user' or 'model' — tool results are
// sent back as a 'user' turn carrying a functionResponse part, per the API's
// own documented multi-turn function-calling convention.
export function toGeminiContents(messages: ChatMessage[]): Content[] {
  const contents: Content[] = [];
  for (const message of messages) {
    if (message.role === "system") continue; // handled as systemInstruction

    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content ?? "" }] });
    } else if (message.role === "assistant") {
      const parts: Part[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        const thoughtSignature = (call.providerData as { thoughtSignature?: string } | undefined)
          ?.thoughtSignature;
        parts.push({
          functionCall: { id: call.id, name: call.name, args: call.input },
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
      }
      contents.push({ role: "model", parts });
    } else if (message.role === "tool") {
      // Consecutive tool-result messages (one assistant turn can invoke
      // several tools) belong in a single 'user' turn as multiple
      // functionResponse parts, not several back-to-back same-role turns.
      const responsePart: Part = {
        functionResponse: {
          id: message.toolCallId,
          name: message.toolName ?? "",
          response: { output: message.content ?? "" },
        },
      };
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts?.every((p) => p.functionResponse)) {
        last.parts.push(responsePart);
      } else {
        contents.push({ role: "user", parts: [responsePart] });
      }
    }
  }
  return contents;
}

// One user turn carrying the image inline plus the instruction text — Gemini's
// Part type already supports inlineData as a sibling to text, no new import
// needed.
export function buildGeminiVisionContents(base64Data: string, mimeType: string, prompt: string): Content[] {
  return [{ role: "user", parts: [{ inlineData: { mimeType, data: base64Data } }, { text: prompt }] }];
}

export function toGeminiTools(tools: ToolSchema[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parameters,
      })),
    },
  ];
}

export class GeminiProvider implements Provider {
  name = "gemini";
  model: string;
  private client: GoogleGenAI;

  constructor(options: GeminiProviderOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model;
  }

  async chat(messages: ChatMessage[], tools: ToolSchema[], signal: AbortSignal): Promise<ProviderResponse> {
    const systemMessage = messages.find((m) => m.role === "system");

    let response;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: toGeminiContents(messages),
        config: {
          systemInstruction: systemMessage?.content,
          tools: toGeminiTools(tools),
          abortSignal: signal,
          httpOptions: { timeout: PROVIDER_REQUEST_TIMEOUT_MS },
        },
      });
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err), err, extractHttpStatus(err));
    }

    // Walk the raw parts (not the response.functionCalls/response.text convenience
    // getters) so we can capture each call's sibling thoughtSignature — Gemini 3.x
    // requires it to be echoed back verbatim on replay or the next turn errors —
    // and so we don't trip the SDK's own console.warn, which fires on response.text
    // any time a part has a non-text field like functionCall (i.e. on every tool call).
    const rawParts = response.candidates?.[0]?.content?.parts ?? [];
    const calls: ToolCallRequest[] = rawParts
      .filter((p) => p.functionCall)
      .map((p) => ({
        id: p.functionCall?.id ?? crypto.randomUUID(),
        name: p.functionCall?.name ?? "",
        input: (p.functionCall?.args ?? {}) as Record<string, unknown>,
        providerData: p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : undefined,
      }));
    const text = rawParts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("");

    if (calls.length > 0) {
      return { type: "tool_calls", calls, text };
    }

    return { type: "text", text };
  }

  async describeImage(base64Data: string, mimeType: string, prompt: string, signal: AbortSignal): Promise<string> {
    let response;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: buildGeminiVisionContents(base64Data, mimeType, prompt),
        config: { abortSignal: signal, httpOptions: { timeout: PROVIDER_REQUEST_TIMEOUT_MS } },
      });
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err), err, extractHttpStatus(err));
    }
    return response.text ?? "";
  }
}
