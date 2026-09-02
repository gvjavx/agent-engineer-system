import path from "node:path";
import { config } from "../config.js";

// Local sentence-embedding model, shared by the chat KB's semantic paraphrase
// match (agent/chatKb.ts) and code retrieval (agent/rag). Lazy:
// @huggingface/transformers and the model weights (~120MB, downloaded once)
// only load when CHAT_KB_SEMANTIC or RAG_ENABLED is on. CPU-only, no API, no
// rate limit. The download is cached next to the sqlite db so it survives on
// the same volume/mount.

const MODEL_ID = process.env.CHAT_KB_EMBED_MODEL ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const CACHE_DIR = path.join(path.dirname(config.dbPath), "hf-cache");

const DTYPES = ["auto", "fp32", "fp16", "q8", "int8", "uint8", "q4", "bnb4", "q4f16"] as const;
type Dtype = (typeof DTYPES)[number];
// q8: int8-quantized ONNX (~4x smaller download, fast on CPU, negligible
// quality loss for similarity). Override with CHAT_KB_EMBED_DTYPE.
const DTYPE: Dtype = (DTYPES as readonly string[]).includes(process.env.CHAT_KB_EMBED_DTYPE ?? "")
  ? (process.env.CHAT_KB_EMBED_DTYPE as Dtype)
  : "q8";

// Stored alongside anything embedded with this model so a model/dtype change
// forces a re-embed instead of comparing incomparable vectors.
export const LOCAL_EMBED_IDENTITY = `local:${MODEL_ID}@${DTYPE}`;

type FeaturePipe = (text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array | number[] }>;

let pipePromise: Promise<FeaturePipe> | undefined;

async function getPipe(): Promise<FeaturePipe> {
  if (!pipePromise) {
    pipePromise = (async () => {
      let mod: typeof import("@huggingface/transformers");
      try {
        mod = await import("@huggingface/transformers");
      } catch (err) {
        throw new Error(
          `@huggingface/transformers isn't available (${err instanceof Error ? err.message : String(err)}) — ` +
            `install it in apps/orchestrator to use CHAT_KB_SEMANTIC, or leave the flag off.`
        );
      }
      mod.env.cacheDir = CACHE_DIR;
      return (await mod.pipeline("feature-extraction", MODEL_ID, { dtype: DTYPE })) as unknown as FeaturePipe;
    })();
    // A failed load (missing dep, interrupted download) shouldn't be sticky —
    // let the next call try again.
    pipePromise.catch(() => {
      pipePromise = undefined;
    });
  }
  return pipePromise;
}

// One unit-length vector per input. Mean-pooled, L2-normalized, so a plain dot
// product is cosine similarity.
export async function embedLocal(texts: string[]): Promise<Float32Array[]> {
  const pipe = await getPipe();
  const out: Float32Array[] = [];
  for (const text of texts) {
    const res = await pipe(text, { pooling: "mean", normalize: true });
    out.push(res.data instanceof Float32Array ? res.data : Float32Array.from(res.data));
  }
  return out;
}

// Kick off the model load ahead of the first real lookup (called from startup
// when the flag is on). Best-effort — a failure here is not fatal.
export function warmLocalEmbedder(): void {
  void getPipe().catch((err) => {
    console.error("[chat-kb] local embedder warm-up failed:", err instanceof Error ? err.message : err);
  });
}
