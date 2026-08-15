// Meta re-delivers a webhook on any slow/non-2xx response, and
// whatsapp-gateway's own retry (orchestratorClient.ts's forwardToOrchestrator)
// can also resend after a dropped response even when /inbound already
// succeeded server-side — handleInboundMessage isn't idempotent (each call
// runs its own AI pipeline and appends chat history), so without this a
// retried delivery silently processes the same message a second time,
// racing the first run and corrupting chat history/replies, instead of
// being a no-op. In-memory is enough, same reasoning as
// agent/mcp/figmaOAuthState.ts: this only needs to survive the few seconds
// a retry could plausibly land in, not a process restart.
const seenAt = new Map<string, number>();
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

export function isDuplicateInboundMessage(waMessageId: string): boolean {
  const now = Date.now();
  for (const [id, at] of seenAt) {
    if (now - at > DEDUP_WINDOW_MS) seenAt.delete(id);
  }
  if (seenAt.has(waMessageId)) return true;
  seenAt.set(waMessageId, now);
  return false;
}
