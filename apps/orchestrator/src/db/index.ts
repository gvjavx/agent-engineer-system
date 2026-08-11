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
    repo_url TEXT NOT NULL, -- git remote URL, or an absolute local path when kind='local'
    default_branch TEXT NOT NULL DEFAULT 'main',
    auto_merge TEXT NOT NULL DEFAULT 'direct', -- 'direct' | 'pr'
    kind TEXT NOT NULL DEFAULT 'git', -- 'git' | 'local'
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
    pending_action TEXT, -- JSON blob for multi-step flows (e.g. awaiting repo URL)
    preferred_provider TEXT, -- AI provider to try first, set via "pakai model semua <nama>"
    department_models TEXT -- JSON {department: providerName}, set via "pakai model <departemen> <nama>"
  );

  -- Single row (id=1): the one Figma account linked via "hubungkan figma".
  -- Single-tenant by design, same assumption as ALLOWED_SENDERS.
  CREATE TABLE IF NOT EXISTS figma_oauth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

// Idempotent migrations for DBs created before these columns existed.
for (const migration of [
  "ALTER TABLE conversation_state ADD COLUMN preferred_provider TEXT",
  "ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'git'",
  "ALTER TABLE conversation_state ADD COLUMN department_models TEXT",
]) {
  try {
    db.exec(migration);
  } catch {
    // already applied
  }
}

export interface Project {
  alias: string;
  repo_url: string;
  default_branch: string;
  auto_merge: "direct" | "pr";
  kind: "git" | "local";
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
      "INSERT INTO projects (alias, repo_url, default_branch, kind) VALUES (?, ?, ?, 'git')"
    ).run(alias, repoUrl, defaultBranch);
    return this.get(alias)!;
  },
  createLocal(alias: string, localPath: string): Project {
    db.prepare(
      "INSERT INTO projects (alias, repo_url, default_branch, kind) VALUES (?, ?, '', 'local')"
    ).run(alias, localPath);
    return this.get(alias)!;
  },
  // Only unregisters the project — never touches anything on disk. For
  // kind='local' projects repo_url IS the user's real folder on the server
  // (see git/repo.ts), so deleting the row must never cascade into deleting
  // files; for kind='git' the local clone under workspaces/<alias> is simply
  // left behind (harmless, re-clonable, and not this method's job to clean up).
  delete(alias: string): void {
    db.prepare("DELETE FROM projects WHERE alias = ?").run(alias);
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
  // Used by the "status" command to show which pipeline phase is currently running.
  latestNote(taskId: string): string | undefined {
    const row = db
      .prepare("SELECT detail FROM audit_log WHERE task_id = ? AND kind = 'note' ORDER BY id DESC LIMIT 1")
      .get(taskId) as { detail: string } | undefined;
    return row?.detail;
  },
};

export interface ConversationState {
  from_number: string;
  active_project_alias: string | null;
  pending_action: string | null;
  preferred_provider: string | null;
  department_models: string | null;
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
  // Called when a project is deleted — clears it as the active project for
  // every conversation that had it selected (not just the one that deleted
  // it), so nobody's left pointed at an alias that no longer exists.
  clearActiveProjectEverywhere(alias: string): void {
    db.prepare("UPDATE conversation_state SET active_project_alias = NULL WHERE active_project_alias = ?").run(alias);
  },
  setPendingAction(fromNumber: string, pending: string | null): void {
    db.prepare(
      `INSERT INTO conversation_state (from_number, pending_action) VALUES (?, ?)
       ON CONFLICT(from_number) DO UPDATE SET pending_action = excluded.pending_action`
    ).run(fromNumber, pending);
  },
  setPreferredProvider(fromNumber: string, providerName: string | null): void {
    db.prepare(
      `INSERT INTO conversation_state (from_number, preferred_provider) VALUES (?, ?)
       ON CONFLICT(from_number) DO UPDATE SET preferred_provider = excluded.preferred_provider`
    ).run(fromNumber, providerName);
  },
  getDepartmentModels(fromNumber: string): Record<string, string> {
    const raw = this.get(fromNumber)?.department_models;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  },
  getDepartmentModel(fromNumber: string, department: string): string | undefined {
    return this.getDepartmentModels(fromNumber)[department];
  },
  setDepartmentModel(fromNumber: string, department: string, providerName: string): void {
    const current = this.getDepartmentModels(fromNumber);
    current[department] = providerName;
    db.prepare(
      `INSERT INTO conversation_state (from_number, department_models) VALUES (?, ?)
       ON CONFLICT(from_number) DO UPDATE SET department_models = excluded.department_models`
    ).run(fromNumber, JSON.stringify(current));
  },
};

export interface FigmaOAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO timestamp
}

export const figmaOAuthRepo = {
  get(): FigmaOAuthTokens | undefined {
    return db.prepare("SELECT access_token, refresh_token, expires_at FROM figma_oauth WHERE id = 1").get() as
      | FigmaOAuthTokens
      | undefined;
  },
  save(tokens: FigmaOAuthTokens): void {
    db.prepare(
      `INSERT INTO figma_oauth (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`
    ).run(tokens.access_token, tokens.refresh_token, tokens.expires_at);
  },
  clear(): void {
    db.prepare("DELETE FROM figma_oauth WHERE id = 1").run();
  },
};
