import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyIntent, INTENTS } from "./commandIntent.js";
import type { Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: () => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: behavior };
}

test("classifyIntent recognizes each real intent from a well-formatted response", async () => {
  for (const intent of INTENTS) {
    const provider = fakeProvider(async () => ({ type: "text", text: `INTENT: ${intent}` }));
    assert.equal(await classifyIntent("apapun", provider, new AbortController().signal), intent);
  }
});

test("classifyIntent tolerates a noisy response with the line buried in extra text", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "Sure, let me think about this.\nINTENT: stop\nHope that helps!",
  }));
  assert.equal(await classifyIntent("udahan, stop dulu", provider, new AbortController().signal), "stop");
});

test("classifyIntent recognizes a non-technical 'how does this work' question as explain, not help", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "INTENT: explain" }));
  const result = await classifyIntent(
    "jelaskan bagaimana anda membantu saya membuat aplikasi",
    provider,
    new AbortController().signal
  );
  assert.equal(result, "explain");
});

test("classifyIntent recognizes a question about a past conversation as session_history", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "INTENT: session_history" }));
  const result = await classifyIntent("apa chat kita sebelumnya?", provider, new AbortController().signal);
  assert.equal(result, "session_history");
});

test("classifyIntent adds the recent-image guidance to the prompt only when recentImage is set", async () => {
  const prompts: string[] = [];
  const provider: Provider = {
    name: "fake",
    chat: async (messages) => {
      prompts.push(String(messages[0].content));
      return { type: "text", text: "INTENT: generate_image" };
    },
  };
  await classifyIntent("bikin yang lebih gelap", provider, new AbortController().signal, { recentImage: true });
  await classifyIntent("bikin yang lebih gelap", provider, new AbortController().signal);
  assert.match(prompts[0], /just generated an image/);
  assert.doesNotMatch(prompts[1], /just generated an image/);
});

test("classifyIntent recognizes small talk as chat, not a fixed command or task", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "INTENT: chat" }));
  const result = await classifyIntent("gimana menurutmu soal ini", provider, new AbortController().signal);
  assert.equal(result, "chat");
});

test("classifyIntent recognizes a build/fix request as task", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "INTENT: task" }));
  const result = await classifyIntent("tambahin dark mode dong", provider, new AbortController().signal);
  assert.equal(result, "task");
});

test("classifyIntent falls back to task when no line matches the format", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "I'm not sure what you mean." }));
  assert.equal(await classifyIntent("x", provider, new AbortController().signal), "task");
});

test("classifyIntent takes a parseable local answer, skipping the vendor", async () => {
  let vendorCalls = 0;
  const provider = fakeProvider(async () => {
    vendorCalls++;
    return { type: "text", text: "INTENT: task" };
  });
  const out = await classifyIntent("halo", provider, new AbortController().signal, {
    localEnabled: true,
    localGen: async () => "INTENT: greeting",
  });
  assert.equal(out, "greeting");
  assert.equal(vendorCalls, 0);
});

test("classifyIntent falls through to the vendor when the local answer doesn't parse", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "INTENT: chat" }));
  const out = await classifyIntent("gimana menurutmu", provider, new AbortController().signal, {
    localEnabled: true,
    localGen: async () => "hmm hard to say",
  });
  assert.equal(out, "chat");
});

// The fail-closed property that must never regress: neither of these failure
// modes may ever resolve to a fixed command or "chat" and skip the real task
// pipeline.
test("classifyIntent falls back to task on a tool_calls response", async () => {
  const provider = fakeProvider(async () => ({ type: "tool_calls", calls: [] }));
  assert.equal(await classifyIntent("x", provider, new AbortController().signal), "task");
});

test("classifyIntent falls back to task when the provider throws", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  assert.equal(await classifyIntent("x", provider, new AbortController().signal), "task");
});

test("classifyIntent falls back to task when the model hallucinates a key outside the enum", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "INTENT: delete_everything" }));
  assert.equal(await classifyIntent("x", provider, new AbortController().signal), "task");
});
