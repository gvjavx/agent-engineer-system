import assert from "node:assert/strict";
import { test } from "node:test";
import { generateImageFromPrompt } from "./imageGeneration.js";
import type { Provider } from "./types.js";

function fakeProvider(name: string, impl?: Provider["generateImage"]): Provider {
  return {
    name,
    chat: async () => {
      throw new Error("chat() should not be called by generateImageFromPrompt");
    },
    generateImage: impl,
  };
}

const sig = () => new AbortController().signal;

test("generateImageFromPrompt returns the first working provider's image", async () => {
  const p = fakeProvider("gemini", async () => ({ base64: "aW1n", mimeType: "image/png" }));
  assert.deepEqual(await generateImageFromPrompt("pohon", [p], sig()), {
    ok: true,
    base64: "aW1n",
    mimeType: "image/png",
  });
});

test("generateImageFromPrompt skips providers that can't do images, then falls through on throw/blank", async () => {
  const noImage = fakeProvider("qwen");
  const throwing = fakeProvider("openrouter", async () => {
    throw new Error("no image support");
  });
  const blank = fakeProvider("gemini-1", async () => ({ base64: "", mimeType: "image/png" }));
  const working = fakeProvider("gemini-2", async () => ({ base64: "b2s", mimeType: "image/jpeg" }));
  assert.deepEqual(await generateImageFromPrompt("pohon", [noImage, throwing, blank, working], sig()), {
    ok: true,
    base64: "b2s",
    mimeType: "image/jpeg",
  });
});

test("generateImageFromPrompt reports why it failed, per capable provider", async () => {
  const res = await generateImageFromPrompt(
    "pohon",
    [
      fakeProvider("qwen"),
      fakeProvider("gemini", async () => {
        throw new Error("404 model not found");
      }),
    ],
    sig()
  );
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /gemini: 404 model not found/);
});

test("generateImageFromPrompt: no image-capable provider at all", async () => {
  const res = await generateImageFromPrompt("pohon", [fakeProvider("qwen")], sig());
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /gak ada model/);
});
