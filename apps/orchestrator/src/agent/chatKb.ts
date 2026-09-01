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

// The reply-path lookup can't hang while a 429 retries — a miss just means
// "use the model", which is the fallback anyway.
const LOOKUP_EMBED_TIMEOUT_MS = 4000;
const BACKFILL_MAX_PER_RUN = 8;

// Write a chat Q&A into the knowledge base and attach its question vector.
// Fire-and-forget from the chat handler — a failure here must never touch the
// reply the user already got, so every step is guarded and the row is saved
// before the embedding is attempted. If the lookup already computed this
// question's vector (the common lookup-missed path), pass it as
// precomputedVector to skip a redundant embedding call.
export async function recordInteraction(
  params: {
    fromNumber: string;
    kind: InteractionKind;
    question: string;
    answer: string;
    precomputedVector?: Float32Array;
  },
  opts: ChatKbOpts = {}
): Promise<void> {
  if (!(opts.enabled ?? config.chatKb.enabled)) return;
  const { fromNumber, kind, question, answer, precomputedVector } = params;
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

  if (precomputedVector) {
    try {
      chatKbRepo.setEmbedding(id, precomputedVector);
    } catch {
      /* row stays NULL, backfill picks it up */
    }
    return;
  }

  const embedder = resolveEmbedder(opts);
  if (!embedder) return;
  try {
    // "similarity" (not "document") — the lookup embeds the incoming question
    // the same way, and this is symmetric question-to-question matching.
    const [vec] = await embedder.embed([question], "similarity", new AbortController().signal);
    if (vec) chatKbRepo.setEmbedding(id, vec);
  } catch {
    // Row stays saved with a NULL embedding; backfillNullEmbeddings picks it
    // up on a later lookup.
  }
}

export interface CacheLookupResult {
  // The stored answer to reuse, if a close-enough match was found.
  hit?: string;
  // The incoming question's vector, computed during the lookup — reuse it for
  // recording so a lookup-then-record costs one embedding call, not two.
  // Absent if the embedding failed.
  queryVector?: Float32Array;
}

// Stage 1: if this question is close enough to one already answered for this
// sender, return that stored answer — no model call. A bare {} (or a result
// with no `hit`) means "fall through to the model", which then records the
// fresh answer, reusing queryVector when present.
export async function lookupCachedAnswer(
  params: { fromNumber: string; question: string },
  opts: ChatKbOpts = {}
): Promise<CacheLookupResult> {
  if (!(opts.enabled ?? config.chatKb.enabled)) return {};
  const question = params.question.trim();
  if (!question) return {};

  const embedder = resolveEmbedder(opts);
  if (!embedder) return {};

  let queryVec: Float32Array | undefined;
  try {
    [queryVec] = await embedder.embed([question], "similarity", AbortSignal.timeout(LOOKUP_EMBED_TIMEOUT_MS));
  } catch {
    return {};
  }
  if (!queryVec) return {};

  const rows = chatKbRepo.embeddedForNumber(params.fromNumber).filter((r) => r.kind !== "chat_arithmetic");
  let best = { score: -1, answer: "" };
  for (const row of rows) {
    const score = cosineSimilarity(queryVec, row.embedding);
    if (score > best.score) best = { score, answer: row.answer };
  }

  // Repair any rows a past 429 left unembedded, in the background.
  void backfillNullEmbeddings(params.fromNumber, opts.embedder);

  return best.score >= config.chatKb.matchThreshold
    ? { hit: best.answer, queryVector: queryVec }
    : { queryVector: queryVec };
}

const backfillInFlight = new Set<string>();

// Re-embed rows that a past failure left with a NULL vector. Best-effort and
// capped; stops on the first error (likely another 429) and lets the next
// lookup try again.
export async function backfillNullEmbeddings(
  fromNumber: string,
  embedder?: EmbeddingProvider | null
): Promise<void> {
  if (backfillInFlight.has(fromNumber)) return;
  const emb = embedder === undefined ? buildEmbeddingProvider() : embedder ?? undefined;
  if (!emb) return;

  const pending = chatKbRepo.nullForNumber(fromNumber).slice(0, BACKFILL_MAX_PER_RUN);
  if (pending.length === 0) return;

  backfillInFlight.add(fromNumber);
  try {
    for (const row of pending) {
      try {
        const [vec] = await emb.embed([row.question], "similarity", new AbortController().signal);
        if (vec) chatKbRepo.setEmbedding(row.id, vec);
      } catch {
        break;
      }
    }
  } finally {
    backfillInFlight.delete(fromNumber);
  }
}
