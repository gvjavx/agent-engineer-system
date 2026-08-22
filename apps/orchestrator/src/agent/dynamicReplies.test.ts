import assert from "node:assert/strict";
import { test } from "node:test";
import { introduceYourself, explainHelp, explainInSimpleTerms } from "./dynamicReplies.js";
import type { Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: () => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: behavior };
}

function capturingProvider(): { provider: Provider; getPrompt: () => string } {
  let seenPrompt = "";
  const provider: Provider = {
    name: "fake",
    chat: async (messages) => {
      seenPrompt = messages[0]?.content ?? "";
      return { type: "text", text: "ok" };
    },
  };
  return { provider, getPrompt: () => seenPrompt };
}

test("introduceYourself returns the provider's answer on success", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "Aku Mas ADE, bantuin kamu bikin aplikasi." }));
  const result = await introduceYourself("kamu siapa sih sebenernya", provider, new AbortController().signal);
  assert.equal(result, "Aku Mas ADE, bantuin kamu bikin aplikasi.");
});

test("introduceYourself returns undefined when the provider throws", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  const result = await introduceYourself("kamu siapa", provider, new AbortController().signal);
  assert.equal(result, undefined);
});

test("explainHelp includes the actual command reference in the prompt, not restated from memory", async () => {
  const { provider, getPrompt } = capturingProvider();
  await explainHelp("gimana cara ganti model AI-nya?", "- *pakai model <nama>* — ganti model default", provider, new AbortController().signal);
  assert.match(getPrompt(), /pakai model <nama>/);
});

test("explainHelp returns the provider's answer on success", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "Ketik pakai model <nama> buat ganti." }));
  const result = await explainHelp("gimana ganti model?", "- *pakai model <nama>*", provider, new AbortController().signal);
  assert.equal(result, "Ketik pakai model <nama> buat ganti.");
});

test("explainHelp returns undefined for a blank response", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "   " }));
  const result = await explainHelp("apa aja perintahnya?", "- *bantuan*", provider, new AbortController().signal);
  assert.equal(result, undefined);
});

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
  const { provider, getPrompt } = capturingProvider();
  await explainInSimpleTerms("berapa lama biasanya prosesnya?", provider, new AbortController().signal);
  assert.match(getPrompt(), /berapa lama biasanya prosesnya\?/);
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
