import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNeedsClarification } from "./requestClarity.js";
import type { Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: () => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: behavior };
}

test("checkNeedsClarification returns undefined when the model says CLARIFY: tidak", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "CLARIFY: tidak" }));
  const result = await checkNeedsClarification("tambahin dark mode di halaman settings", provider, new AbortController().signal);
  assert.equal(result, undefined);
});

test("checkNeedsClarification returns the question when the model flags it as vague", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "CLARIFY: Websitenya buat apa nih, dan tujuannya apa?",
  }));
  const result = await checkNeedsClarification("bantu saya membuat website", provider, new AbortController().signal);
  assert.equal(result, "Websitenya buat apa nih, dan tujuannya apa?");
});

test("checkNeedsClarification tolerates a noisy response with the line buried in extra text", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "Hmm, let me think.\nCLARIFY: Mau bikin toko online atau portofolio?\nSemoga membantu.",
  }));
  const result = await checkNeedsClarification("bikin aplikasi dong", provider, new AbortController().signal);
  assert.equal(result, "Mau bikin toko online atau portofolio?");
});

test("checkNeedsClarification returns undefined when no line matches the format", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "Not sure what you mean." }));
  const result = await checkNeedsClarification("x", provider, new AbortController().signal);
  assert.equal(result, undefined);
});

test("checkNeedsClarification honours a local 'CLARIFY: tidak' without calling the vendor", async () => {
  let vendorCalls = 0;
  const provider = fakeProvider(async () => {
    vendorCalls++;
    return { type: "text", text: "CLARIFY: kepo dulu dong maunya apa" };
  });
  const result = await checkNeedsClarification("tambahin dark mode di settings", provider, new AbortController().signal, {
    localEnabled: true,
    localGen: async () => "CLARIFY: tidak",
  });
  assert.equal(result, undefined);
  assert.equal(vendorCalls, 0);
});

test("checkNeedsClarification falls through to the vendor when the local reply has no CLARIFY line", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "CLARIFY: tidak" }));
  const result = await checkNeedsClarification("bikin toko online sepatu", provider, new AbortController().signal, {
    localEnabled: true,
    localGen: async () => "sepertinya cukup jelas",
  });
  assert.equal(result, undefined);
});

// The fail-open property that must never regress: none of these failure
// modes may ever block a real task from being planned.
test("checkNeedsClarification returns undefined on a tool_calls response", async () => {
  const provider = fakeProvider(async () => ({ type: "tool_calls", calls: [] }));
  const result = await checkNeedsClarification("x", provider, new AbortController().signal);
  assert.equal(result, undefined);
});

test("checkNeedsClarification returns undefined when the provider throws", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  const result = await checkNeedsClarification("x", provider, new AbortController().signal);
  assert.equal(result, undefined);
});
