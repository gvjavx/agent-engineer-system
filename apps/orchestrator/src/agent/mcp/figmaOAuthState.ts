// CSRF state for the "hubungkan figma" flow, and which WhatsApp number to
// notify once the callback lands. In-memory is enough — the whole flow (send
// link -> user opens browser -> callback) takes seconds to minutes; losing
// it on a process restart just means the user re-runs "hubungkan figma".
import crypto from "node:crypto";

interface PendingLink {
  fromNumber: string;
  codeVerifier: string;
  createdAt: number;
}

const pending = new Map<string, PendingLink>();
const TTL_MS = 15 * 60 * 1000;

export interface PendingAuthorization {
  state: string;
  codeVerifier: string;
}

// codeVerifier is PKCE's random secret (RFC 7636) — Figma's authorize
// endpoint rejects the request outright without a matching code_challenge
// derived from this. Generated alongside state since both are created
// together right before sending the authorize link, and both only need to
// survive until the callback lands.
export function createPendingState(fromNumber: string): PendingAuthorization {
  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  pending.set(state, { fromNumber, codeVerifier, createdAt: Date.now() });
  return { state, codeVerifier };
}

export function consumePendingState(state: string): { fromNumber: string; codeVerifier: string } | undefined {
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || Date.now() - entry.createdAt > TTL_MS) return undefined;
  return { fromNumber: entry.fromNumber, codeVerifier: entry.codeVerifier };
}
