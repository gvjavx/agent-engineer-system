import { GoogleGenAI } from "@google/genai";
import { PROVIDER_REQUEST_TIMEOUT_MS } from "../types.js";

// Separate from the chat `Provider` interface (agent/types.ts) on purpose:
// embedding is its own API surface, only one vendor implements it here, and
// the agent loop never touches it directly.
export interface EmbeddingProvider {
  name: string;
  model: string;
  // Stable string identifying model + output shape together. Stored per
  // project and compared on every index run — changing the model OR the
  // dimensionality forces a full reindex, since old vectors would no longer
  // be comparable to new ones.
  identity: string;
  // One vector per input text, in the same order. Throws on any failure or a
  // response whose shape doesn't line up with the request — callers treat a
  // throw as "no retrieval this time", never as a task failure.
  embed(texts: string[], kind: "document" | "query", signal: AbortSignal): Promise<Float32Array[]>;
}

// Gemini caps how many inputs one embedContent call accepts, and the free
// tier is happier with smaller payloads — stay well under both.
const EMBED_BATCH_SIZE = 32;

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  name = "gemini";
  model: string;
  identity: string;
  private client: GoogleGenAI;
  private dim: number;

  constructor(opts: { apiKey: string; model: string; dim: number }) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.dim = opts.dim;
    this.identity = `${opts.model}@${opts.dim}`;
  }

  async embed(texts: string[], kind: "document" | "query", signal: AbortSignal): Promise<Float32Array[]> {
    const taskType = kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const out: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      let response;
      try {
        response = await this.client.models.embedContent({
          model: this.model,
          contents: batch,
          config: {
            taskType,
            outputDimensionality: this.dim,
            abortSignal: signal,
            httpOptions: { timeout: PROVIDER_REQUEST_TIMEOUT_MS },
          },
        });
      } catch (err) {
        throw new Error(`[gemini-embed] ${err instanceof Error ? err.message : String(err)}`);
      }

      const vectors = response.embeddings ?? [];
      if (vectors.length !== batch.length) {
        throw new Error(`[gemini-embed] asked for ${batch.length} embeddings, got ${vectors.length}`);
      }
      for (const v of vectors) {
        if (!v.values || v.values.length === 0) throw new Error("[gemini-embed] empty embedding in response");
        out.push(Float32Array.from(v.values));
      }
    }

    return out;
  }
}
