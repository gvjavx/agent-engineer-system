import { config } from "./config.js";
import type { InboundMessage } from "./whatsapp.js";

export async function forwardToOrchestrator(
  message: InboundMessage,
  image?: { mimeType: string; base64Data: string }
): Promise<void> {
  const res = await fetch(`${config.orchestratorUrl}/inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": config.internalSharedSecret,
    },
    body: JSON.stringify({ ...message, image }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Orchestrator rejected inbound message (${res.status}): ${body}`);
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
