import { db } from "./db/index.js";

// Meta re-delivers a webhook on any slow/non-2xx response, and
// whatsapp-gateway's own retry (orchestratorClient.ts's forwardToOrchestrator)
// can also resend after a dropped response even when /inbound already
// succeeded server-side — handleInboundMessage isn't idempotent (each call
// runs its own AI pipeline and appends chat history), so without this a
// retried delivery silently processes the same message a second time,
// racing the first run and corrupting chat history/replies.
//
// Persisted in sqlite rather than an in-memory Map: a real transcript showed
// a stale retry of a plain "halo" get reprocessed minutes later, replying
// with a greeting that quoted a memory fact only learned in the meantime — a
// Map guard is wiped by any process restart landing inside the retry window,
// which is exactly when it needs to hold.
const DEDUP_WINDOW_MS = 60 * 60 * 1000;

const insertStmt = db.prepare("INSERT OR IGNORE INTO processed_messages (wa_message_id, seen_at) VALUES (?, ?)");
const pruneStmt = db.prepare("DELETE FROM processed_messages WHERE seen_at < ?");

// nowMs is injectable for tests only; production always passes the real clock.
export function isDuplicateInboundMessage(waMessageId: string, nowMs: number = Date.now()): boolean {
  // Prune first so an id last seen longer ago than the window is gone before
  // the insert — a delivery that stale is treated as fresh again, same as the
  // old Map-expiry behavior.
  pruneStmt.run(nowMs - DEDUP_WINDOW_MS);
  return insertStmt.run(waMessageId, nowMs).changes === 0;
}
