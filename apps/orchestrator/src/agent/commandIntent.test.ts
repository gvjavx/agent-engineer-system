import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommandIntent, COMMAND_INTENTS } from "./commandIntent.js";
import type { Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: () => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: behavior };
}

test("classifyCommandIntent recognizes each real intent from a well-formatted response", async () => {
  for (const intent of COMMAND_INTENTS) {
    const provider = fakeProvider(async () => ({ type: "text", text: `INTENT: ${intent}` }));
    assert.equal(await classifyCommandIntent("apapun", provider, new AbortController().signal), intent);
  }
});

test("classifyCommandIntent tolerates a noisy response with the line buried in extra text", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "Sure, let me think about this.\nINTENT: stop\nHope that helps!",
  }));
  assert.equal(await classifyCommandIntent("udahan, stop dulu", provider, new AbortController().signal), "stop");
});

test("classifyCommandIntent recognizes a non-technical 'how does this work' question as explain, not help", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "INTENT: explain" }));
  const result = await classifyCommandIntent(
    "jelaskan bagaimana anda membantu saya membuat aplikasi",
    provider,
    new AbortController().signal
  );
  assert.equal(result, "explain");
});

test("classifyCommandIntent recognizes a question about a past conversation as session_history", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "INTENT: session_history" }));
  const result = await classifyCommandIntent("apa chat kita sebelumnya?", provider, new AbortController().signal);
  assert.equal(result, "session_history");
});

test("classifyCommandIntent falls back to none when no line matches the format", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "I'm not sure what you mean." }));
  assert.equal(await classifyCommandIntent("x", provider, new AbortController().signal), "none");
});

test("classifyCommandIntent falls back to none on a tool_calls response", async () => {
  const provider = fakeProvider(async () => ({ type: "tool_calls", calls: [] }));
  assert.equal(await classifyCommandIntent("x", provider, new AbortController().signal), "none");
});

test("classifyCommandIntent falls back to none when the provider throws", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  assert.equal(await classifyCommandIntent("x", provider, new AbortController().signal), "none");
});

test("classifyCommandIntent falls back to none when the model hallucinates a key outside the enum", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "INTENT: delete_everything" }));
  assert.equal(await classifyCommandIntent("x", provider, new AbortController().signal), "none");
});
