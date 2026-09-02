import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recordInteraction,
  lookupCachedAnswer,
  semanticLookup,
  isVolatile,
  noteKbHit,
  clearKbHit,
  consumeKbCorrection,
} from "./chatKb.js";
import { chatKbRepo, normalizeQuestion, kbStatsRepo, kbHintsRepo } from "../db/chatKb.js";
import { db } from "../db/index.js";

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

test("isVolatile flags time-sensitive questions/answers, not stable facts", () => {
  assert.equal(isVolatile("siapa presiden indonesia sekarang", "..."), true);
  assert.equal(isVolatile("berapa harga emas hari ini", "..."), true);
  assert.equal(isVolatile("versi terbaru node berapa", "..."), true);
  assert.equal(isVolatile("berapa kurs dolar", "..."), true);
  assert.equal(isVolatile("apa kabar", "Kursnya sekitar Rp 16.000 per dolar."), true); // answer-side
  assert.equal(isVolatile("cerita dong", "Per 1 Januari 2026 aturannya berubah."), true);

  assert.equal(isVolatile("kapan hari kemerdekaan indonesia", "17 Agustus 1945."), false);
  assert.equal(isVolatile("siapa penemu sepeda", "Karl von Drais, 1817."), false);
  assert.equal(isVolatile("apa itu fotosintesis", "Proses tumbuhan mengubah cahaya jadi energi."), false);
});

test("a volatile question is logged but never becomes a cache candidate", async () => {
  const from = uid("volatile");
  await recordInteraction(
    { fromNumber: from, kind: "chat_model", question: "siapa presiden indonesia sekarang", answer: "X." },
    { enabled: true }
  );
  assert.equal(chatKbRepo.countForNumber(from), 1); // still recorded (stats / future distillation)
  assert.equal((await lookup(from, "siapa presiden indonesia sekarang")).hit, undefined); // but not served
});

test("re-answering the same question replaces the stored row instead of piling up", async () => {
  const from = uid("dedup");
  await seed(from, "apa ibukota australia", "Sydney."); // wrong on purpose
  await seed(from, "apa ibukota australia?", "Canberra."); // corrected
  assert.equal(chatKbRepo.countForNumber(from), 1);
  assert.equal((await lookup(from, "apa ibukota australia")).hit, "Canberra.");
});

test("a cached answer past the TTL is ignored", async () => {
  const from = uid("ttl");
  const id = chatKbRepo.insert(from, "chat_model", "apa itu blockchain", "Buku besar terdistribusi.");
  db.prepare("UPDATE interaction_kb SET created_at = datetime('now', '-200 days') WHERE id = ?").run(id);

  // default config TTL is 90 days -> this 200-day-old row shouldn't match
  assert.equal((await lookup(from, "apa itu blockchain")).hit, undefined);
});

test("an older-but-in-TTL cached answer gets an age note; a fresh one doesn't", async () => {
  const from = uid("agenote");
  const id = chatKbRepo.insert(from, "chat_model", "apa itu graphql", "Bahasa query buat API.");
  db.prepare("UPDATE interaction_kb SET created_at = datetime('now', '-40 days') WHERE id = ?").run(id);
  const aged = (await lookup(from, "apa itu graphql")).hit;
  assert.match(aged ?? "", /Bahasa query buat API\./);
  assert.match(aged ?? "", /jawaban tersimpan dari/);

  await seed(from, "apa itu rest api", "Gaya arsitektur buat API.");
  assert.equal((await lookup(from, "apa itu rest api")).hit, "Gaya arsitektur buat API."); // no note, fresh
});

test("consumeKbCorrection: only after a noted KB hit, only for a correction, once — with hint / set-answer", () => {
  const from = uid("correct");

  assert.equal(consumeKbCorrection(from, "salah"), undefined); // no prior KB hit

  noteKbHit(from, "siapa penemu telepon");
  assert.equal(consumeKbCorrection(from, "menarik juga"), undefined); // not a correction
  assert.deepEqual(consumeKbCorrection(from, "salah dong, itu udah lama"), {
    question: "siapa penemu telepon",
    hint: undefined,
  });
  assert.equal(consumeKbCorrection(from, "salah"), undefined); // already consumed

  noteKbHit(from, "q2");
  assert.deepEqual(consumeKbCorrection(from, "salah, harusnya Antonio Meucci"), {
    question: "q2",
    setAnswer: "Antonio Meucci",
  });

  noteKbHit(from, "q3");
  assert.deepEqual(consumeKbCorrection(from, "jawabannya harusnya 42"), { question: "q3", setAnswer: "42" });

  noteKbHit(from, "q4");
  clearKbHit(from);
  assert.equal(consumeKbCorrection(from, "salah"), undefined); // cleared by a non-KB reply
});

test("consumeKbCorrection drops the stale row so the question stops matching", async () => {
  const from = uid("correct-del");
  await seed(from, "siapa penemu bohlam", "Thomas Edison.");
  assert.equal((await lookup(from, "siapa penemu bohlam")).hit, "Thomas Edison.");

  noteKbHit(from, "siapa penemu bohlam");
  assert.deepEqual(consumeKbCorrection(from, "itu udah lama"), { question: "siapa penemu bohlam", hint: undefined });
  assert.equal((await lookup(from, "siapa penemu bohlam")).hit, undefined); // row deleted
});

test("lookupCachedAnswer flags a near-miss when a stored question scores just below threshold", async () => {
  const from = uid("nearmiss");
  await seed(from, "siapa penemu bola lampu pijar", "Thomas Edison.");
  // 4/5 tokens shared -> Jaccard 0.8: below the 0.85 default but inside the band
  const r = await lookup(from, "siapa penemu bola lampu");
  assert.equal(r.hit, undefined);
  assert.equal(r.nearMiss, true);

  // shares almost nothing -> not a near-miss
  const far = await lookup(from, "resep nasi goreng");
  assert.equal(far.hit, undefined);
  assert.notEqual(far.nearMiss, true);
});

test("kbHintsRepo: order-insensitive pair counting, top() filters + ranks", () => {
  const a = `zzhint${Math.random().toString(36).slice(2, 7)}`;
  const b = `zzhint${Math.random().toString(36).slice(2, 7)}`;
  kbHintsRepo.bump(a, b);
  kbHintsRepo.bump(b, a); // same pair, reversed
  kbHintsRepo.bump(a, b);
  const found = kbHintsRepo.top(1, 500).find((h) => (h.a === a || h.a === b) && (h.b === a || h.b === b));
  assert.equal(found?.count, 3);
  // below minCount -> not returned
  const rare = `zzrare${Math.random().toString(36).slice(2, 7)}`;
  kbHintsRepo.bump(rare, "x");
  assert.equal(
    kbHintsRepo.top(3, 500).some((h) => h.a === rare || h.b === rare),
    false
  );
});

test("a text near-miss records a synonym hint for the differing tokens", async () => {
  const from = uid("synhint");
  await seed(from, "sebutkan siapa penemu asli sepeda kayuh", "Karl von Drais.");
  const pair = (h: { a: string; b: string }) =>
    (h.a === "kayuh" && h.b === "angin") || (h.a === "angin" && h.b === "kayuh");
  const before = kbHintsRepo.top(1, 999).find(pair)?.count ?? 0;

  // 5/6 tokens shared -> Jaccard ~0.71 (near-miss); the diff is {kayuh}/{angin}
  await lookup(from, "sebutkan siapa penemu asli sepeda angin");

  assert.equal(kbHintsRepo.top(1, 999).find(pair)?.count ?? 0, before + 1);
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

test("kbStatsRepo aggregates by source, folds nearMiss into model, computes own %", () => {
  // a unique day far in the past so the window catches only this test's rows
  const day = `19${Math.floor(Math.random() * 89) + 10}-06-15`;
  for (let i = 0; i < 3; i++) kbStatsRepo.bump("model", day);
  kbStatsRepo.bump("model_nearmiss", day);
  kbStatsRepo.bump("model_nearmiss", day);
  kbStatsRepo.bump("kb", day);
  kbStatsRepo.bump("kb", day);
  kbStatsRepo.bump("arithmetic", day);
  kbStatsRepo.bump("local", day);

  const s = kbStatsRepo.summary(3, new Date(`${day}T12:00:00+07:00`));
  assert.deepEqual(
    { model: s.model, nearMiss: s.nearMiss, kb: s.kb, arithmetic: s.arithmetic, local: s.local, total: s.total, pct: s.ownPct },
    { model: 5, nearMiss: 2, kb: 2, arithmetic: 1, local: 1, total: 9, pct: 44 } // (2+1+1)/9 = 44.4 -> 44
  );
});

test("clearForNumber wipes a sender's stored interactions", async () => {
  const from = uid("clear");
  await seed(from, "q", "a");
  assert.equal(chatKbRepo.countForNumber(from), 1);
  chatKbRepo.clearForNumber(from);
  assert.equal(chatKbRepo.countForNumber(from), 0);
});
