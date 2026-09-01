import assert from "node:assert/strict";
import { test } from "node:test";
import { recordInteraction, lookupCachedAnswer } from "./chatKb.js";
import { chatKbRepo, normalizeQuestion } from "../db/chatKb.js";

// Random suffixes: these hit the real sqlite file (same as every other test
// in this codebase), so from_numbers must not collide across runs.
const uid = (tag: string) => `kbtest-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function seed(from: string, question: string, answer: string): Promise<void> {
  await recordInteraction({ fromNumber: from, kind: "chat_model", question, answer }, { enabled: true });
}
const lookup = (from: string, question: string) => lookupCachedAnswer({ fromNumber: from, question }, { enabled: true });

test("normalizeQuestion strips case, punctuation and repeated spaces", () => {
  assert.equal(normalizeQuestion("Kapan Hari Kemerdekaan Indonesia?"), "kapan hari kemerdekaan indonesia");
  assert.equal(normalizeQuestion("  siapa   penemu, sepeda!!  "), "siapa penemu sepeda");
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

test("lookupCachedAnswer tolerates one dropped filler word, but not a different question", async () => {
  const from = uid("fuzzy");
  await seed(from, "siapa sih penemu sepeda itu", "Karl von Drais.");

  // 3 of 5 tokens shared -> Jaccard 0.6, below the 0.85 default -> miss
  assert.equal((await lookup(from, "siapa penemu sepeda")).hit, undefined);
  // exact tokens -> hit
  assert.equal((await lookup(from, "siapa sih penemu sepeda itu?")).hit, "Karl von Drais.");
  // different question, same topic -> miss
  assert.equal((await lookup(from, "kapan sepeda ditemukan")).hit, undefined);
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

test("clearForNumber wipes a sender's stored interactions", async () => {
  const from = uid("clear");
  await seed(from, "q", "a");
  assert.equal(chatKbRepo.countForNumber(from), 1);
  chatKbRepo.clearForNumber(from);
  assert.equal(chatKbRepo.countForNumber(from), 0);
});
