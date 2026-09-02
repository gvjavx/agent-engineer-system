import path from "node:path";
import { config } from "../config.js";

// A small local instruct model that answers non-coding chat before Gemini is
// tried (agent/chatAssistant.ts). Lazy: @huggingface/transformers + the
// weights (~350MB–1GB depending on dtype, downloaded once to data/hf-cache)
// only load when CHAT_LOCAL_LLM is on. CPU-only, no API. A failure/timeout
// here just means the reply falls through to the configured Gemini provider.

const MODEL_ID = process.env.CHAT_LOCAL_LLM_MODEL ?? "onnx-community/Qwen2.5-0.5B-Instruct";
const CACHE_DIR = path.join(path.dirname(config.dbPath), "hf-cache");

const DTYPES = ["auto", "fp32", "fp16", "q8", "int8", "uint8", "q4", "bnb4", "q4f16"] as const;
type Dtype = (typeof DTYPES)[number];
const DTYPE: Dtype = (DTYPES as readonly string[]).includes(process.env.CHAT_LOCAL_LLM_DTYPE ?? "")
  ? (process.env.CHAT_LOCAL_LLM_DTYPE as Dtype)
  : "q4";

const GEN_TIMEOUT_MS = Math.max(3000, Number(process.env.CHAT_LOCAL_LLM_TIMEOUT_MS ?? 25_000));
const MAX_NEW_TOKENS = Math.max(32, Number(process.env.CHAT_LOCAL_LLM_MAX_TOKENS ?? 240));

type ChatMsg = { role: string; content: string };
type GenPipe = (
  messages: ChatMsg[],
  opts: Record<string, unknown>
) => Promise<Array<{ generated_text: string | ChatMsg[] }>>;

let pipePromise: Promise<GenPipe> | undefined;

async function getPipe(): Promise<GenPipe> {
  if (!pipePromise) {
    pipePromise = (async () => {
      let mod: typeof import("@huggingface/transformers");
      try {
        mod = await import("@huggingface/transformers");
      } catch (err) {
        throw new Error(
          `@huggingface/transformers isn't available (${err instanceof Error ? err.message : String(err)}) — ` +
            `install it in apps/orchestrator to use CHAT_LOCAL_LLM, or leave the flag off.`
        );
      }
      mod.env.cacheDir = CACHE_DIR;
      return (await mod.pipeline("text-generation", MODEL_ID, { dtype: DTYPE })) as unknown as GenPipe;
    })();
    pipePromise.catch(() => {
      pipePromise = undefined;
    });
  }
  return pipePromise;
}

// Returns the model's reply, or undefined on any failure/timeout/empty output
// (caller then falls back to Gemini).
export async function generateLocalReply(system: string, userMessage: string): Promise<string | undefined> {
  try {
    const pipe = await getPipe();
    const run = pipe([{ role: "system", content: system }, { role: "user", content: userMessage }], {
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
      return_full_text: false,
    });
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("local llm timeout")), GEN_TIMEOUT_MS));
    const out = await Promise.race([run, timeout]);

    const gen = out?.[0]?.generated_text;
    const text =
      typeof gen === "string"
        ? gen
        : Array.isArray(gen)
          ? String(gen[gen.length - 1]?.content ?? "")
          : "";
    const trimmed = text.trim();
    return trimmed.length >= 2 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export function warmLocalLlm(): void {
  void getPipe().catch((err) => {
    console.error("[local-llm] warm-up failed:", err instanceof Error ? err.message : err);
  });
}
