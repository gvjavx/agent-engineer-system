import assert from "node:assert/strict";
import { test } from "node:test";
import { generateChatReply, parseChatReply } from "./chatAssistant.js";
import type { ChatMessage, Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: (messages: ChatMessage[]) => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: (messages) => behavior(messages) };
}

test("parseChatReply splits the reply from a trailing FACT line", () => {
  const result = parseChatReply("Wah seru juga ya!\nFACT: lagi belajar masak");
  assert.deepEqual(result, { reply: "Wah seru juga ya!", newFact: "lagi belajar masak" });
});

test("parseChatReply treats 'tidak ada' and its variants as no fact", () => {
  for (const noFact of ["tidak ada", "none", "nggak ada", "gak ada", "ga ada", ""]) {
    const result = parseChatReply(`Oke sip.\nFACT: ${noFact}`);
    assert.deepEqual(result, { reply: "Oke sip." });
  }
});

test("parseChatReply is case-insensitive on the FACT marker and its no-fact values", () => {
  const result = parseChatReply("Sip.\nfact: Tidak Ada");
  assert.deepEqual(result, { reply: "Sip." });
});

test("parseChatReply returns the whole text as the reply when there's no FACT line at all", () => {
  const result = parseChatReply("Cuma jawaban biasa tanpa format apa-apa.");
  assert.deepEqual(result, { reply: "Cuma jawaban biasa tanpa format apa-apa." });
});

test("generateChatReply passes system prompt, history, and the new message in order", async () => {
  let seen: ChatMessage[] | undefined;
  const provider = fakeProvider(async (messages) => {
    seen = messages;
    return { type: "text", text: "Oke.\nFACT: tidak ada" };
  });
  await generateChatReply(
    "gimana kabarnya",
    [
      { role: "user", content: "halo" },
      { role: "assistant", content: "Halo juga!" },
    ],
    ["suka bahasa santai"],
    provider,
    new AbortController().signal
  );
  assert.ok(seen);
  assert.equal(seen![0].role, "system");
  assert.match(seen![0].content ?? "", /suka bahasa santai/);
  assert.deepEqual(seen!.slice(1, 3), [
    { role: "user", content: "halo" },
    { role: "assistant", content: "Halo juga!" },
  ]);
  assert.deepEqual(seen![3], { role: "user", content: "gimana kabarnya" });
});

test("generateChatReply extracts a new fact when the model provides one", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "Wah asik, semangat ya!\nFACT: lagi ngerjain project toko online",
  }));
  const result = await generateChatReply("aku lagi bikin toko online", [], [], provider, new AbortController().signal);
  assert.deepEqual(result, {
    reply: "Wah asik, semangat ya!",
    newFact: "lagi ngerjain project toko online",
    source: "model",
  });
});

test("generateChatReply answers a plain arithmetic question itself, without calling the provider", async () => {
  let called = false;
  const provider = fakeProvider(async () => {
    called = true;
    return { type: "text", text: "salah\nFACT: tidak ada" };
  });
  const result = await generateChatReply("berapa 234 x 213?", [], [], provider, new AbortController().signal);
  assert.equal(called, false);
  assert.deepEqual(result, { reply: "234 × 213 = 49.842", source: "arithmetic" });
});

test("the chat system prompt grounds the model as having no internet access", async () => {
  let seen: ChatMessage[] | undefined;
  const provider = fakeProvider(async (messages) => {
    seen = messages;
    return { type: "text", text: "Oke.\nFACT: tidak ada" };
  });
  await generateChatReply("kabar apa", [], [], provider, new AbortController().signal);
  assert.match(seen?.[0].content ?? "", /no internet access/i);
});

test("generateChatReply returns undefined on a tool_calls response", async () => {
  const provider = fakeProvider(async () => ({ type: "tool_calls", calls: [] }));
  const result = await generateChatReply("x", [], [], provider, new AbortController().signal);
  assert.equal(result, undefined);
});

test("generateChatReply returns undefined when the provider throws", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  const result = await generateChatReply("x", [], [], provider, new AbortController().signal);
  assert.equal(result, undefined);
});

test("generateChatReply returns undefined on an empty reply", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "FACT: tidak ada" }));
  const result = await generateChatReply("x", [], [], provider, new AbortController().signal);
  assert.equal(result, undefined);
});
