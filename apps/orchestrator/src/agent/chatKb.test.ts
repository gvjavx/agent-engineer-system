import assert from "node:assert/strict";
import { test } from "node:test";
import { recordInteraction } from "./chatKb.js";
import { chatKbRepo } from "../db/chatKb.js";
import type { EmbeddingProvider } from "./rag/index.js";

const uid = (tag: string) => `kbtest-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function fakeEmbedder(): EmbeddingProvider & { calls: number } {
  const e = {
    calls: 0,
    name: "fake",
    model: "fake",
    identity: "fake@4",
    async embed(texts: string[]) {
      e.calls += texts.length;
      return texts.map(() => Float32Array.from([1, 2, 3, 4]));
    },
  };
  return e;
}

test("recordInteraction is a no-op when the KB is disabled (the default)", async () => {
  const from = uid("disabled");
  await recordInteraction({ fromNumber: from, kind: "chat_model", question: "q", answer: "a" });
  assert.equal(chatKbRepo.countForNumber(from), 0);
});

test("recordInteraction stores the Q&A and backfills the question embedding when enabled", async () => {
  const from = uid("enabled");
  const embedder = fakeEmbedder();
  await recordInteraction(
    { fromNumber: from, kind: "chat_model", question: "hari lahir Pancasila kapan?", answer: "1 Juni" },
    { enabled: true, embedder }
  );
  assert.equal(chatKbRepo.countForNumber(from), 1);
  assert.equal(embedder.calls, 1);
  const rows = chatKbRepo.embeddedForNumber(from);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].question, "hari lahir Pancasila kapan?");
  assert.equal(rows[0].answer, "1 Juni");
  assert.deepEqual([...rows[0].embedding], [1, 2, 3, 4]);
});

test("an arithmetic answer is stored but never embedded", async () => {
  const from = uid("arith");
  const embedder = fakeEmbedder();
  await recordInteraction(
    { fromNumber: from, kind: "chat_arithmetic", question: "234 x 213", answer: "234 × 213 = 49.842" },
    { enabled: true, embedder }
  );
  assert.equal(chatKbRepo.countForNumber(from), 1);
  assert.equal(embedder.calls, 0);
  assert.equal(chatKbRepo.embeddedForNumber(from).length, 0);
});

test("with no embedder available the row is still saved (embedding backfilled later)", async () => {
  const from = uid("noembed");
  await recordInteraction(
    { fromNumber: from, kind: "chat_model", question: "q", answer: "a" },
    { enabled: true, embedder: null }
  );
  assert.equal(chatKbRepo.countForNumber(from), 1);
  assert.equal(chatKbRepo.embeddedForNumber(from).length, 0);
});

test("blank question or answer records nothing", async () => {
  const from = uid("blank");
  await recordInteraction({ fromNumber: from, kind: "chat_model", question: "   ", answer: "a" }, { enabled: true });
  await recordInteraction({ fromNumber: from, kind: "chat_model", question: "q", answer: "" }, { enabled: true });
  assert.equal(chatKbRepo.countForNumber(from), 0);
});

test("clearForNumber wipes a user's stored interactions", async () => {
  const from = uid("clear");
  await recordInteraction({ fromNumber: from, kind: "chat_model", question: "q", answer: "a" }, { enabled: true, embedder: null });
  assert.equal(chatKbRepo.countForNumber(from), 1);
  chatKbRepo.clearForNumber(from);
  assert.equal(chatKbRepo.countForNumber(from), 0);
});
