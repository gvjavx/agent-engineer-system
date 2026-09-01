import { GoogleGenAI } from "@google/genai";
import { PROVIDER_REQUEST_TIMEOUT_MS, extractHttpStatus } from "../types.js";

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
  // throw as "no retrieval this time", never as a task failure. "similarity"
  // is for symmetric text-to-text matching (the chat cache); "document"/
  // "query" are the asymmetric pair for code retrieval. A tight AbortSignal
  // (e.g. AbortSignal.timeout) caps the 429 retry wait for latency-sensitive
  // callers.
  embed(texts: string[], kind: "document" | "query" | "similarity", signal: AbortSignal): Promise<Float32Array[]>;
}

// Gemini caps how many inputs one embedContent call accepts, and the free
// tier is happier with smaller payloads — stay well under both.
const EMBED_BATCH_SIZE = 32;

// Free-tier gemini-embedding-001 has a low per-minute request quota and 429s
// under any real chat volume. On a 429 we rotate to the next configured API
// key first (each key has its own quota); only once every key has 429'd do we
// sleep out the per-minute window and try the whole ring again. Callers that
// can't wait (the reply-path cache lookup) pass a short AbortSignal.timeout,
// which breaks this early — a slow lookup just misses and the model answers.
const RATE_LIMIT_FULL_CYCLES = 3;
const RATE_LIMIT_DELAY_MS = 8000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  name = "gemini";
  model: string;
  identity: string;
  private clients: GoogleGenAI[];
  private keyIndex = 0;
  private dim: number;

  constructor(opts: { apiKeys: string[]; model: string; dim: number }) {
    const keys = opts.apiKeys.length > 0 ? opts.apiKeys : [""];
    this.clients = keys.map((apiKey) => new GoogleGenAI({ apiKey }));
    this.model = opts.model;
    this.dim = opts.dim;
    this.identity = `${opts.model}@${opts.dim}`;
  }

  async embed(texts: string[], kind: "document" | "query" | "similarity", signal: AbortSignal): Promise<Float32Array[]> {
    const taskType =
      kind === "query" ? "RETRIEVAL_QUERY" : kind === "similarity" ? "SEMANTIC_SIMILARITY" : "RETRIEVAL_DOCUMENT";
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      out.push(...(await this.embedBatch(texts.slice(i, i + EMBED_BATCH_SIZE), taskType, signal)));
    }
    return out;
  }

  private async embedBatch(batch: string[], taskType: string, signal: AbortSignal): Promise<Float32Array[]> {
    let cyclesWaited = 0;
    for (;;) {
      let response;
      try {
        response = await this.clients[this.keyIndex].models.embedContent({
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
        if (extractHttpStatus(err) === 429 && !signal.aborted) {
          this.keyIndex = (this.keyIndex + 1) % this.clients.length;
          if (this.keyIndex === 0) {
            // A full lap of the key ring 429'd — wait out the per-minute
            // window before another lap, up to a cap.
            if (cyclesWaited >= RATE_LIMIT_FULL_CYCLES) {
              throw new Error(`[gemini-embed] rate limited on every key after ${cyclesWaited} cycles`);
            }
            cyclesWaited++;
            await sleep(RATE_LIMIT_DELAY_MS, signal);
          }
          if (!signal.aborted) continue;
        }
        throw new Error(`[gemini-embed] ${err instanceof Error ? err.message : String(err)}`);
      }

      const vectors = response.embeddings ?? [];
      if (vectors.length !== batch.length) {
        throw new Error(`[gemini-embed] asked for ${batch.length} embeddings, got ${vectors.length}`);
      }
      return vectors.map((v) => {
        if (!v.values || v.values.length === 0) throw new Error("[gemini-embed] empty embedding in response");
        return Float32Array.from(v.values);
      });
    }
  }
}
