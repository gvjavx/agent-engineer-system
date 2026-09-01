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

// Reduce a question to what two askings of "the same thing" have in common:
// case, punctuation, diacritics and repeated whitespace all removed.
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// One-time backfill of norm_question for any pre-migration rows.
{
  const stale = db
    .prepare("SELECT id, question FROM interaction_kb WHERE norm_question IS NULL")
    .all() as { id: number; question: string }[];
  if (stale.length > 0) {
    const upd = db.prepare("UPDATE interaction_kb SET norm_question = ? WHERE id = ?");
    const tx = db.transaction(() => {
      for (const r of stale) upd.run(normalizeQuestion(r.question), r.id);
    });
    tx();
  }
}

export interface InteractionRow {
  id: number;
  question: string;
  answer: string;
  kind: string;
  embedding: Float32Array;
}

export interface LocalCandidate {
  answer: string;
  normQuestion: string;
}

function toBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function toFloat32Array(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
}

export const chatKbRepo = {
  insert(fromNumber: string, kind: string, question: string, answer: string): number {
    return Number(
      db
        .prepare(
          "INSERT INTO interaction_kb (from_number, kind, question, norm_question, answer) VALUES (?, ?, ?, ?, ?)"
        )
        .run(fromNumber, kind, question, normalizeQuestion(question), answer).lastInsertRowid
    );
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

  // The local repeat match works off these — no embedding involved. Newest
  // first so an exact match picks the most recent answer.
  candidatesForLocalMatch(fromNumber: string): LocalCandidate[] {
    return db
      .prepare(
        "SELECT answer, norm_question AS normQuestion FROM interaction_kb WHERE from_number = ? AND kind = 'chat_model' AND norm_question IS NOT NULL AND norm_question != '' ORDER BY id DESC"
      )
      .all(fromNumber) as LocalCandidate[];
  },

  // For the opt-in semantic fallback only.
  embeddedForNumber(fromNumber: string): InteractionRow[] {
    const rows = db
      .prepare(
        "SELECT id, question, answer, kind, embedding FROM interaction_kb WHERE from_number = ? AND embedding IS NOT NULL"
      )
      .all(fromNumber) as { id: number; question: string; answer: string; kind: string; embedding: Buffer }[];
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
