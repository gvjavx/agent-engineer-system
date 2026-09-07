import assert from "node:assert/strict";
import { test } from "node:test";
import { refineImagePrompt, stripImageInstruction, isImageTweak } from "./imagePrompt.js";
import type { Provider, ProviderResponse } from "./types.js";

const sig = () => new AbortController().signal;

test("stripImageInstruction drops the leading buatkan-gambar phrasing", () => {
  assert.equal(stripImageInstruction("buatkan gambar pohon"), "pohon");
  assert.equal(stripImageInstruction("bikinin aku ilustrasi kucing lucu"), "kucing lucu");
  assert.equal(stripImageInstruction("gambarin sunset di pantai"), "sunset di pantai");
  assert.equal(stripImageInstruction("tolong buat logo warung kopi"), "warung kopi");
});

test("stripImageInstruction keeps text that has no instruction prefix", () => {
  assert.equal(stripImageInstruction("pohon beringin tua"), "pohon beringin tua");
});

test("stripImageInstruction doesn't eat into the subject word", () => {
  assert.equal(stripImageInstruction("buatkan gambar sepeda"), "sepeda");
  assert.equal(stripImageInstruction("buat gambar seekor gajah"), "seekor gajah");
});

test("refineImagePrompt uses the model's English prompt, stripped of wrapping quotes", async () => {
  const provider: Provider = {
    name: "fake",
    chat: async () =>
      ({ type: "text", text: '"A lone tree in a golden field, warm sunset light, photorealistic"' }) satisfies ProviderResponse,
  };
  assert.equal(
    await refineImagePrompt("buatkan gambar pohon", provider, sig()),
    "A lone tree in a golden field, warm sunset light, photorealistic"
  );
});

test("refineImagePrompt falls back to the stripped request on model failure or no provider", async () => {
  const throwing: Provider = {
    name: "fake",
    chat: async () => {
      throw new Error("down");
    },
  };
  assert.equal(await refineImagePrompt("buatkan gambar pohon", throwing, sig()), "pohon");
  assert.equal(await refineImagePrompt("buatkan gambar pohon", undefined, sig()), "pohon");
});

test("refineImagePrompt falls back when the model returns a non-text or empty reply", async () => {
  const toolCalls: Provider = { name: "f", chat: async () => ({ type: "tool_calls", calls: [] }) };
  assert.equal(await refineImagePrompt("gambarin kucing", toolCalls, sig()), "kucing");

  const blank: Provider = { name: "f", chat: async () => ({ type: "text", text: "   " }) };
  assert.equal(await refineImagePrompt("gambarin kucing", blank, sig()), "kucing");
});

test("isImageTweak recognizes short modifier phrases, rejects fresh requests and long text", () => {
  for (const s of [
    "bikin yang lebih gelap",
    "lebih cerah dong",
    "buat lebih gelap",
    "tambahin pohon di belakang",
    "ganti warnanya jadi biru",
    "tanpa background",
    "jadikan hitam putih",
    "coba lebih zoom",
  ]) {
    assert.equal(isImageTweak(s), true, s);
  }
  for (const s of [
    "buatkan gambar mobil merah",
    "bikin ilustrasi kucing",
    "tambahin fitur login di halaman dashboard aplikasi yang kemarin itu ya",
    "kenapa error terus",
  ]) {
    assert.equal(isImageTweak(s), false, s);
  }
});

test("refineImagePrompt merges a tweak onto the previous prompt", async () => {
  let seenPrompt = "";
  const provider: Provider = {
    name: "f",
    chat: async (messages) => {
      seenPrompt = String(messages[0].content);
      return { type: "text", text: "A red car at night, dark moody lighting, photorealistic" } satisfies ProviderResponse;
    },
  };
  const out = await refineImagePrompt("bikin lebih gelap", provider, sig(), "A red car in daylight, photorealistic");
  assert.match(seenPrompt, /A red car in daylight, photorealistic/);
  assert.match(seenPrompt, /bikin lebih gelap/);
  assert.equal(out, "A red car at night, dark moody lighting, photorealistic");
});

test("refineImagePrompt tweak fallback keeps the previous prompt plus the stripped change", async () => {
  const throwing: Provider = {
    name: "f",
    chat: async () => {
      throw new Error("down");
    },
  };
  assert.equal(
    await refineImagePrompt("tambahin sungai di belakang", throwing, sig(), "A lone tree in a field"),
    "A lone tree in a field, tambahin sungai di belakang"
  );
});
