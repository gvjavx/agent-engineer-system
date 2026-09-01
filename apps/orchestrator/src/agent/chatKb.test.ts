import assert from "node:assert/strict";
import { test } from "node:test";
import { recordInteraction, lookupCachedAnswer, backfillNullEmbeddings } from "./chatKb.js";
import { chatKbRepo } from "../db/chatKb.js";
import type { EmbeddingProvider } from "./rag/index.js";

const uid = (tag: string) => `kbtest-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Keyword-count vectors so two texts sharing words score high and disjoint
// texts score 0 — enough to exercise the match threshold deterministically.
const KW = ["sepeda", "penemu", "menemukan", "mobil", "ibukota", "australia", "kapan", "siapa", "apa", "ditemukan"];
function fakeEmbedder(): EmbeddingProvider & { calls: number } {
  const e = {
    calls: 0,
    name: "fake",
    model: "fake",
    identity: "fake@10",
    async embed(texts: string[]) {
      e.calls += texts.length;
      return texts.map((t) => {
        const lo = t.toLowerCase();
        return Float32Array.from(KW.map((k) => (lo.includes(k) ? 1 : 0)));
      });
    },
  };
  return e;
}

test("recordInteraction is a no-op when the KB is disabled", async () => {
  const from = uid("disabled");
  await recordInteraction({ fromNumber: from, kind: "chat_model", question: "q", answer: "a" }, { enabled: false });
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
  assert.equal(rows[0].embedding.length, KW.length);
  assert.ok([...rows[0].embedding].some((x) => x === 1)); // "kapan" hit
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

test("lookupCachedAnswer returns a stored answer for a near-identical question, and just the vector otherwise", async () => {
  const from = uid("lookup");
  const embedder = fakeEmbedder();
  await recordInteraction(
    { fromNumber: from, kind: "chat_model", question: "siapa penemu sepeda?", answer: "Karl von Drais, 1817." },
    { enabled: true, embedder }
  );

  // same words -> cosine 1.0 -> above threshold
  const hit = await lookupCachedAnswer({ fromNumber: from, question: "siapa penemu sepeda" }, { enabled: true, embedder });
  assert.equal(hit.hit, "Karl von Drais, 1817.");
  assert.ok(hit.queryVector instanceof Float32Array);

  // disjoint words -> cosine 0 -> below threshold: no hit, but the computed
  // vector comes back so recording can reuse it
  const miss = await lookupCachedAnswer(
    { fromNumber: from, question: "apa ibukota australia" },
    { enabled: true, embedder }
  );
  assert.equal(miss.hit, undefined);
  assert.ok(miss.queryVector instanceof Float32Array);

  // a different question about the same topic ("kapan" vs "siapa") shares
  // "sepeda" but not enough -> still a miss at the default 0.95 threshold
  const nearMiss = await lookupCachedAnswer(
    { fromNumber: from, question: "kapan sepeda ditemukan" },
    { enabled: true, embedder }
  );
  assert.equal(nearMiss.hit, undefined);
});

test("lookupCachedAnswer returns an empty result when disabled or without an embedder", async () => {
  const from = uid("lookup-guards");
  const embedder = fakeEmbedder();
  await recordInteraction(
    { fromNumber: from, kind: "chat_model", question: "siapa penemu sepeda?", answer: "x" },
    { enabled: true, embedder }
  );
  assert.deepEqual(await lookupCachedAnswer({ fromNumber: from, question: "siapa penemu sepeda" }, { enabled: false, embedder }), {});
  assert.deepEqual(
    await lookupCachedAnswer({ fromNumber: from, question: "siapa penemu sepeda" }, { enabled: true, embedder: null }),
    {}
  );
  // empty store: no hit, but still hands back the vector
  const empty = await lookupCachedAnswer({ fromNumber: uid("empty"), question: "apa pun" }, { enabled: true, embedder });
  assert.equal(empty.hit, undefined);
  assert.ok(empty.queryVector instanceof Float32Array);
});

test("recordInteraction with a precomputed vector skips the embedding call", async () => {
  const from = uid("precomp");
  const embedder = fakeEmbedder();
  await recordInteraction(
    {
      fromNumber: from,
      kind: "chat_model",
      question: "q",
      answer: "a",
      precomputedVector: Float32Array.from(new Array(KW.length).fill(0.5)),
    },
    { enabled: true, embedder }
  );
  assert.equal(embedder.calls, 0);
  const rows = chatKbRepo.embeddedForNumber(from);
  assert.equal(rows.length, 1);
  assert.deepEqual([...rows[0].embedding], new Array(KW.length).fill(0.5));
});

test("backfillNullEmbeddings fills in rows a past failure left without a vector", async () => {
  const from = uid("backfill");
  // record with a null embedder -> row saved, no vector
  await recordInteraction(
    { fromNumber: from, kind: "chat_model", question: "siapa penemu sepeda?", answer: "Karl." },
    { enabled: true, embedder: null }
  );
  assert.equal(chatKbRepo.embeddedForNumber(from).length, 0);

  await backfillNullEmbeddings(from, fakeEmbedder());
  assert.equal(chatKbRepo.embeddedForNumber(from).length, 1);
});
