import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyMessageKind, MESSAGE_KINDS } from "./messageKind.js";
import type { Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: () => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: behavior };
}

test("classifyMessageKind recognizes each kind from a well-formatted response", async () => {
  for (const kind of MESSAGE_KINDS) {
    const provider = fakeProvider(async () => ({ type: "text", text: `KIND: ${kind}` }));
    assert.equal(await classifyMessageKind("apapun", provider, new AbortController().signal), kind);
  }
});

test("classifyMessageKind tolerates a noisy response with the line buried in extra text", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "Hmm, let me think...\nKIND: chat\nThat's my read on it.",
  }));
  assert.equal(await classifyMessageKind("gimana menurutmu soal ini", provider, new AbortController().signal), "chat");
});

test("classifyMessageKind falls back to task when no line matches the format", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "Not sure." }));
  assert.equal(await classifyMessageKind("x", provider, new AbortController().signal), "task");
});

// The fail-closed property that must never regress: neither of these
// failure modes may ever resolve to "chat" and skip the task pipeline.
test("classifyMessageKind falls back to task on a tool_calls response", async () => {
  const provider = fakeProvider(async () => ({ type: "tool_calls", calls: [] }));
  assert.equal(await classifyMessageKind("x", provider, new AbortController().signal), "task");
});

test("classifyMessageKind falls back to task when the provider throws", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  assert.equal(await classifyMessageKind("x", provider, new AbortController().signal), "task");
});
