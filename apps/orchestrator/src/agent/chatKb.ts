import { config } from "../config.js";
import { chatKbRepo, normalizeQuestion } from "../db/chatKb.js";
import { cosineSimilarity } from "./rag/index.js";
import { embedLocal } from "./localEmbedder.js";

export type InteractionKind = "chat_model" | "chat_arithmetic";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

// Questions/answers whose correct answer changes over time — never cache
// these, always let the model answer fresh. Over-flagging is fine: the cost
// is an extra model call, not a wrong answer.
const VOLATILE_QUESTION_RE =
  /\b(hari ini|harini|sekarang|saat ini|kini|terkini|terbaru|terupdate|ter-update|update terbaru|barusan|belakangan ini|akhir-akhir ini|minggu ini|bulan ini|tahun ini|besok|kemarin|lusa)\b|\b(harga|kurs|nilai tukar|cuaca|suhu|ramalan|skor|klasemen|jadwal (tayang|pertandingan|bola)|stok|ketersediaan|antrian)\b|\b(presiden|wakil presiden|menteri|gubernur|wali ?kota|bupati|ceo|direktur utama|ketua umum|juara bertahan|pemenang terakhir)\b|\b(versi (berapa|terbaru|terakhir)|rilis terbaru|latest version|current version)\b|\bberapa (umur|usia)\b/i;
const VOLATILE_ANSWER_RE =
  /\bper \d{1,2}\s+\p{L}+\s+\d{4}\b|\b(saat ini|hingga (saat ini|kini)|sampai (saat ini|sekarang)|per hari ini|sejauh ini|as of)\b|(Rp\s?\d|USD\s?\d|\$\s?\d|\b\d+([.,]\d+)?\s?(ribu|juta|miliar|triliun|persen|%))|\b20(2[4-9]|[3-9]\d)\b/iu;

export function isVolatile(question: string, answer: string): boolean {
  return VOLATILE_QUESTION_RE.test(question) || VOLATILE_ANSWER_RE.test(answer);
}

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

  // A time-sensitive answer is still logged (stats, future distillation) but
  // as 'chat_volatile', which no lookup ever matches.
  const storedKind = kind === "chat_model" && isVolatile(question, answer) ? "chat_volatile" : kind;

  let id: number;
  try {
    id = chatKbRepo.insert(fromNumber, storedKind, question, answer);
  } catch {
    return;
  }

  if (storedKind !== "chat_model" || !config.chatKb.semanticFallback) return;

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
  // The stored answer to reuse, if a match was found. Carries a short age
  // note when the stored row is more than a couple of weeks old.
  hit?: string;
  // Only set on the semantic path: the question's vector, so the handler can
  // hand it to recordInteraction instead of embedding twice.
  queryVector?: Float32Array;
}

// SQLite datetime('now') -> ms since epoch (it's UTC, no zone suffix).
function parseSqliteTs(ts: string): number {
  return Date.parse(ts.replace(" ", "T") + "Z");
}

// A parenthetical appended to an older cached answer so the user knows it
// might have moved on. Nothing for anything recorded in the last ~2 weeks.
function ageNote(createdAt: string): string {
  const days = (Date.now() - parseSqliteTs(createdAt)) / 86_400_000;
  if (!Number.isFinite(days) || days < 14) return "";
  const when =
    days < 45 ? "beberapa minggu lalu" : days < 75 ? "sekitar sebulan lalu" : `sekitar ${Math.round(days / 30)} bulan lalu`;
  return `\n\n(ini jawaban tersimpan dari ${when}, bisa aja udah berubah)`;
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

  const candidates = chatKbRepo.candidatesForLocalMatch(params.fromNumber, config.chatKb.maxAgeDays);

  const exact = candidates.find((c) => c.normQuestion === norm);
  if (exact) return { hit: exact.answer + ageNote(exact.createdAt) };

  const qTokens = tokenSet(norm);
  let best = { score: 0, answer: "", createdAt: "" };
  for (const c of candidates) {
    const score = jaccard(qTokens, tokenSet(c.normQuestion));
    if (score > best.score) best = { score, answer: c.answer, createdAt: c.createdAt };
  }
  if (best.score >= config.chatKb.localMatchThreshold) return { hit: best.answer + ageNote(best.createdAt) };

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

  const rows = chatKbRepo.embeddedForNumber(fromNumber, config.chatKb.maxAgeDays);
  let best = { score: -1, answer: "", createdAt: "" };
  for (const row of rows) {
    const score = cosineSimilarity(queryVec, row.embedding);
    if (score > best.score) best = { score, answer: row.answer, createdAt: row.createdAt };
  }

  void backfillNullEmbeddings(fromNumber, opts);

  return best.score >= config.chatKb.matchThreshold
    ? { hit: best.answer + ageNote(best.createdAt), queryVector: queryVec }
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

// --- "that cached answer is wrong / out of date" correction -----------

// Which cache-served question a sender might be about to correct. In-memory
// and short-lived: a correction lands in the very next message or not at all.
const lastKbHit = new Map<string, { question: string; at: number }>();
const CORRECTION_WINDOW_MS = 6 * 60 * 1000;

// Start-anchored so a normal follow-up question doesn't trip it, but a
// trailing clause ("salah dong, yang bener X") is fine.
const CORRECTION_RE =
  /^\s*(salah|itu salah|bukan[,. ]*(itu|tuh)?[,.]|keliru|kurang tepat|(nggak|gak|ga) (tepat|bener|benar|update|akurat)|(itu )?(udah|udh) (lama|basi|kadaluwarsa|kadaluarsa|outdated)|yang (baru|terbaru|update)|update dong|outdated|info(nya)? (lama|basi))\b/i;

// The sender giving the right answer outright.
const SET_ANSWER_RE =
  /\b(jawaban(?:nya)?|yang (?:bener|benar)(?:nya)?|harus(?:nya)?|seharusnya|mestinya)\s+(?:adalah\s+|itu\s+|harus(?:nya)?\s+|seharusnya\s+|mestinya\s+|yaitu\s+|:\s*)?(.{2,})$/i;

// Correction filler to peel off before deciding whether what's left is a
// useful hint or just more "that's wrong" noise.
const HINT_STRIP_RE =
  /^((dan|tapi|soalnya|kan|padahal|itu|udah|udh|masih|lagi|lama|basi|yang|baru|terbaru|update|outdated|kadaluwarsa|kadaluarsa)(\s+|[,.]+|$))+/i;

export interface KbCorrection {
  question: string; // the original question, to re-answer or overwrite
  setAnswer?: string; // sender supplied the answer -> store it directly, no model
  hint?: string; // sender added detail -> re-ask the model with this as context
}

export function noteKbHit(fromNumber: string, question: string): void {
  lastKbHit.set(fromNumber, { question, at: Date.now() });
}

export function clearKbHit(fromNumber: string): void {
  lastKbHit.delete(fromNumber);
}

// If `message` reacts to a just-served cached answer, drop the stale row and
// return how to fix it. undefined = not a correction.
export function consumeKbCorrection(fromNumber: string, message: string): KbCorrection | undefined {
  const pending = lastKbHit.get(fromNumber);
  if (!pending) return undefined;
  if (Date.now() - pending.at > CORRECTION_WINDOW_MS) {
    lastKbHit.delete(fromNumber);
    return undefined;
  }

  const set = message.match(SET_ANSWER_RE);
  const corr = message.match(CORRECTION_RE);
  if (!set && !corr) return undefined;

  lastKbHit.delete(fromNumber);
  chatKbRepo.deleteByNorm(fromNumber, normalizeQuestion(pending.question));

  if (set) return { question: pending.question, setAnswer: set[2].trim() };

  const rest = message
    .slice(corr![0].length)
    .replace(/\b(dong|sih|tuh|deh|kok|ya)\b/gi, " ")
    .replace(/^[\s,.;:—-]+/, "")
    .replace(HINT_STRIP_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return { question: pending.question, hint: rest.length >= 4 ? rest : undefined };
}
