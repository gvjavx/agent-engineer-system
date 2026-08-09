import assert from "node:assert/strict";
import { test } from "node:test";
import { extractInboundMessages, sendWhatsAppOptions } from "./whatsapp.js";

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

function webhookPayload(message: Record<string, unknown>) {
  return { entry: [{ changes: [{ value: { messages: [message] } }] }] };
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
  const payload = webhookPayload({ id: "wamid.4", from: "628123", timestamp: "4", type: "image" });
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
