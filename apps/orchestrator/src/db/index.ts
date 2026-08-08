import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    alias TEXT PRIMARY KEY,
    repo_url TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    auto_merge TEXT NOT NULL DEFAULT 'direct', -- 'direct' | 'pr'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_alias TEXT NOT NULL,
    from_number TEXT NOT NULL,
    instruction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed | cancelled
    result_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL, -- 'tool_use' | 'note' | 'error'
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_state (
    from_number TEXT PRIMARY KEY,
    active_project_alias TEXT,
    pending_action TEXT -- JSON blob for multi-step flows (e.g. awaiting repo URL)
  );
`);

export interface Project {
  alias: string;
  repo_url: string;
  default_branch: string;
  auto_merge: "direct" | "pr";
  created_at: string;
}

export const projectsRepo = {
  get(alias: string): Project | undefined {
    return db.prepare("SELECT * FROM projects WHERE alias = ?").get(alias) as
      | Project
      | undefined;
  },
  list(): Project[] {
    return db.prepare("SELECT * FROM projects ORDER BY alias").all() as Project[];
  },
  create(alias: string, repoUrl: string, defaultBranch = "main"): Project {
    db.prepare(
      "INSERT INTO projects (alias, repo_url, default_branch) VALUES (?, ?, ?)"
    ).run(alias, repoUrl, defaultBranch);
    return this.get(alias)!;
  },
};

export interface Task {
  id: string;
  project_alias: string;
  from_number: string;
  instruction: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  result_summary: string | null;
  created_at: string;
  finished_at: string | null;
}

export const tasksRepo = {
  create(id: string, projectAlias: string, fromNumber: string, instruction: string): void {
    db.prepare(
      "INSERT INTO tasks (id, project_alias, from_number, instruction) VALUES (?, ?, ?, ?)"
    ).run(id, projectAlias, fromNumber, instruction);
  },
  setStatus(id: string, status: Task["status"], resultSummary?: string): void {
    db.prepare(
      `UPDATE tasks SET status = ?, result_summary = COALESCE(?, result_summary),
       finished_at = CASE WHEN ? IN ('done','failed','cancelled') THEN datetime('now') ELSE finished_at END
       WHERE id = ?`
    ).run(status, resultSummary ?? null, status, id);
  },
  get(id: string): Task | undefined {
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  },
  latestRunningForProject(projectAlias: string): Task | undefined {
    return db
      .prepare(
        "SELECT * FROM tasks WHERE project_alias = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1"
      )
      .get(projectAlias) as Task | undefined;
  },
  recentForNumber(fromNumber: string, limit = 5): Task[] {
    return db
      .prepare(
        "SELECT * FROM tasks WHERE from_number = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(fromNumber, limit) as Task[];
  },
};

export const auditLog = {
  add(taskId: string, kind: "tool_use" | "note" | "error", detail: string): void {
    db.prepare(
      "INSERT INTO audit_log (task_id, kind, detail) VALUES (?, ?, ?)"
    ).run(taskId, kind, detail);
  },
};

export interface ConversationState {
  from_number: string;
  active_project_alias: string | null;
  pending_action: string | null;
}

export const conversationRepo = {
  get(fromNumber: string): ConversationState | undefined {
    return db
      .prepare("SELECT * FROM conversation_state WHERE from_number = ?")
      .get(fromNumber) as ConversationState | undefined;
  },
  setActiveProject(fromNumber: string, alias: string | null): void {
    db.prepare(
      `INSERT INTO conversation_state (from_number, active_project_alias) VALUES (?, ?)
       ON CONFLICT(from_number) DO UPDATE SET active_project_alias = excluded.active_project_alias`
    ).run(fromNumber, alias);
  },
  setPendingAction(fromNumber: string, pending: string | null): void {
    db.prepare(
      `INSERT INTO conversation_state (from_number, pending_action) VALUES (?, ?)
       ON CONFLICT(from_number) DO UPDATE SET pending_action = excluded.pending_action`
    ).run(fromNumber, pending);
  },
};
