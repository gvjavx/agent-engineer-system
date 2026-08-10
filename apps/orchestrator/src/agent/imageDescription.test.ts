import assert from "node:assert/strict";
import { test } from "node:test";
import { describeImage } from "./imageDescription.js";
import type { Provider } from "./types.js";

function fakeProvider(name: string, describeImageImpl?: Provider["describeImage"]): Provider {
  return {
    name,
    chat: async () => {
      throw new Error("chat() should not be called by describeImage");
    },
    describeImage: describeImageImpl,
  };
}

test("describeImage returns the first provider's result when it succeeds", async () => {
  const provider = fakeProvider("gemini", async () => "a screenshot of a login form");
  const result = await describeImage("data", "image/jpeg", undefined, [provider], new AbortController().signal);
  assert.equal(result, "a screenshot of a login form");
});

test("describeImage falls through to the next provider when the first throws", async () => {
  const failing = fakeProvider("qwen", async () => {
    throw new Error("model doesn't support vision");
  });
  const working = fakeProvider("gemini", async () => "an error dialog");
  const result = await describeImage("data", "image/jpeg", undefined, [failing, working], new AbortController().signal);
  assert.equal(result, "an error dialog");
});

test("describeImage returns undefined when every provider fails", async () => {
  const a = fakeProvider("qwen", async () => {
    throw new Error("nope");
  });
  const b = fakeProvider("openrouter", async () => {
    throw new Error("nope either");
  });
  const result = await describeImage("data", "image/jpeg", undefined, [a, b], new AbortController().signal);
  assert.equal(result, undefined);
});

test("describeImage returns undefined for an empty providers array", async () => {
  const result = await describeImage("data", "image/jpeg", undefined, [], new AbortController().signal);
  assert.equal(result, undefined);
});

test("describeImage skips a provider without describeImage and tries the next", async () => {
  const noVision = fakeProvider("qwen"); // no describeImage at all
  const withVision = fakeProvider("gemini", async () => "a diagram");
  const result = await describeImage("data", "image/jpeg", undefined, [noVision, withVision], new AbortController().signal);
  assert.equal(result, "a diagram");
});

test("describeImage treats a blank result as a miss and tries the next provider", async () => {
  const blank = fakeProvider("gemini", async () => "   ");
  const working = fakeProvider("openrouter", async () => "a UI mockup");
  const result = await describeImage("data", "image/jpeg", undefined, [blank, working], new AbortController().signal);
  assert.equal(result, "a UI mockup");
});

test("describeImage passes the caption through to the provider's prompt", async () => {
  let seenPrompt = "";
  const provider = fakeProvider("gemini", async (_data, _mime, prompt) => {
    seenPrompt = prompt;
    return "ok";
  });
  await describeImage("data", "image/jpeg", "perbaiki tombol ini", [provider], new AbortController().signal);
  assert.match(seenPrompt, /perbaiki tombol ini/);
});
