import { db } from "./index.js";

// Stage 0 of teaching Mas ADE to answer non-coding questions from its own
// accumulated store (see ARCHITECTURE.md "Chat knowledge base"): every
// free-form chat Q&A is recorded here. Retrieval comes later — this table
// only gets written to for now. embedding is nullable: the row is saved
// immediately, the question vector is backfilled best-effort when a Gemini
// key is available.
db.exec(`
  CREATE TABLE IF NOT EXISTS interaction_kb (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT NOT NULL,
    kind TEXT NOT NULL,         -- 'chat_model' | 'chat_arithmetic' | ...
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    embedding BLOB,             -- question embedding; NULL until backfilled
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_interaction_kb_from ON interaction_kb(from_number);
`);

export interface InteractionRow {
  id: number;
  question: string;
  answer: string;
  kind: string;
  embedding: Float32Array;
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
        .prepare("INSERT INTO interaction_kb (from_number, kind, question, answer) VALUES (?, ?, ?, ?)")
        .run(fromNumber, kind, question, answer).lastInsertRowid
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

  // For the retrieval step (Stage 1) — only rows that actually have a vector.
  embeddedForNumber(fromNumber: string): InteractionRow[] {
    const rows = db
      .prepare(
        "SELECT id, question, answer, kind, embedding FROM interaction_kb WHERE from_number = ? AND embedding IS NOT NULL"
      )
      .all(fromNumber) as { id: number; question: string; answer: string; kind: string; embedding: Buffer }[];
    return rows.map((r) => ({ ...r, embedding: toFloat32Array(r.embedding) }));
  },
};
