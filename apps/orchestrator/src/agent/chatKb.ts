import { config } from "../config.js";
import { chatKbRepo, normalizeQuestion } from "../db/chatKb.js";
import { buildEmbeddingProvider, cosineSimilarity, type EmbeddingProvider } from "./rag/index.js";

export type InteractionKind = "chat_model" | "chat_arithmetic";

export interface ChatKbOpts {
  // Test seams. enabled overrides the config flag; embedder null = "no
  // embedder", undefined = build the real one (semantic fallback only).
  enabled?: boolean;
  embedder?: EmbeddingProvider | null;
}
export type RecordInteractionOpts = ChatKbOpts;

function tokenSet(norm: string): Set<string> {
  return new Set(norm.split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Record a chat Q&A. Fire-and-forget from the handler — a failure here must
// never touch the reply the user already got. No embedding by default: the
// repeat match (lookupCachedAnswer) is local. `precomputedVector` is only
// used by the opt-in semantic fallback.
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

  if (kind === "chat_arithmetic" || !config.chatKb.semanticFallback) return;

  if (precomputedVector) {
    try {
      chatKbRepo.setEmbedding(id, precomputedVector);
    } catch {
      /* stays NULL, backfill handles it */
    }
    return;
  }
  const embedder = opts.embedder === undefined ? buildEmbeddingProvider() : opts.embedder ?? undefined;
  if (!embedder) return;
  try {
    const [vec] = await embedder.embed([question], "similarity", new AbortController().signal);
    if (vec) chatKbRepo.setEmbedding(id, vec);
  } catch {
    /* stays NULL, backfillNullEmbeddings retries on a later lookup */
  }
}

export interface CacheLookupResult {
  // The stored answer to reuse, if a match was found.
  hit?: string;
  // Only set on the semantic-fallback path: the question's vector, so the
  // handler can hand it to recordInteraction instead of embedding twice.
  queryVector?: Float32Array;
}

// If this question is a repeat of one already answered for this sender,
// return that stored answer — no model call. The match is LOCAL: exact after
// normalization, or near-identical token sets. The embedding path only runs
// when CHAT_KB_SEMANTIC is on and the local match missed.
export async function lookupCachedAnswer(
  params: { fromNumber: string; question: string },
  opts: ChatKbOpts = {}
): Promise<CacheLookupResult> {
  if (!(opts.enabled ?? config.chatKb.enabled)) return {};
  const norm = normalizeQuestion(params.question);
  if (!norm) return {};

  const candidates = chatKbRepo.candidatesForLocalMatch(params.fromNumber);

  const exact = candidates.find((c) => c.normQuestion === norm);
  if (exact) return { hit: exact.answer };

  const qTokens = tokenSet(norm);
  let best = { score: 0, answer: "" };
  for (const c of candidates) {
    const score = jaccard(qTokens, tokenSet(c.normQuestion));
    if (score > best.score) best = { score, answer: c.answer };
  }
  if (best.score >= config.chatKb.localMatchThreshold) return { hit: best.answer };

  if (config.chatKb.semanticFallback) {
    return semanticLookup(params.fromNumber, params.question.trim(), opts);
  }
  return {};
}

// --- opt-in semantic (embedding) fallback ------------------------------

const LOOKUP_EMBED_TIMEOUT_MS = 4000;

async function semanticLookup(
  fromNumber: string,
  question: string,
  opts: ChatKbOpts
): Promise<CacheLookupResult> {
  const embedder = opts.embedder === undefined ? buildEmbeddingProvider() : opts.embedder ?? undefined;
  if (!embedder || !question) return {};

  let queryVec: Float32Array | undefined;
  try {
    [queryVec] = await embedder.embed([question], "similarity", AbortSignal.timeout(LOOKUP_EMBED_TIMEOUT_MS));
  } catch {
    return {};
  }
  if (!queryVec) return {};

  const rows = chatKbRepo.embeddedForNumber(fromNumber).filter((r) => r.kind !== "chat_arithmetic");
  let best = { score: -1, answer: "" };
  for (const row of rows) {
    const score = cosineSimilarity(queryVec, row.embedding);
    if (score > best.score) best = { score, answer: row.answer };
  }

  void backfillNullEmbeddings(fromNumber, opts.embedder);

  return best.score >= config.chatKb.matchThreshold
    ? { hit: best.answer, queryVector: queryVec }
    : { queryVector: queryVec };
}

const BACKFILL_MAX_PER_RUN = 8;
const backfillInFlight = new Set<string>();

export async function backfillNullEmbeddings(
  fromNumber: string,
  embedder?: EmbeddingProvider | null
): Promise<void> {
  if (!config.chatKb.semanticFallback || backfillInFlight.has(fromNumber)) return;
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
