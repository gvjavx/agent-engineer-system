import { config } from "../config.js";
import { chatKbRepo, normalizeQuestion } from "../db/chatKb.js";
import { cosineSimilarity } from "./rag/index.js";
import { embedLocal } from "./localEmbedder.js";

export type InteractionKind = "chat_model" | "chat_arithmetic";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface ChatKbOpts {
  // Test seams. `enabled` overrides the config flag; `embedFn` overrides the
  // local embedding model (semantic fallback only).
  enabled?: boolean;
  embedFn?: EmbedFn;
}
export type RecordInteractionOpts = ChatKbOpts;

function resolveEmbedFn(opts: ChatKbOpts): EmbedFn {
  return opts.embedFn ?? embedLocal;
}

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
// never touch the reply the user already got. No embedding unless the opt-in
// semantic fallback (CHAT_KB_SEMANTIC) is on; the default repeat match is
// pure local text. `precomputedVector` reuses the vector a lookup already
// computed for this same question.
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
  try {
    const [vec] = await resolveEmbedFn(opts)([question]);
    if (vec) chatKbRepo.setEmbedding(id, vec);
  } catch {
    /* stays NULL; backfillNullEmbeddings retries on a later lookup */
  }
}

export interface CacheLookupResult {
  // The stored answer to reuse, if a match was found.
  hit?: string;
  // Only set on the semantic path: the question's vector, so the handler can
  // hand it to recordInteraction instead of embedding twice.
  queryVector?: Float32Array;
}

// If this question is a repeat of one already answered for this sender,
// return that stored answer — no model call. The match is LOCAL: exact after
// normalization, or near-identical token sets. When CHAT_KB_SEMANTIC is on
// and that misses, a local sentence-embedding model catches deeper
// paraphrases (still no API).
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

// --- opt-in semantic (local embedding) fallback -----------------------

// Generous: covers the model's cold-start on the first lookup after a
// restart. A wedged model past this just means "miss -> use the model".
const SEMANTIC_TIMEOUT_MS = 12_000;

async function embedOne(embedFn: EmbedFn, text: string): Promise<Float32Array | undefined> {
  try {
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("embed timeout")), SEMANTIC_TIMEOUT_MS));
    const [vec] = await Promise.race([embedFn([text]), timeout]);
    return vec;
  } catch {
    return undefined;
  }
}

export async function semanticLookup(
  fromNumber: string,
  question: string,
  opts: ChatKbOpts = {}
): Promise<CacheLookupResult> {
  if (!question) return {};
  const embedFn = resolveEmbedFn(opts);

  const queryVec = await embedOne(embedFn, question);
  if (!queryVec) return {};

  const rows = chatKbRepo.embeddedForNumber(fromNumber).filter((r) => r.kind !== "chat_arithmetic");
  let best = { score: -1, answer: "" };
  for (const row of rows) {
    const score = cosineSimilarity(queryVec, row.embedding);
    if (score > best.score) best = { score, answer: row.answer };
  }

  void backfillNullEmbeddings(fromNumber, opts);

  return best.score >= config.chatKb.matchThreshold
    ? { hit: best.answer, queryVector: queryVec }
    : { queryVector: queryVec };
}

const BACKFILL_MAX_PER_RUN = 12;
const backfillInFlight = new Set<string>();

// Embed rows recorded while the model wasn't ready yet (first startup, mid
// download). Best-effort, capped.
export async function backfillNullEmbeddings(fromNumber: string, opts: ChatKbOpts = {}): Promise<void> {
  if (!config.chatKb.semanticFallback || backfillInFlight.has(fromNumber)) return;
  const pending = chatKbRepo.nullForNumber(fromNumber).slice(0, BACKFILL_MAX_PER_RUN);
  if (pending.length === 0) return;

  const embedFn = resolveEmbedFn(opts);
  backfillInFlight.add(fromNumber);
  try {
    for (const row of pending) {
      const vec = await embedOne(embedFn, row.question);
      if (!vec) break;
      chatKbRepo.setEmbedding(row.id, vec);
    }
  } finally {
    backfillInFlight.delete(fromNumber);
  }
}
