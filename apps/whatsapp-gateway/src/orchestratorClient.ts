import { config } from "./config.js";
import type { InboundMessage } from "./whatsapp.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToOrchestrator(path: string, body: unknown): Promise<Response> {
  return fetch(`${config.orchestratorUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": config.internalSharedSecret,
    },
    body: JSON.stringify(body),
  });
}

// /inbound just acks (~1ms, before any AI work starts — see orchestrator's
// index.ts), so a failure here is a real network/connectivity blip (the
// orchestrator process restarting, a tunnel reconnecting), never the AI
// pipeline being slow. One retry after a short pause clears most of those
// instead of surfacing "gagal kekirim" to the user for something that would
// have gone through a second later.
const FORWARD_RETRY_DELAY_MS = 2_000;

export async function forwardToOrchestrator(
  message: InboundMessage,
  image?: { mimeType: string; base64Data: string },
  audio?: { mimeType: string; base64Data: string },
  retryDelayMs = FORWARD_RETRY_DELAY_MS
): Promise<void> {
  const body = { ...message, image, audio };
  try {
    const res = await postToOrchestrator("/inbound", body);
    if (!res.ok) throw new Error(`Orchestrator rejected inbound message (${res.status}): ${await res.text()}`);
  } catch (err) {
    console.warn(`Forwarding to orchestrator failed, retrying once: ${err instanceof Error ? err.message : err}`);
    await sleep(retryDelayMs);
    const res = await postToOrchestrator("/inbound", body);
    if (!res.ok) throw new Error(`Orchestrator rejected inbound message (${res.status}): ${await res.text()}`);
  }
}

export async function forwardFigmaOAuthCallback(code: string, state: string): Promise<void> {
  const res = await fetch(`${config.orchestratorUrl}/internal/figma-oauth-callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": config.internalSharedSecret,
    },
    body: JSON.stringify({ code, state }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Orchestrator rejected Figma OAuth callback (${res.status}): ${body}`);
  }
}
