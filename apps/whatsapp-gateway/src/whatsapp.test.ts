import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractInboundMessages,
  sendWhatsAppOptions,
  uploadMedia,
  sendWhatsAppDocument,
  downloadMedia,
} from "./whatsapp.js";

// sendWhatsAppOptions hits the real Graph API via global fetch — swap it out
// for a spy so these tests just check the payload shape, no network needed.
async function captureRequestBody(run: () => Promise<void>): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  let captured: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
    captured = JSON.parse(init.body ?? "{}");
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (!captured) throw new Error("fetch was never called");
  return captured;
}

// downloadMedia makes two sequential fetch calls (resolve id -> url, then
// fetch the url) — queue up a response for each, in order.
interface QueuedResponse {
  status: number;
  jsonBody?: unknown;
  arrayBuffer?: ArrayBuffer;
  headers?: Record<string, string>;
}

async function withQueuedFetch<T>(responses: QueuedResponse[], run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = (async () => {
    const next = responses[callIndex++];
    if (!next) throw new Error("fetch called more times than expected");
    const body = next.arrayBuffer ?? (next.jsonBody !== undefined ? JSON.stringify(next.jsonBody) : undefined);
    return new Response(body, { status: next.status, headers: next.headers });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function webhookPayload(message: Record<string, unknown>) {
  return { entry: [{ changes: [{ value: { messages: [message] } }] }] };
}

// uploadMedia sends multipart/form-data, not JSON — capture the raw call
// instead of trying to JSON.parse the body like captureRequestBody does.
async function captureFetchCall(
  run: () => Promise<void>,
  responseBody: unknown = {}
): Promise<{ url: string; init: RequestInit }> {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (!captured) throw new Error("fetch was never called");
  return captured;
}

test("extractInboundMessages extracts plain text messages", () => {
  const payload = webhookPayload({ id: "wamid.1", from: "628123", timestamp: "1", type: "text", text: { body: "halo" } });
  assert.deepEqual(extractInboundMessages(payload), [
    { from: "628123", text: "halo", waMessageId: "wamid.1", timestamp: "1" },
  ]);
});

test("extractInboundMessages extracts a tapped reply button as its id", () => {
  const payload = webhookPayload({
    id: "wamid.2",
    from: "628123",
    timestamp: "2",
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "ya", title: "Ya, lanjut" } },
  });
  assert.deepEqual(extractInboundMessages(payload), [
    { from: "628123", text: "ya", waMessageId: "wamid.2", timestamp: "2" },
  ]);
});

test("extractInboundMessages extracts a tapped list row as its id", () => {
  const payload = webhookPayload({
    id: "wamid.3",
    from: "628123",
    timestamp: "3",
    type: "interactive",
    interactive: { type: "list_reply", list_reply: { id: "pakai toko-online", title: "toko-online" } },
  });
  assert.deepEqual(extractInboundMessages(payload), [
    { from: "628123", text: "pakai toko-online", waMessageId: "wamid.3", timestamp: "3" },
  ]);
});

test("extractInboundMessages ignores message types it doesn't understand", () => {
  const payload = webhookPayload({ id: "wamid.4", from: "628123", timestamp: "4", type: "sticker" });
  assert.deepEqual(extractInboundMessages(payload), []);
});

test("extractInboundMessages extracts an image message with a caption", () => {
  const payload = webhookPayload({
    id: "wamid.5",
    from: "628123",
    timestamp: "5",
    type: "image",
    image: { id: "media-abc", mime_type: "image/jpeg", caption: "perbaiki tampilan ini" },
  });
  assert.deepEqual(extractInboundMessages(payload), [
    {
      from: "628123",
      text: "perbaiki tampilan ini",
      waMessageId: "wamid.5",
      timestamp: "5",
      imageId: "media-abc",
      imageMimeType: "image/jpeg",
    },
  ]);
});

test("extractInboundMessages extracts an image message without a caption as empty text", () => {
  const payload = webhookPayload({
    id: "wamid.6",
    from: "628123",
    timestamp: "6",
    type: "image",
    image: { id: "media-def", mime_type: "image/png" },
  });
  assert.deepEqual(extractInboundMessages(payload), [
    { from: "628123", text: "", waMessageId: "wamid.6", timestamp: "6", imageId: "media-def", imageMimeType: "image/png" },
  ]);
});

test("extractInboundMessages ignores an image message missing the image object/id", () => {
  const payload = webhookPayload({ id: "wamid.7", from: "628123", timestamp: "7", type: "image" });
  assert.deepEqual(extractInboundMessages(payload), []);
});

test("extractInboundMessages handles an empty/malformed payload without throwing", () => {
  assert.deepEqual(extractInboundMessages({}), []);
  assert.deepEqual(extractInboundMessages(null), []);
});

test("sendWhatsAppOptions sends reply buttons for 3 or fewer options", async () => {
  const body = await captureRequestBody(() =>
    sendWhatsAppOptions("628123", "Lanjut?", [
      { id: "ya", title: "Ya, lanjut" },
      { id: "tidak", title: "Tidak, batal" },
    ])
  );
  assert.equal(body.type, "interactive");
  const interactive = body.interactive as Record<string, unknown>;
  assert.equal(interactive.type, "button");
  const action = interactive.action as { buttons: { reply: { id: string; title: string } }[] };
  assert.deepEqual(
    action.buttons.map((b) => b.reply),
    [
      { id: "ya", title: "Ya, lanjut" },
      { id: "tidak", title: "Tidak, batal" },
    ]
  );
});

test("sendWhatsAppOptions sends a list message for more than 3 options", async () => {
  const options = Array.from({ length: 5 }, (_, i) => ({ id: `opt-${i}`, title: `Option ${i}` }));
  const body = await captureRequestBody(() => sendWhatsAppOptions("628123", "Pilih satu", options, "Lihat pilihan"));
  assert.equal(body.type, "interactive");
  const interactive = body.interactive as Record<string, unknown>;
  assert.equal(interactive.type, "list");
  const action = interactive.action as { button: string; sections: { rows: { id: string }[] }[] };
  assert.equal(action.button, "Lihat pilihan");
  assert.equal(action.sections[0].rows.length, 5);
});

test("sendWhatsAppOptions truncates titles/descriptions past WhatsApp's limits", async () => {
  const longTitle = "a".repeat(40);
  const longDescription = "b".repeat(100);
  const options = Array.from({ length: 4 }, (_, i) => ({
    id: `opt-${i}`,
    title: longTitle,
    description: longDescription,
  }));
  const body = await captureRequestBody(() => sendWhatsAppOptions("628123", "Pilih satu", options));
  const interactive = body.interactive as Record<string, unknown>;
  const action = interactive.action as { sections: { rows: { title: string; description: string }[] }[] };
  const row = action.sections[0].rows[0];
  assert.ok(row.title.length <= 24, `title too long: ${row.title.length}`);
  assert.ok(row.description.length <= 72, `description too long: ${row.description.length}`);
});

test("sendWhatsAppOptions caps list rows at 10", async () => {
  const options = Array.from({ length: 15 }, (_, i) => ({ id: `opt-${i}`, title: `Option ${i}` }));
  const body = await captureRequestBody(() => sendWhatsAppOptions("628123", "Pilih satu", options));
  const interactive = body.interactive as Record<string, unknown>;
  const action = interactive.action as { sections: { rows: unknown[] }[] };
  assert.equal(action.sections[0].rows.length, 10);
});

test("uploadMedia posts the file as multipart form data and returns the media id", async () => {
  const { url, init } = await captureFetchCall(async () => {
    const id = await uploadMedia(Buffer.from("hello world"), "FSD.md", "text/plain");
    assert.equal(id, "media-123");
  }, { id: "media-123" });

  assert.match(url, /\/media$/);
  assert.equal(init.method, "POST");
  const form = init.body as FormData;
  assert.equal(form.get("messaging_product"), "whatsapp");
  assert.equal(form.get("type"), "text/plain");
  const file = form.get("file") as File;
  assert.equal(file.name, "FSD.md");
  assert.equal(file.type, "text/plain");
});

test("sendWhatsAppDocument sends a document message referencing the media id", async () => {
  const body = await captureRequestBody(() => sendWhatsAppDocument("628123", "media-123", "FSD.md", "ini dia"));
  assert.equal(body.type, "document");
  assert.deepEqual(body.document, { id: "media-123", filename: "FSD.md", caption: "ini dia" });
});

test("downloadMedia resolves the media id then fetches the bytes", async () => {
  const bytes = new TextEncoder().encode("fake image bytes").buffer;
  const result = await withQueuedFetch(
    [
      { status: 200, jsonBody: { url: "https://cdn.example/media-abc", mime_type: "image/jpeg" } },
      { status: 200, arrayBuffer: bytes, headers: { "content-type": "image/jpeg" } },
    ],
    () => downloadMedia("media-abc")
  );
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.buffer.toString(), "fake image bytes");
});

test("downloadMedia falls back to the metadata's mime type when the bytes response omits Content-Type", async () => {
  const bytes = new TextEncoder().encode("x").buffer;
  const result = await withQueuedFetch(
    [
      { status: 200, jsonBody: { url: "https://cdn.example/media-abc", mime_type: "image/png" } },
      { status: 200, arrayBuffer: bytes },
    ],
    () => downloadMedia("media-abc")
  );
  assert.equal(result.mimeType, "image/png");
});

test("downloadMedia throws with the response body when resolving the media id fails", async () => {
  await assert.rejects(
    withQueuedFetch([{ status: 404, jsonBody: { error: "not found" } }], () => downloadMedia("missing")),
    /Failed to resolve media URL \(404\)/
  );
});

test("downloadMedia throws with the response body when downloading the bytes fails", async () => {
  await assert.rejects(
    withQueuedFetch(
      [
        { status: 200, jsonBody: { url: "https://cdn.example/media-abc", mime_type: "image/jpeg" } },
        { status: 410, jsonBody: { error: "expired" } },
      ],
      () => downloadMedia("media-abc")
    ),
    /Failed to download media bytes \(410\)/
  );
});
