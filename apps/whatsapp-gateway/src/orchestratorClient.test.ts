import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardToOrchestrator } from "./orchestratorClient.js";
import type { InboundMessage } from "./whatsapp.js";

const message: InboundMessage = { from: "628123", text: "halo", waMessageId: "wamid.1", timestamp: "0" };

test("forwardToOrchestrator succeeds on the first try without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  try {
    await forwardToOrchestrator(message, undefined, 0);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwardToOrchestrator retries once after a network error and succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  try {
    await forwardToOrchestrator(message, undefined, 0);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwardToOrchestrator retries once after a non-ok response and succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(calls === 1 ? "server error" : null, { status: calls === 1 ? 500 : 202 });
  }) as typeof fetch;
  try {
    await forwardToOrchestrator(message, undefined, 0);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwardToOrchestrator throws after both attempts fail", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  try {
    await assert.rejects(() => forwardToOrchestrator(message, undefined, 0));
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
