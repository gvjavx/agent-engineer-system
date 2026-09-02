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

// A small model fails in recognisable ways: echoing the prompt or the
// question back, or looping the same phrase. Reject those so the reply falls
// through to Gemini instead of shipping garbage.
export function isUsableLocalReply(text: string, system: string, question: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  const low = t.toLowerCase();

  if (low.includes(system.toLowerCase().slice(0, 40).trim())) return false;

  const q = question.toLowerCase().trim();
  if (q.length > 8 && low.startsWith(q.slice(0, Math.min(q.length, 30))) && t.length < question.length + 15) {
    return false;
  }

  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 3 && new Set(lines).size <= Math.ceil(lines.length / 3)) return false;

  const words = low.split(/\s+/);
  for (let n = 3; n <= 6 && words.length >= n * 3; n++) {
    const seen = new Map<string, number>();
    for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n).join(" ");
      const c = (seen.get(g) ?? 0) + 1;
      if (c >= 3) return false;
      seen.set(g, c);
    }
  }
  return true;
}

// Returns the model's reply, or undefined on any failure/timeout/empty or
// low-quality output (caller then falls back to Gemini).
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
      typeof gen === "string" ? gen : Array.isArray(gen) ? String(gen[gen.length - 1]?.content ?? "") : "";
    const trimmed = text.trim();
    return isUsableLocalReply(trimmed, system, userMessage) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export function warmLocalLlm(): void {
  const t0 = Date.now();
  void getPipe()
    .then(() => console.log(`[local-llm] ${MODEL_ID} (${DTYPE}) ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`))
    .catch((err) => console.error("[local-llm] load failed, chat will use the vendor:", err instanceof Error ? err.message : err));
}
