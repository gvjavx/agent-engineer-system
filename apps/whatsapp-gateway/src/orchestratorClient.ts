import { config } from "./config.js";
import type { InboundMessage } from "./whatsapp.js";

export async function forwardToOrchestrator(message: InboundMessage): Promise<void> {
  const res = await fetch(`${config.orchestratorUrl}/inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": config.internalSharedSecret,
    },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Orchestrator rejected inbound message (${res.status}): ${body}`);
  }
}
