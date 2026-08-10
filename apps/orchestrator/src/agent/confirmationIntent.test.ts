import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyConfirmationIntent, CONFIRMATION_INTENTS } from "./confirmationIntent.js";
import type { Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: () => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: behavior };
}

test("classifyConfirmationIntent recognizes each intent from a well-formatted response", async () => {
  for (const intent of CONFIRMATION_INTENTS) {
    const provider = fakeProvider(async () => ({ type: "text", text: `ANSWER: ${intent}` }));
    assert.equal(await classifyConfirmationIntent("apapun", provider, new AbortController().signal), intent);
  }
});

test("classifyConfirmationIntent tolerates a noisy response with the line buried in extra text", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "Let me see...\nANSWER: yes\nGlad to help.",
  }));
  assert.equal(await classifyConfirmationIntent("gas aja", provider, new AbortController().signal), "yes");
});

test("classifyConfirmationIntent falls back to unclear when no line matches the format", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "Not sure what they meant." }));
  assert.equal(await classifyConfirmationIntent("x", provider, new AbortController().signal), "unclear");
});

// The fail-closed property that must never regress: neither of these
// failure modes may ever resolve to "yes".
test("classifyConfirmationIntent falls back to unclear on a tool_calls response", async () => {
  const provider = fakeProvider(async () => ({ type: "tool_calls", calls: [] }));
  assert.equal(await classifyConfirmationIntent("x", provider, new AbortController().signal), "unclear");
});

test("classifyConfirmationIntent falls back to unclear when the provider throws", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  assert.equal(await classifyConfirmationIntent("x", provider, new AbortController().signal), "unclear");
});
