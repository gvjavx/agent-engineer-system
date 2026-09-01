import { config } from "../config.js";
import { chatKbRepo } from "../db/chatKb.js";
import { buildEmbeddingProvider, cosineSimilarity, type EmbeddingProvider } from "./rag/index.js";

export type InteractionKind = "chat_model" | "chat_arithmetic";

export interface ChatKbOpts {
  // Test seams. enabled overrides the config flag; embedder null = "no
  // embedder", undefined = build the real one.
  enabled?: boolean;
  embedder?: EmbeddingProvider | null;
}

// Kept for the existing call sites/tests that imported the old name.
export type RecordInteractionOpts = ChatKbOpts;

function resolveEmbedder(opts: ChatKbOpts): EmbeddingProvider | undefined {
  return opts.embedder === undefined ? buildEmbeddingProvider() : opts.embedder ?? undefined;
}

// Stage 0: write a chat Q&A into the knowledge base, and best-effort backfill
// its question vector. Nothing reads this yet. Called fire-and-forget from the
// chat handler — a failure here must never touch the reply the user already
// got, so every step is guarded and the row is saved before the embedding is
// even attempted.
export async function recordInteraction(
  params: { fromNumber: string; kind: InteractionKind; question: string; answer: string },
  opts: ChatKbOpts = {}
): Promise<void> {
  if (!(opts.enabled ?? config.chatKb.enabled)) return;
  const { fromNumber, kind, question, answer } = params;
  if (!question.trim() || !answer.trim()) return;

  let id: number;
  try {
    id = chatKbRepo.insert(fromNumber, kind, question, answer);
  } catch {
    return;
  }

  // An arithmetic answer needs no vector — the calculator (agent/calc.ts)
  // already generalizes over every expression, so there's nothing to retrieve.
  if (kind === "chat_arithmetic") return;

  const embedder = resolveEmbedder(opts);
  if (!embedder) return;

  try {
    // "similarity" (not "document") — the lookup embeds the incoming question
    // the same way, and this is symmetric question-to-question matching.
    const [vec] = await embedder.embed([question], "similarity", new AbortController().signal);
    if (vec) chatKbRepo.setEmbedding(id, vec);
  } catch {
    // Row stays saved with a NULL embedding; a later backfill pass can pick it up.
  }
}

// Stage 1: if this question is close enough to one already answered for this
// user, return that stored answer — no model call. undefined means "no match,
// fall through to the model" (which will then record the fresh answer).
export async function lookupCachedAnswer(
  params: { fromNumber: string; question: string },
  opts: ChatKbOpts = {}
): Promise<string | undefined> {
  if (!(opts.enabled ?? config.chatKb.enabled)) return undefined;
  const question = params.question.trim();
  if (!question) return undefined;

  const embedder = resolveEmbedder(opts);
  if (!embedder) return undefined;

  const rows = chatKbRepo.embeddedForNumber(params.fromNumber).filter((r) => r.kind !== "chat_arithmetic");
  if (rows.length === 0) return undefined;

  let queryVec: Float32Array | undefined;
  try {
    [queryVec] = await embedder.embed([question], "similarity", new AbortController().signal);
  } catch {
    return undefined;
  }
  if (!queryVec) return undefined;

  let best = { score: -1, answer: "" };
  for (const row of rows) {
    const score = cosineSimilarity(queryVec, row.embedding);
    if (score > best.score) best = { score, answer: row.answer };
  }
  return best.score >= config.chatKb.matchThreshold ? best.answer : undefined;
}
