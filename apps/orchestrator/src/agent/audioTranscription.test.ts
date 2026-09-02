import assert from "node:assert/strict";
import { test } from "node:test";
import { transcribeVoiceNote } from "./audioTranscription.js";
import type { Provider } from "./types.js";

function fakeProvider(name: string, impl?: Provider["transcribeAudio"]): Provider {
  return {
    name,
    chat: async () => {
      throw new Error("chat() should not be called by transcribeVoiceNote");
    },
    transcribeAudio: impl,
  };
}

const sig = () => new AbortController().signal;

test("transcribeVoiceNote returns the first working provider's transcript", async () => {
  const p = fakeProvider("gemini", async () => "tolong tambahin dark mode");
  assert.equal(await transcribeVoiceNote("d", "audio/ogg", [p], sig()), "tolong tambahin dark mode");
});

test("transcribeVoiceNote skips providers that can't do audio, then falls through on throw/blank", async () => {
  const noAudio = fakeProvider("qwen");
  const throwing = fakeProvider("openrouter", async () => {
    throw new Error("no audio support");
  });
  const blank = fakeProvider("gemini-1", async () => "  ");
  const working = fakeProvider("gemini-2", async () => "cek error di halaman login");
  assert.equal(
    await transcribeVoiceNote("d", "audio/ogg", [noAudio, throwing, blank, working], sig()),
    "cek error di halaman login"
  );
});

test("transcribeVoiceNote returns undefined when nothing can transcribe", async () => {
  assert.equal(await transcribeVoiceNote("d", "audio/ogg", [], sig()), undefined);
  assert.equal(await transcribeVoiceNote("d", "audio/ogg", [fakeProvider("qwen")], sig()), undefined);
});
