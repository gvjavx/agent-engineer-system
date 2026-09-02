import { db } from "./index.js";

// The chat knowledge base (see ARCHITECTURE.md "Chat knowledge base"): every
// free-form chat Q&A is recorded here so a repeat of the same question can be
// answered from the store instead of the model.
//
// norm_question is the question reduced to a canonical form (lowercase, no
// punctuation/diacritics, single spaces) — the repeat match is done against
// this locally, no embedding call. `embedding` is only populated when the
// opt-in semantic fallback is enabled.
db.exec(`
  CREATE TABLE IF NOT EXISTS interaction_kb (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT NOT NULL,
    kind TEXT NOT NULL,         -- 'chat_model' | 'chat_arithmetic' | ...
    question TEXT NOT NULL,
    norm_question TEXT,
    answer TEXT NOT NULL,
    embedding BLOB,             -- only set when the semantic fallback is on
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_interaction_kb_from ON interaction_kb(from_number);
`);

// Idempotent migration for DBs created before norm_question existed — must
// run before the index below, which references the column.
try {
  db.exec("ALTER TABLE interaction_kb ADD COLUMN norm_question TEXT");
} catch {
  // already there
}

db.exec("CREATE INDEX IF NOT EXISTS idx_interaction_kb_norm ON interaction_kb(from_number, norm_question)");

// One counter per (day, reply source) so the chat-KB layer's payoff is a
// single visible number: what share of chat replies skipped the model.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_stats (
    day TEXT NOT NULL,     -- YYYY-MM-DD, WIB
    source TEXT NOT NULL,  -- 'model' | 'kb' | 'arithmetic'
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, source)
  );
`);

// Chat fillers: safe to drop, never change what's being asked.
const FILLER = new Set(
  "sih ya yah dong deh nih tuh kan kok lah pun aja saja yang tolong coba pls plis please min gan bro sis kak bang mas mbak dulu itu ini nya"
    .split(" ")
);

// Surface variants that mean the same thing in a question. Grow this as real
// misses show up — keep it conservative, a wrong collapse serves a wrong answer.
const SYNONYM: Record<string, string> = {
  apakah: "apa", apaan: "apa",
  kapankah: "kapan", kpn: "kapan",
  siapakah: "siapa", sapa: "siapa",
  dimana: "mana", kemana: "mana", kmana: "mana",
  bagaimana: "gimana", gmn: "gimana", gimanakah: "gimana", piye: "gimana",
  mengapa: "kenapa", ngapa: "kenapa", knp: "kenapa", kenapakah: "kenapa",
  berapakah: "berapa", brp: "berapa",
  gak: "tidak", nggak: "tidak", ga: "tidak", gk: "tidak", kagak: "tidak", enggak: "tidak", engga: "tidak",
  udah: "sudah", udh: "sudah", dah: "sudah", telah: "sudah",
  lu: "kamu", lo: "kamu", loe: "kamu", elo: "kamu", elu: "kamu", kau: "kamu", anda: "kamu", dirimu: "kamu",
  gue: "aku", gw: "aku", gua: "aku", saya: "aku",
  terhubung: "hubung", tersambung: "hubung", nyambung: "hubung", konek: "hubung", tehubung: "hubung",
  penemu: "temu", menemukan: "temu", nemuin: "temu", ditemukan: "temu", menemui: "temu", temukan: "temu",
  membuat: "buat", bikin: "buat", ngebikin: "buat", menciptakan: "buat", nyiptain: "buat", dibuat: "buat", dibikin: "buat", buatin: "buat",
  arti: "makna", maksud: "makna", pengertian: "makna", definisi: "makna",
};

const PHRASE: [RegExp, string][] = [
  [/\btanggal berapa\b/g, "kapan"],
  [/\bhari apa\b/g, "kapan"],
  [/\bdi mana\b/g, "mana"],
];

// Reduce a question to what two askings of "the same thing" have in common:
// case, punctuation, diacritics, filler words, and spelling/synonym variants
// all collapsed. Surface-level only — real paraphrase matching is a later step.
export function normalizeQuestion(q: string): string {
  let s = q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, rep] of PHRASE) s = s.replace(re, rep);
  return s
    .split(" ")
    .filter((t) => t && !FILLER.has(t))
    .map((t) => SYNONYM[t] ?? t)
    .join(" ");
}

// Re-derive norm_question on startup for any row where it's missing or no
// longer matches the current maps. Cheap: the table is small and only
// changed rows are written.
{
  const rows = db.prepare("SELECT id, question, norm_question FROM interaction_kb").all() as {
    id: number;
    question: string;
    norm_question: string | null;
  }[];
  const upd = db.prepare("UPDATE interaction_kb SET norm_question = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const r of rows) {
      const n = normalizeQuestion(r.question);
      if (n !== r.norm_question) upd.run(n, r.id);
    }
  });
  tx();
}

export interface InteractionRow {
  id: number;
  question: string;
  answer: string;
  kind: string;
  createdAt: string;
  embedding: Float32Array;
}

export interface LocalCandidate {
  answer: string;
  normQuestion: string;
  createdAt: string;
}

function toBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function toFloat32Array(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
}

// "created_at >= now - N days", or no bound when maxAgeDays <= 0.
function ageClause(maxAgeDays: number): { sql: string; params: string[] } {
  return maxAgeDays > 0
    ? { sql: " AND created_at >= datetime('now', ?)", params: [`-${Math.floor(maxAgeDays)} days`] }
    : { sql: "", params: [] };
}

export const chatKbRepo = {
  insert(fromNumber: string, kind: string, question: string, answer: string): number {
    const norm = normalizeQuestion(question);
    const tx = db.transaction(() => {
      // One live row per (sender, question) for the matchable kind — a
      // re-answer (e.g. after a TTL expiry) replaces the stale one instead of
      // piling up.
      if (kind === "chat_model") {
        db.prepare(
          "DELETE FROM interaction_kb WHERE from_number = ? AND norm_question = ? AND kind = 'chat_model'"
        ).run(fromNumber, norm);
      }
      return db
        .prepare(
          "INSERT INTO interaction_kb (from_number, kind, question, norm_question, answer) VALUES (?, ?, ?, ?, ?)"
        )
        .run(fromNumber, kind, question, norm, answer).lastInsertRowid;
    });
    return Number(tx());
  },

  setEmbedding(id: number, embedding: Float32Array): void {
    db.prepare("UPDATE interaction_kb SET embedding = ? WHERE id = ?").run(toBuffer(embedding), id);
  },

  countForNumber(fromNumber: string): number {
    return (
      db.prepare("SELECT COUNT(*) AS c FROM interaction_kb WHERE from_number = ?").get(fromNumber) as { c: number }
    ).c;
  },

  clearForNumber(fromNumber: string): void {
    db.prepare("DELETE FROM interaction_kb WHERE from_number = ?").run(fromNumber);
  },

  // Drop the matchable row(s) for one question — used when the user says a
  // served-from-cache answer is wrong or out of date.
  deleteByNorm(fromNumber: string, norm: string): void {
    db.prepare(
      "DELETE FROM interaction_kb WHERE from_number = ? AND norm_question = ? AND kind = 'chat_model'"
    ).run(fromNumber, norm);
  },

  // The local repeat match works off these — no embedding involved. Newest
  // first so an exact match picks the most recent answer. maxAgeDays > 0
  // drops rows older than the TTL so a stale answer expires instead of being
  // served forever.
  candidatesForLocalMatch(fromNumber: string, maxAgeDays = 0): LocalCandidate[] {
    const age = ageClause(maxAgeDays);
    return db
      .prepare(
        "SELECT answer, norm_question AS normQuestion, created_at AS createdAt FROM interaction_kb WHERE from_number = ? AND kind = 'chat_model' AND norm_question IS NOT NULL AND norm_question != ''" +
          age.sql +
          " ORDER BY id DESC"
      )
      .all(fromNumber, ...age.params) as LocalCandidate[];
  },

  // For the opt-in semantic fallback only. Same 'chat_model' + TTL restriction.
  embeddedForNumber(fromNumber: string, maxAgeDays = 0): InteractionRow[] {
    const age = ageClause(maxAgeDays);
    const rows = db
      .prepare(
        "SELECT id, question, answer, kind, created_at AS createdAt, embedding FROM interaction_kb WHERE from_number = ? AND kind = 'chat_model' AND embedding IS NOT NULL" +
          age.sql
      )
      .all(fromNumber, ...age.params) as {
      id: number;
      question: string;
      answer: string;
      kind: string;
      createdAt: string;
      embedding: Buffer;
    }[];
    return rows.map((r) => ({ ...r, embedding: toFloat32Array(r.embedding) }));
  },

  nullForNumber(fromNumber: string): { id: number; question: string }[] {
    return db
      .prepare(
        "SELECT id, question FROM interaction_kb WHERE from_number = ? AND embedding IS NULL AND kind != 'chat_arithmetic'"
      )
      .all(fromNumber) as { id: number; question: string }[];
  },
};

const wibDay = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(d); // YYYY-MM-DD

export interface ChatStatsSummary {
  model: number;
  kb: number;
  arithmetic: number;
  total: number;
  withoutAiPct: number;
}

export const kbStatsRepo = {
  bump(source: string, day: string = wibDay(new Date())): void {
    db.prepare(
      `INSERT INTO chat_stats (day, source, count) VALUES (?, ?, 1)
       ON CONFLICT(day, source) DO UPDATE SET count = count + 1`
    ).run(day, source);
  },

  summary(days = 30, now: Date = new Date()): ChatStatsSummary {
    const to = wibDay(now);
    const from = wibDay(new Date(now.getTime() - days * 86_400_000));
    const rows = db
      .prepare("SELECT source, SUM(count) AS c FROM chat_stats WHERE day >= ? AND day <= ? GROUP BY source")
      .all(from, to) as { source: string; c: number }[];
    const by: Record<string, number> = {};
    for (const r of rows) by[r.source] = r.c;
    const model = by.model ?? 0;
    const kb = by.kb ?? 0;
    const arithmetic = by.arithmetic ?? 0;
    const total = model + kb + arithmetic;
    return { model, kb, arithmetic, total, withoutAiPct: total ? Math.round(((kb + arithmetic) / total) * 100) : 0 };
  },
};
