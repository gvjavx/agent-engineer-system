import crypto from "node:crypto";
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type { ChatMessage, Provider, ProviderResponse, ToolCallRequest, ToolSchema } from "../types.js";
import { ProviderError, PROVIDER_REQUEST_TIMEOUT_MS, extractHttpStatus } from "../types.js";

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  // Separate model for text-to-speech — the chat model can't do AUDIO output.
  ttsModel?: string;
  // Candidate models for image generation, tried in order — likewise, the
  // chat model can't emit IMAGE. Only set when image generation is configured.
  imageModels?: string[];
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
  id: string;
  private client: GoogleGenAI;
  // Only defined when a TTS model was configured — voiceReply.ts checks for it.
  synthesizeSpeech?: (text: string, signal: AbortSignal) => Promise<{ base64Pcm: string; sampleRate: number }>;
  // Only defined when an image model was configured — imageGeneration.ts checks for it.
  generateImage?: (prompt: string, signal: AbortSignal) => Promise<{ base64: string; mimeType: string }>;

  constructor(options: GeminiProviderOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model;
    this.id = `gemini@${options.model}#${crypto.createHash("sha1").update(options.apiKey).digest("hex").slice(0, 8)}`;
    if (options.ttsModel) this.synthesizeSpeech = this.makeSynthesizeSpeech(options.ttsModel);
    if (options.imageModels?.length) this.generateImage = this.makeGenerateImage(options.imageModels);
  }

  private makeSynthesizeSpeech(ttsModel: string) {
    return async (text: string, signal: AbortSignal): Promise<{ base64Pcm: string; sampleRate: number }> => {
      let response;
      try {
        response = await this.client.models.generateContent({
          model: ttsModel,
          contents: [{ role: "user", parts: [{ text }] }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
            abortSignal: signal,
            httpOptions: { timeout: PROVIDER_REQUEST_TIMEOUT_MS },
          },
        });
      } catch (err) {
        throw new ProviderError(this.name, err instanceof Error ? err.message : String(err), err, extractHttpStatus(err));
      }
      const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      const data = part?.inlineData?.data;
      if (!data) throw new ProviderError(this.name, "TTS: respons nggak bawa audio");
      const rate = Number(/rate=(\d+)/.exec(part?.inlineData?.mimeType ?? "")?.[1]) || 24000;
      return { base64Pcm: data, sampleRate: rate };
    };
  }

  private makeGenerateImage(imageModels: string[]) {
    return async (prompt: string, signal: AbortSignal): Promise<{ base64: string; mimeType: string }> => {
      const failures: string[] = [];
      let lastErr: unknown;
      for (const model of imageModels) {
        try {
          const response = await this.client.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            // These models return an image part plus a short text part; ask for
            // both since IMAGE-only is rejected by some of them.
            config: {
              responseModalities: ["IMAGE", "TEXT"],
              abortSignal: signal,
              httpOptions: { timeout: PROVIDER_REQUEST_TIMEOUT_MS },
            },
          });
          const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
          const data = part?.inlineData?.data;
          if (!data) throw new Error("respons nggak bawa gambar");
          return { base64: data, mimeType: part?.inlineData?.mimeType ?? "image/png" };
        } catch (err) {
          lastErr = err;
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[image-gen] ${model}:`, message);
          // Keep the model name + first line of each failure — the user only
          // sees this via the WhatsApp reply, so all attempts have to be in it.
          failures.push(`${model}: ${message.split("\n")[0].slice(0, 200)}`);
        }
      }
      throw new ProviderError(this.name, failures.join(" | "), lastErr, extractHttpStatus(lastErr));
    };
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

  async transcribeAudio(base64Data: string, mimeType: string, signal: AbortSignal): Promise<string> {
    const prompt =
      "Transcribe this WhatsApp voice note verbatim. The speaker is Indonesian and the language is Indonesian; keep English only for genuine technical terms actually said (git, deploy, endpoint, commit, dark mode, etc.). " +
      "Do not substitute an English word that merely sounds like the Indonesian one: a short English word or phrase landing in the middle of an Indonesian sentence is almost always the Indonesian word it rhymes with — \"hurry up\" is \"hari apa\", \"jump\" is \"jam\", \"my\"/\"mao\" is \"mau\", \"kiss\"/\"quiz\" is \"kuis\", \"click\"/\"trick\" is \"klik\", \"tolong\" not \"too long\". Prefer the reading that makes sense in the sentence. " +
      "Output only the transcription, no preamble, no translation, no timestamps.";
    let response;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        // Same inline-media + text shape as the vision path; the Part type
        // takes audio in inlineData just as well as an image.
        contents: buildGeminiVisionContents(base64Data, mimeType, prompt),
        config: { abortSignal: signal, httpOptions: { timeout: PROVIDER_REQUEST_TIMEOUT_MS } },
      });
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err), err, extractHttpStatus(err));
    }
    return response.text ?? "";
  }
}
