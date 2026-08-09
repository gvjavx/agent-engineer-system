// CSRF state for the "hubungkan figma" flow, and which WhatsApp number to
// notify once the callback lands. In-memory is enough — the whole flow (send
// link -> user opens browser -> callback) takes seconds to minutes; losing
// it on a process restart just means the user re-runs "hubungkan figma".
import crypto from "node:crypto";

interface PendingLink {
  fromNumber: string;
  createdAt: number;
}

const pending = new Map<string, PendingLink>();
const TTL_MS = 15 * 60 * 1000;

export function createPendingState(fromNumber: string): string {
  const state = crypto.randomBytes(16).toString("hex");
  pending.set(state, { fromNumber, createdAt: Date.now() });
  return state;
}

export function consumePendingState(state: string): string | undefined {
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || Date.now() - entry.createdAt > TTL_MS) return undefined;
  return entry.fromNumber;
}
