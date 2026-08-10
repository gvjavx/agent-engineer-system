import assert from "node:assert/strict";
import { test } from "node:test";
import { explainInSimpleTerms } from "./explainAssistant.js";
import type { Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: () => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: behavior };
}

test("explainInSimpleTerms returns the provider's answer on success", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "Jadi gini, aku bakal mulai kerja setelah kamu bilang oke.",
  }));
  const result = await explainInSimpleTerms(
    "apa step step yang akan anda lakukan setelah saya menjelaskannya?",
    provider,
    new AbortController().signal
  );
  assert.equal(result, "Jadi gini, aku bakal mulai kerja setelah kamu bilang oke.");
});

test("explainInSimpleTerms includes the actual question in the prompt sent to the provider", async () => {
  let seenPrompt = "";
  const capturingProvider: Provider = {
    name: "fake",
    chat: async (messages) => {
      seenPrompt = messages[0]?.content ?? "";
      return { type: "text", text: "ok" };
    },
  };
  await explainInSimpleTerms("berapa lama biasanya prosesnya?", capturingProvider, new AbortController().signal);
  assert.match(seenPrompt, /berapa lama biasanya prosesnya\?/);
});

test("explainInSimpleTerms returns undefined on a tool_calls response", async () => {
  const provider = fakeProvider(async () => ({ type: "tool_calls", calls: [] }));
  const result = await explainInSimpleTerms("gimana cara kerjanya?", provider, new AbortController().signal);
  assert.equal(result, undefined);
});

test("explainInSimpleTerms returns undefined when the provider throws", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  const result = await explainInSimpleTerms("gimana cara kerjanya?", provider, new AbortController().signal);
  assert.equal(result, undefined);
});

test("explainInSimpleTerms returns undefined for a blank response", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "   " }));
  const result = await explainInSimpleTerms("gimana cara kerjanya?", provider, new AbortController().signal);
  assert.equal(result, undefined);
});
