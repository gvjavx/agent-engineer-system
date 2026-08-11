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
  // Present only for an image message — the caption (if any) is carried in
  // `text` above instead, empty string if none, same convention `text`
  // already uses for a tapped interactive button/list id.
  imageId?: string;
  imageMimeType?: string;
}

// Extracts messages from a Meta Cloud API webhook payload — plain text, taps
// on interactive reply buttons/list rows (normalized to the option's id as if
// the user had typed it, so the orchestrator's command parsing doesn't need
// to know buttons exist at all), and images (the webhook only ever carries a
// media id reference, never the bytes — see whatsapp-gateway's index.ts for
// where those get resolved and downloaded before forwarding).
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
          image?: { id: string; mime_type: string; caption?: string };
        };
        if (msg.type === "text" && msg.text?.body) {
          messages.push({ from: msg.from, text: msg.text.body, waMessageId: msg.id, timestamp: msg.timestamp });
        } else if (msg.type === "interactive") {
          const tapped = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
          if (tapped?.id) {
            messages.push({ from: msg.from, text: tapped.id, waMessageId: msg.id, timestamp: msg.timestamp });
          }
        } else if (msg.type === "image" && msg.image?.id) {
          messages.push({
            from: msg.from,
            text: msg.image.caption ?? "",
            waMessageId: msg.id,
            timestamp: msg.timestamp,
            imageId: msg.image.id,
            imageMimeType: msg.image.mime_type,
          });
        }
      }
    }
  }
  return messages;
}

// Meta's documented body-text ceilings — a plain text message allows up to
// 4096 characters, but an interactive (button/list) message's body is capped
// much tighter at 1024. Nothing enforced this before: an AI-generated phase
// summary or task result long enough to cross either limit made the whole
// send fail outright (400, code 131009) instead of just arriving trimmed —
// and since callers fire-and-forget these sends, that failure was invisible
// to the user, not just cosmetic (a pipeline checkpoint waiting on a message
// that never arrived looks like the bot silently hung).
const TEXT_BODY_MAX = 4096;
const INTERACTIVE_BODY_MAX = 1024;

export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  await postMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: truncate(text, TEXT_BODY_MAX) },
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
        body: { text: truncate(bodyText, INTERACTIVE_BODY_MAX) },
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
      body: { text: truncate(bodyText, INTERACTIVE_BODY_MAX) },
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

// Two-step process for sending a file: upload it to get a media id, then
// reference that id in a "document" message. WhatsApp has no way to send
// raw bytes directly in the message itself.
export async function uploadMedia(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
  const url = `https://graph.facebook.com/${config.metaGraphApiVersion}/${config.metaPhoneNumberId}/media`;
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", mimeType);
  form.set("file", new Blob([Uint8Array.from(buffer)], { type: mimeType }), filename);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.metaAccessToken}` },
    body: form,
  });
  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`Failed to upload media (${res.status}): ${responseBody}`);
  }
  const json = (await res.json()) as { id: string };
  return json.id;
}

export async function sendWhatsAppDocument(
  to: string,
  mediaId: string,
  filename: string,
  caption?: string
): Promise<void> {
  await postMessage({
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { id: mediaId, filename, ...(caption ? { caption } : {}) },
  });
}

// Reverse of uploadMedia: the webhook only ever gives us a media id, never
// the bytes. Two authenticated calls — resolve the id to a short-lived (5
// minute) CDN url, then fetch that url — both need the same Bearer token.
export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const metaUrl = `https://graph.facebook.com/${config.metaGraphApiVersion}/${mediaId}`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${config.metaAccessToken}` },
  });
  if (!metaRes.ok) {
    throw new Error(`Failed to resolve media URL (${metaRes.status}): ${await metaRes.text()}`);
  }
  const { url, mime_type: declaredMimeType } = (await metaRes.json()) as { url: string; mime_type: string };

  const fileRes = await fetch(url, {
    headers: { Authorization: `Bearer ${config.metaAccessToken}` },
  });
  if (!fileRes.ok) {
    throw new Error(`Failed to download media bytes (${fileRes.status}): ${await fileRes.text()}`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  // Trust the actual bytes' declared type over the metadata call's claim, in
  // case they ever disagree; fall back to the metadata if the CDN omits it.
  return { buffer, mimeType: fileRes.headers.get("content-type") ?? declaredMimeType };
}
