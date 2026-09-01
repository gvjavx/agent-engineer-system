import assert from "node:assert/strict";
import { test } from "node:test";
import { recordInteraction, lookupCachedAnswer, semanticLookup } from "./chatKb.js";
import { chatKbRepo, normalizeQuestion, kbStatsRepo } from "../db/chatKb.js";

// Random suffixes: these hit the real sqlite file (same as every other test
// in this codebase), so from_numbers must not collide across runs.
const uid = (tag: string) => `kbtest-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function seed(from: string, question: string, answer: string): Promise<void> {
  await recordInteraction({ fromNumber: from, kind: "chat_model", question, answer }, { enabled: true });
}
const lookup = (from: string, question: string) => lookupCachedAnswer({ fromNumber: from, question }, { enabled: true });

test("normalizeQuestion strips case/punctuation/spaces and collapses fillers + synonyms", () => {
  assert.equal(normalizeQuestion("Kapan Hari Kemerdekaan Indonesia?"), "kapan hari kemerdekaan indonesia");
  // filler dropped, "penemu" -> canonical "temu"
  assert.equal(normalizeQuestion("  siapa sih   penemu, sepeda itu!!  "), "siapa temu sepeda");
  // spelling / synonym variants land on the same form
  assert.equal(
    normalizeQuestion("apakah lo nggak terhubung ke internet"),
    normalizeQuestion("apa kamu ga tersambung ke internet")
  );
  assert.equal(normalizeQuestion("bagaimana bikin kopi"), normalizeQuestion("gimana membuat kopi"));
});

test("recordInteraction is a no-op when the KB is disabled", async () => {
  const from = uid("disabled");
  await recordInteraction({ fromNumber: from, kind: "chat_model", question: "q", answer: "a" }, { enabled: false });
  assert.equal(chatKbRepo.countForNumber(from), 0);
});

test("recordInteraction stores the Q&A when enabled; blank question/answer records nothing", async () => {
  const from = uid("store");
  await seed(from, "hari lahir Pancasila kapan?", "1 Juni");
  await recordInteraction({ fromNumber: from, kind: "chat_model", question: "  ", answer: "x" }, { enabled: true });
  await recordInteraction({ fromNumber: from, kind: "chat_model", question: "x", answer: "" }, { enabled: true });
  assert.equal(chatKbRepo.countForNumber(from), 1);
});

test("lookupCachedAnswer hits on the same question re-asked (punctuation/case ignored)", async () => {
  const from = uid("exact");
  await seed(from, "kapan hari kemerdekaan indonesia?", "17 Agustus.");

  assert.equal((await lookup(from, "kapan hari kemerdekaan indonesia")).hit, "17 Agustus.");
  assert.equal((await lookup(from, "KAPAN Hari Kemerdekaan Indonesia???")).hit, "17 Agustus.");
  // reordered words -> same token set -> still a hit
  assert.equal((await lookup(from, "hari kemerdekaan indonesia kapan")).hit, "17 Agustus.");
});

test("lookupCachedAnswer hits through filler + synonym differences, misses a genuinely different question", async () => {
  const from = uid("fuzzy");
  await seed(from, "siapa sih penemu sepeda itu", "Karl von Drais.");

  // fillers dropped + penemu->temu on both sides -> same normalized form -> hit
  assert.equal((await lookup(from, "siapa penemu sepeda")).hit, "Karl von Drais.");
  assert.equal((await lookup(from, "SIAPA yang menemukan sepeda??")).hit, "Karl von Drais.");
  // "when was it invented" is a different question -> miss
  assert.equal((await lookup(from, "kapan sepeda dibuat")).hit, undefined);
});

test("lookupCachedAnswer returns {} when disabled or the store is empty for this sender", async () => {
  const from = uid("guards");
  await seed(from, "apa kabar", "baik");
  assert.deepEqual(await lookupCachedAnswer({ fromNumber: from, question: "apa kabar" }, { enabled: false }), {});
  assert.deepEqual(await lookup(uid("empty"), "apa pun"), {});
});

test("an arithmetic row is never a local-match candidate", async () => {
  const from = uid("arith");
  await recordInteraction(
    { fromNumber: from, kind: "chat_arithmetic", question: "2 + 2", answer: "2 + 2 = 4" },
    { enabled: true }
  );
  assert.equal((await lookup(from, "2 + 2")).hit, undefined);
});

test("semanticLookup: cosine against stored vectors, threshold-gated, returns the query vector", async () => {
  const from = uid("sem");
  // recordInteraction won't embed with the flag off (the test default), so
  // set a vector on the row directly.
  const id = chatKbRepo.insert(from, "chat_model", "kapan hari kemerdekaan indonesia", "17 Agustus.");
  chatKbRepo.setEmbedding(id, Float32Array.from([1, 0, 0]));

  const hit = await semanticLookup(from, "tanggal berapa indonesia merdeka", {
    embedFn: async () => [Float32Array.from([1, 0, 0])], // parallel -> cosine 1 -> hit
  });
  assert.equal(hit.hit, "17 Agustus.");
  assert.ok(hit.queryVector instanceof Float32Array);

  const miss = await semanticLookup(from, "resep rendang", {
    embedFn: async () => [Float32Array.from([0, 1, 0])], // orthogonal -> cosine 0 -> miss
  });
  assert.equal(miss.hit, undefined);
  assert.ok(miss.queryVector instanceof Float32Array);
});

test("kbStatsRepo aggregates by source over a day window and computes the without-AI percentage", () => {
  // a unique day far in the past so the window catches only this test's rows
  const day = `19${Math.floor(Math.random() * 89) + 10}-06-15`;
  for (let i = 0; i < 3; i++) kbStatsRepo.bump("model", day);
  kbStatsRepo.bump("kb", day);
  kbStatsRepo.bump("kb", day);
  kbStatsRepo.bump("arithmetic", day);

  const s = kbStatsRepo.summary(3, new Date(`${day}T12:00:00+07:00`));
  assert.deepEqual(
    { model: s.model, kb: s.kb, arithmetic: s.arithmetic, total: s.total, pct: s.withoutAiPct },
    { model: 3, kb: 2, arithmetic: 1, total: 6, pct: 50 }
  );
});

test("clearForNumber wipes a sender's stored interactions", async () => {
  const from = uid("clear");
  await seed(from, "q", "a");
  assert.equal(chatKbRepo.countForNumber(from), 1);
  chatKbRepo.clearForNumber(from);
  assert.equal(chatKbRepo.countForNumber(from), 0);
});
