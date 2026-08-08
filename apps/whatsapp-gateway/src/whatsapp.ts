import crypto from "node:crypto";
import { config } from "./config.js";

export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto
    .createHmac("sha256", config.metaAppSecret)
    .update(rawBody)
    .digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  return (
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf)
  );
}

export interface InboundMessage {
  from: string;
  text: string;
  waMessageId: string;
  timestamp: string;
}

// Extracts plain-text messages from a Meta Cloud API webhook payload.
// Non-text messages (images, audio, etc.) are ignored for the MVP.
export function extractInboundMessages(payload: unknown): InboundMessage[] {
  const messages: InboundMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes ?? [];
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const rawMessages = (value?.messages as unknown[]) ?? [];
      for (const m of rawMessages) {
        const msg = m as {
          id: string;
          from: string;
          timestamp: string;
          type: string;
          text?: { body: string };
        };
        if (msg.type === "text" && msg.text?.body) {
          messages.push({
            from: msg.from,
            text: msg.text.body,
            waMessageId: msg.id,
            timestamp: msg.timestamp,
          });
        }
      }
    }
  }
  return messages;
}

export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const url = `https://graph.facebook.com/${config.metaGraphApiVersion}/${config.metaPhoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.metaAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to send WhatsApp message (${res.status}): ${body}`);
  }
}
