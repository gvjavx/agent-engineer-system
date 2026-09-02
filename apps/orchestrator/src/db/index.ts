import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// Under `node --test` (each test file is its own subprocess) use a private
// in-memory DB, so tests never touch — or accumulate rows in — the real
// sqlite file. DB_PATH=:memory: forces the same for a one-off script.
const dbPath = process.env.NODE_TEST_CONTEXT ? ":memory:" : config.dbPath;
if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
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
    finished_at TEXT,
    -- Everything needed to re-run this task from scratch after a server
    -- restart (queue/taskQueue.ts is in-memory and dies with the process).
    -- phases_json is the JSON PhaseSpec[] the pipeline was given; checkpoints
    -- whether per-phase review was on; resume_count how many times a restart
    -- has already re-run it, so a task that keeps dying gets abandoned
    -- instead of looping forever.
    phases_json TEXT,
    checkpoints INTEGER NOT NULL DEFAULT 0,
    resume_count INTEGER NOT NULL DEFAULT 0
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
    department_models TEXT, -- JSON {department: providerName}, set via "pakai model <departemen> <nama>"
    -- JSON blob for the last action that failed and can be retried with "coba
    -- lagi" (e.g. a repo clone that failed) — not a pending_action, since
    -- unlike a wizard step this never intercepts the next message on its own;
    -- it only fires on an explicit retry phrase. Cleared on success.
    last_failed_action TEXT
  );

  -- Single row (id=1): the one Figma account linked via "hubungkan figma".
  -- Single-tenant by design, same assumption as ALLOWED_SENDERS.
  CREATE TABLE IF NOT EXISTS figma_oauth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- Figma OAuth app credentials set via the "hubungkan figma" chat wizard —
  -- lets that first-time setup happen without editing .env. Same single-row
  -- shape as figma_oauth above; agent/mcp/figmaAuth.ts reads this first and
  -- falls back to the env-based config.figma if this is empty.
  CREATE TABLE IF NOT EXISTS figma_app_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    client_id TEXT NOT NULL,
    client_secret TEXT,
    redirect_uri TEXT NOT NULL
  );

  -- Facts learned about a user during casual chat (see agent/chatAssistant.ts),
  -- kept across sessions so the bot doesn't start from zero every conversation.
  CREATE TABLE IF NOT EXISTS user_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT NOT NULL,
    fact TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_user_memory_from ON user_memory(from_number);

  -- Recent chat turns (only the casual-conversation path, not tasks/commands)
  -- kept for context, not a full transcript — see chatHistoryRepo.append's pruning.
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT NOT NULL,
    role TEXT NOT NULL, -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_history_from ON chat_history(from_number);

  -- Full conversation transcript (task instructions, checkpoints, commands,
  -- casual chat — everything), grouped by session_id. Unlike chat_history
  -- above (small rolling window, casual-chat only), this is never pruned —
  -- it's the actual "riwayat chat" record. See router/handler.ts's
  -- touchAndLogSession for how a session boundary gets decided.
  CREATE TABLE IF NOT EXISTS session_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_session_log_from ON session_log(from_number);
  CREATE INDEX IF NOT EXISTS idx_session_log_session ON session_log(session_id);

  -- Dedup guard for retried webhook deliveries (Meta's retry, or the
  -- gateway's own resend after a dropped response). Persisted, not a Map:
  -- a real transcript showed a stale retry of "halo" get reprocessed minutes
  -- later because an in-memory guard was wiped by a restart in between,
  -- reopening exactly the window it exists to cover. See inboundDedup.ts.
  CREATE TABLE IF NOT EXISTS processed_messages (
    wa_message_id TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL -- epoch ms
  );

  -- Recurring tasks from "jadwalkan <kapan>: <instruksi>". A once-a-minute
  -- runner (router/handler.ts's startScheduleRunner) fires the ones whose
  -- next_run_at has passed, re-classifies departments fresh, and pushes them
  -- through the normal pipeline. spec_json is the parsed ScheduleSpec
  -- (agent/schedule.ts); schedule is its human label for the list.
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    from_number TEXT NOT NULL,
    project_alias TEXT NOT NULL,
    instruction TEXT NOT NULL,
    schedule TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    next_run_at TEXT NOT NULL, -- ISO UTC
    last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next ON scheduled_tasks(next_run_at);
`);

// Idempotent migrations for DBs created before these columns existed.
for (const migration of [
  "ALTER TABLE conversation_state ADD COLUMN preferred_provider TEXT",
  "ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'git'",
  "ALTER TABLE conversation_state ADD COLUMN department_models TEXT",
  "ALTER TABLE conversation_state ADD COLUMN last_failed_action TEXT",
  "ALTER TABLE conversation_state ADD COLUMN current_session_id TEXT",
  "ALTER TABLE conversation_state ADD COLUMN last_message_at TEXT",
  "ALTER TABLE conversation_state ADD COLUMN session_ended_notified INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN phases_json TEXT",
  "ALTER TABLE tasks ADD COLUMN checkpoints INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0",
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
  // Registration always inserts 'main' as a placeholder (see create() above)
  // — git/repo.ts's ensureWorkspace detects the repo's actual default branch
  // off origin/HEAD after cloning and self-heals it here, since a repo whose
  // real default is e.g. "master" would otherwise fail every checkout forever.
  setDefaultBranch(alias: string, branch: string): void {
    db.prepare("UPDATE projects SET default_branch = ? WHERE alias = ?").run(branch, alias);
  },
  createLocal(alias: string, localPath: string): Project {
    db.prepare(
      "INSERT INTO projects (alias, repo_url, default_branch, kind) VALUES (?, ?, '', 'local')"
    ).run(alias, localPath);
    return this.get(alias)!;
  },
  // Only unregisters the project — never touches anything on disk itself.
  // For kind='local' projects repo_url IS the user's real folder on the
  // server, so deleting the row must never cascade into deleting files — the
  // caller (router/handler.ts) never calls git/repo.ts's removeWorkspace for
  // those. For kind='git', the caller does clean up the disposable clone
  // under workspaces/<alias> separately, since re-cloning fully recovers it.
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
  phases_json: string | null;
  checkpoints: number;
  resume_count: number;
}

export const tasksRepo = {
  create(
    id: string,
    projectAlias: string,
    fromNumber: string,
    instruction: string,
    phasesJson: string | null = null,
    checkpoints = false
  ): void {
    db.prepare(
      "INSERT INTO tasks (id, project_alias, from_number, instruction, phases_json, checkpoints) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, projectAlias, fromNumber, instruction, phasesJson, checkpoints ? 1 : 0);
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
  // Tasks still queued/running for a project, oldest first — the running one
  // (if any) is first. Used to tell a user how many tasks are ahead of theirs.
  pendingForProject(projectAlias: string): Task[] {
    return db
      .prepare(
        "SELECT * FROM tasks WHERE project_alias = ? AND status IN ('queued','running') ORDER BY created_at ASC"
      )
      .all(projectAlias) as Task[];
  },
  // Every task left mid-flight when the process last stopped. The in-memory
  // queue (queue/taskQueue.ts) that drives status transitions dies with the
  // process, so at startup these are exactly the tasks a resume needs to pick
  // back up (or abandon). Read-only — the caller decides each one's fate.
  interrupted(): Task[] {
    return db
      .prepare("SELECT * FROM tasks WHERE status IN ('queued','running') ORDER BY created_at ASC")
      .all() as Task[];
  },
  // Bump the restart counter and put the row back to 'queued' so it's ready
  // to be re-enqueued; the run body flips it to 'running' again itself.
  markResumed(id: string): void {
    db.prepare("UPDATE tasks SET status = 'queued', resume_count = resume_count + 1, finished_at = NULL WHERE id = ?").run(id);
  },
  // Rollup over the last `days` days for the "status" dashboard.
  stats(days = 7): {
    total: number;
    done: number;
    failed: number;
    cancelled: number;
    running: number;
    avgMinutes: number | null;
  } {
    const rows = db
      .prepare(
        `SELECT status, created_at, finished_at FROM tasks WHERE created_at >= datetime('now', ?)`
      )
      .all(`-${Math.max(1, Math.floor(days))} days`) as {
      status: Task["status"];
      created_at: string;
      finished_at: string | null;
    }[];

    const count = (s: Task["status"]) => rows.filter((r) => r.status === s).length;
    const durations = rows
      .filter((r) => r.status === "done" && r.finished_at)
      .map((r) => (Date.parse(r.finished_at as string) - Date.parse(r.created_at)) / 60000)
      .filter((m) => Number.isFinite(m) && m >= 0);
    const avgMinutes = durations.length
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null;

    return {
      total: rows.length,
      done: count("done"),
      failed: count("failed"),
      cancelled: count("cancelled"),
      running: count("running") + count("queued"),
      avgMinutes,
    };
  },
};

export interface ScheduledTask {
  id: string;
  from_number: string;
  project_alias: string;
  instruction: string;
  schedule: string;
  spec_json: string;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
}

export const scheduledTasksRepo = {
  create(
    id: string,
    fromNumber: string,
    projectAlias: string,
    instruction: string,
    schedule: string,
    specJson: string,
    nextRunIso: string
  ): void {
    db.prepare(
      `INSERT INTO scheduled_tasks (id, from_number, project_alias, instruction, schedule, spec_json, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, fromNumber, projectAlias, instruction, schedule, specJson, nextRunIso);
  },
  listForNumber(fromNumber: string): ScheduledTask[] {
    return db
      .prepare("SELECT * FROM scheduled_tasks WHERE from_number = ? ORDER BY created_at ASC")
      .all(fromNumber) as ScheduledTask[];
  },
  listForProject(projectAlias: string): ScheduledTask[] {
    return db
      .prepare("SELECT * FROM scheduled_tasks WHERE project_alias = ? ORDER BY created_at ASC")
      .all(projectAlias) as ScheduledTask[];
  },
  due(nowIso: string): ScheduledTask[] {
    return db
      .prepare("SELECT * FROM scheduled_tasks WHERE next_run_at <= ? ORDER BY next_run_at ASC")
      .all(nowIso) as ScheduledTask[];
  },
  markRan(id: string, nextRunIso: string): void {
    db.prepare("UPDATE scheduled_tasks SET last_run_at = datetime('now'), next_run_at = ? WHERE id = ?").run(
      nextRunIso,
      id
    );
  },
  delete(id: string): void {
    db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
  },
  deleteForProject(projectAlias: string): number {
    return db.prepare("DELETE FROM scheduled_tasks WHERE project_alias = ?").run(projectAlias).changes;
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
  last_failed_action: string | null;
  current_session_id: string | null;
  last_message_at: string | null;
  session_ended_notified: number;
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
  setLastFailedAction(fromNumber: string, action: string | null): void {
    db.prepare(
      `INSERT INTO conversation_state (from_number, last_failed_action) VALUES (?, ?)
       ON CONFLICT(from_number) DO UPDATE SET last_failed_action = excluded.last_failed_action`
    ).run(fromNumber, action);
  },
  // last_message_at is written as an app-level ISO string, never SQL
  // datetime('now') — it's compared against a JS-computed cutoff in
  // session/idleNotifier.ts's scanner, and this codebase already has both
  // timestamp conventions in play elsewhere; mixing them here would silently
  // break that comparison.
  touchSession(fromNumber: string, sessionId: string, isNewSession: boolean): void {
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO conversation_state (from_number, current_session_id, last_message_at, session_ended_notified)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(from_number) DO UPDATE SET
         current_session_id = excluded.current_session_id,
         last_message_at = excluded.last_message_at,
         session_ended_notified = CASE WHEN ? THEN 0 ELSE session_ended_notified END`
    ).run(fromNumber, sessionId, nowIso, isNewSession ? 1 : 0);
  },
  // Guarded by sessionId — the idle scanner reads a batch of idle rows, then
  // awaits a network send per row before marking notified; if the user sends
  // a real message in that gap, touchSession rotates current_session_id and
  // this guard keeps the scanner from wrongly marking the brand-new session
  // as already-notified.
  markSessionNotified(fromNumber: string, sessionId: string): void {
    db.prepare(
      "UPDATE conversation_state SET session_ended_notified = 1 WHERE from_number = ? AND current_session_id = ?"
    ).run(fromNumber, sessionId);
  },
  listIdleUnnotifiedSessions(cutoffIso: string): ConversationState[] {
    return db
      .prepare(
        "SELECT * FROM conversation_state WHERE current_session_id IS NOT NULL AND session_ended_notified = 0 AND last_message_at < ?"
      )
      .all(cutoffIso) as ConversationState[];
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

export interface FigmaAppConfig {
  client_id: string;
  client_secret: string | null;
  redirect_uri: string;
}

export const figmaAppConfigRepo = {
  get(): FigmaAppConfig | undefined {
    return db.prepare("SELECT client_id, client_secret, redirect_uri FROM figma_app_config WHERE id = 1").get() as
      | FigmaAppConfig
      | undefined;
  },
  save(cfg: { clientId: string; clientSecret?: string; redirectUri: string }): void {
    db.prepare(
      `INSERT INTO figma_app_config (id, client_id, client_secret, redirect_uri) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, client_secret = excluded.client_secret, redirect_uri = excluded.redirect_uri`
    ).run(cfg.clientId, cfg.clientSecret ?? null, cfg.redirectUri);
  },
  clear(): void {
    db.prepare("DELETE FROM figma_app_config WHERE id = 1").run();
  },
};

export const memoryRepo = {
  list(fromNumber: string): string[] {
    const rows = db
      .prepare("SELECT fact FROM user_memory WHERE from_number = ? ORDER BY created_at ASC")
      .all(fromNumber) as { fact: string }[];
    return rows.map((r) => r.fact);
  },
  add(fromNumber: string, fact: string): void {
    db.prepare("INSERT INTO user_memory (from_number, fact) VALUES (?, ?)").run(fromNumber, fact);
  },
  clear(fromNumber: string): void {
    db.prepare("DELETE FROM user_memory WHERE from_number = ?").run(fromNumber);
  },
};

// How many past chat turns to keep per sender — bounds the table without
// needing a separate cleanup job; old turns are dropped as new ones come in.
const CHAT_HISTORY_KEEP_PER_USER = 40;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export const chatHistoryRepo = {
  // Oldest-first, as a real Provider expects a conversation to read.
  recent(fromNumber: string, limit: number): ChatTurn[] {
    const rows = db
      .prepare("SELECT role, content FROM chat_history WHERE from_number = ? ORDER BY created_at DESC LIMIT ?")
      .all(fromNumber, limit) as ChatTurn[];
    return rows.reverse();
  },
  append(fromNumber: string, role: "user" | "assistant", content: string): void {
    db.prepare("INSERT INTO chat_history (from_number, role, content) VALUES (?, ?, ?)").run(
      fromNumber,
      role,
      content
    );
    db.prepare(
      `DELETE FROM chat_history WHERE from_number = ? AND id NOT IN (
         SELECT id FROM chat_history WHERE from_number = ? ORDER BY created_at DESC LIMIT ?
       )`
    ).run(fromNumber, fromNumber, CHAT_HISTORY_KEEP_PER_USER);
  },
};

// How many turns of the recalled session "riwayat chat" shows — capped here
// at the query level (not just relying on sendWhatsAppMessage's 4096-char
// defensive truncation) so a long session doesn't get cut off mid-sentence
// at an arbitrary point.
const SESSION_HISTORY_TRANSCRIPT_LIMIT = 30;

export interface SessionTurn {
  role: "user" | "assistant";
  content: string;
}

export const sessionRepo = {
  append(fromNumber: string, sessionId: string, role: "user" | "assistant", content: string): void {
    db.prepare("INSERT INTO session_log (from_number, session_id, role, content) VALUES (?, ?, ?, ?)").run(
      fromNumber,
      sessionId,
      role,
      content
    );
  },
  // Excludes the currently-open session, returns the most recent other one
  // for this user, oldest-first, capped to the last SESSION_HISTORY_TRANSCRIPT_LIMIT turns.
  getMostRecentCompletedSession(
    fromNumber: string,
    excludeSessionId: string | null | undefined
  ): { sessionId: string; messages: SessionTurn[] } | undefined {
    // "(? IS NULL OR session_id != ?)" — a plain "!= ?" against a bound NULL
    // (brand-new user, no current_session_id yet) would exclude every row
    // under SQLite's three-valued NULL logic, not just none.
    const prior = db
      .prepare(
        `SELECT session_id, MAX(created_at) AS last_ts FROM session_log
         WHERE from_number = ? AND (? IS NULL OR session_id != ?)
         GROUP BY session_id ORDER BY last_ts DESC LIMIT 1`
      )
      .get(fromNumber, excludeSessionId ?? null, excludeSessionId ?? null) as
      | { session_id: string; last_ts: string }
      | undefined;
    if (!prior) return undefined;

    const rows = db
      .prepare(
        "SELECT role, content FROM session_log WHERE from_number = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(fromNumber, prior.session_id, SESSION_HISTORY_TRANSCRIPT_LIMIT) as SessionTurn[];
    return { sessionId: prior.session_id, messages: rows.reverse() };
  },
};
