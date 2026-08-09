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

// Extracts messages from a Meta Cloud API webhook payload — plain text, plus
// taps on interactive reply buttons/list rows (normalized to the option's id
// as if the user had typed it, so the orchestrator's command parsing doesn't
// need to know buttons exist at all).
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
          interactive?: {
            type: string;
            button_reply?: { id: string; title: string };
            list_reply?: { id: string; title: string };
          };
        };
        if (msg.type === "text" && msg.text?.body) {
          messages.push({ from: msg.from, text: msg.text.body, waMessageId: msg.id, timestamp: msg.timestamp });
        } else if (msg.type === "interactive") {
          const tapped = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
          if (tapped?.id) {
            messages.push({ from: msg.from, text: tapped.id, waMessageId: msg.id, timestamp: msg.timestamp });
          }
        }
      }
    }
  }
  return messages;
}

export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  await postMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}

export interface QuickReplyOption {
  // Sent back verbatim (as the inbound message's text) when the user taps
  // this option — should be exactly what they'd have typed by hand, e.g.
  // "ya", "pakai toko-online", "pakai model semua gemini/gemini-3.5-flash".
  id: string;
  title: string;
  description?: string;
}

const BUTTON_TITLE_MAX = 20;
const LIST_ROW_TITLE_MAX = 24;
const LIST_ROW_DESCRIPTION_MAX = 72;
const LIST_BUTTON_LABEL_MAX = 20;
const MAX_BUTTONS = 3;
const MAX_LIST_ROWS = 10;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

// Buttons for <=3 options (WhatsApp's hard limit, no room for descriptions);
// a single-section list otherwise, capped at 10 rows since that's the most
// WhatsApp allows in one interactive list message.
export async function sendWhatsAppOptions(
  to: string,
  bodyText: string,
  options: QuickReplyOption[],
  listButtonLabel = "Pilih"
): Promise<void> {
  if (options.length === 0) {
    return sendWhatsAppMessage(to, bodyText);
  }

  if (options.length <= MAX_BUTTONS) {
    await postMessage({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: options.map((opt) => ({
            type: "reply",
            reply: { id: opt.id, title: truncate(opt.title, BUTTON_TITLE_MAX) },
          })),
        },
      },
    });
    return;
  }

  const rows = options.slice(0, MAX_LIST_ROWS).map((opt) => ({
    id: opt.id,
    title: truncate(opt.title, LIST_ROW_TITLE_MAX),
    ...(opt.description ? { description: truncate(opt.description, LIST_ROW_DESCRIPTION_MAX) } : {}),
  }));

  await postMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: truncate(listButtonLabel, LIST_BUTTON_LABEL_MAX),
        sections: [{ rows }],
      },
    },
  });
}

async function postMessage(body: Record<string, unknown>): Promise<void> {
  const url = `https://graph.facebook.com/${config.metaGraphApiVersion}/${config.metaPhoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.metaAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`Failed to send WhatsApp message (${res.status}): ${responseBody}`);
  }
}
