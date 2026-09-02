import { db } from "./index.js";

// Kept out of db/index.ts's schema block since this is one self-contained
// feature (code retrieval for the agent loop) — nothing else reads these
// tables, and importing this module is what creates them.
db.exec(`
  CREATE TABLE IF NOT EXISTS code_files (
    project_alias TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    PRIMARY KEY (project_alias, file_path)
  );

  CREATE TABLE IF NOT EXISTS code_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_alias TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL -- Float32Array bytes
  );
  CREATE INDEX IF NOT EXISTS idx_code_chunks_alias ON code_chunks(project_alias);

  CREATE TABLE IF NOT EXISTS code_index_meta (
    project_alias TEXT PRIMARY KEY,
    head_commit TEXT, -- null for kind='local' folders (no git)
    embed_model TEXT NOT NULL,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export interface StoredChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding: Float32Array;
}

export interface RetrievalRow {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding: Float32Array;
}

// Same as RetrievalRow but tagged with which project it came from — for the
// cross-repo retrieval path, where the model must know a snippet isn't from
// the repo it's working in.
export interface CrossRepoRow extends RetrievalRow {
  projectAlias: string;
}

export interface IndexMeta {
  headCommit: string | null;
  embedModel: string;
}

// Swappable so agent/rag tests can hand indexProject/retrieveCodeContext an
// in-memory store instead of hitting the real sqlite file.
export interface RagStore {
  fileHashes(alias: string): Map<string, string>;
  replaceFile(alias: string, filePath: string, fileHash: string, chunks: StoredChunk[]): void;
  deleteFile(alias: string, filePath: string): void;
  deleteProject(alias: string): void;
  allForRetrieval(alias: string): RetrievalRow[];
  // Every chunk from projects OTHER than `excludeAlias`, restricted to
  // projects whose index was built with `embedModel` so the vectors are
  // comparable. Only queried when RAG_CROSS_REPO is on.
  crossRepoChunks(excludeAlias: string, embedModel: string): CrossRepoRow[];
  getMeta(alias: string): IndexMeta | undefined;
  setMeta(alias: string, headCommit: string | null, embedModel: string): void;
}

function toBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function toFloat32Array(buf: Buffer): Float32Array {
  // Copy first — better-sqlite3 can hand back a Buffer that's a view into a
  // larger arena, with a byteOffset that isn't 4-byte aligned, which a direct
  // Float32Array view would reject.
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
}

export const ragRepo: RagStore = {
  fileHashes(alias) {
    const rows = db
      .prepare("SELECT file_path, file_hash FROM code_files WHERE project_alias = ?")
      .all(alias) as { file_path: string; file_hash: string }[];
    return new Map(rows.map((r) => [r.file_path, r.file_hash]));
  },

  replaceFile(alias, filePath, fileHash, chunks) {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM code_chunks WHERE project_alias = ? AND file_path = ?").run(alias, filePath);
      const insChunk = db.prepare(
        "INSERT INTO code_chunks (project_alias, file_path, start_line, end_line, content, embedding) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const c of chunks) {
        insChunk.run(alias, filePath, c.startLine, c.endLine, c.content, toBuffer(c.embedding));
      }
      db.prepare(
        `INSERT INTO code_files (project_alias, file_path, file_hash) VALUES (?, ?, ?)
         ON CONFLICT(project_alias, file_path) DO UPDATE SET file_hash = excluded.file_hash`
      ).run(alias, filePath, fileHash);
    });
    tx();
  },

  deleteFile(alias, filePath) {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM code_chunks WHERE project_alias = ? AND file_path = ?").run(alias, filePath);
      db.prepare("DELETE FROM code_files WHERE project_alias = ? AND file_path = ?").run(alias, filePath);
    });
    tx();
  },

  deleteProject(alias) {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM code_chunks WHERE project_alias = ?").run(alias);
      db.prepare("DELETE FROM code_files WHERE project_alias = ?").run(alias);
      db.prepare("DELETE FROM code_index_meta WHERE project_alias = ?").run(alias);
    });
    tx();
  },

  allForRetrieval(alias) {
    const rows = db
      .prepare("SELECT file_path, start_line, end_line, content, embedding FROM code_chunks WHERE project_alias = ?")
      .all(alias) as {
      file_path: string;
      start_line: number;
      end_line: number;
      content: string;
      embedding: Buffer;
    }[];
    return rows.map((r) => ({
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      embedding: toFloat32Array(r.embedding),
    }));
  },

  crossRepoChunks(excludeAlias, embedModel) {
    const rows = db
      .prepare(
        `SELECT c.project_alias, c.file_path, c.start_line, c.end_line, c.content, c.embedding
         FROM code_chunks c
         JOIN code_index_meta m ON m.project_alias = c.project_alias
         WHERE c.project_alias != ? AND m.embed_model = ?`
      )
      .all(excludeAlias, embedModel) as {
      project_alias: string;
      file_path: string;
      start_line: number;
      end_line: number;
      content: string;
      embedding: Buffer;
    }[];
    return rows.map((r) => ({
      projectAlias: r.project_alias,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      embedding: toFloat32Array(r.embedding),
    }));
  },

  getMeta(alias) {
    const row = db
      .prepare("SELECT head_commit, embed_model FROM code_index_meta WHERE project_alias = ?")
      .get(alias) as { head_commit: string | null; embed_model: string } | undefined;
    return row ? { headCommit: row.head_commit, embedModel: row.embed_model } : undefined;
  },

  setMeta(alias, headCommit, embedModel) {
    db.prepare(
      `INSERT INTO code_index_meta (project_alias, head_commit, embed_model, indexed_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(project_alias) DO UPDATE SET
         head_commit = excluded.head_commit,
         embed_model = excluded.embed_model,
         indexed_at = excluded.indexed_at`
    ).run(alias, headCommit, embedModel);
  },
};
