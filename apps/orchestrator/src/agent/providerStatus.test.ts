import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProviderStatus } from "./providerStatus.js";
import type { Provider, ProviderResponse } from "./types.js";
import { ProviderError } from "./types.js";

function fakeProvider(
  behavior: () => Promise<ProviderResponse>,
  name = "fake"
): Provider {
  return { name, chat: behavior };
}

test("checkProviderStatus reports ok when the provider responds", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "pong" }));
  const status = await checkProviderStatus(provider);
  assert.deepEqual(status, { state: "ok" });
});

test("checkProviderStatus classifies 429/quota errors as rate_limited", async () => {
  const provider = fakeProvider(async () => {
    throw new ProviderError("fake", '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
  });
  const status = await checkProviderStatus(provider);
  assert.equal(status.state, "rate_limited");
});

test("checkProviderStatus classifies other failures as error", async () => {
  const provider = fakeProvider(async () => {
    throw new ProviderError("fake", "401 Unauthorized");
  });
  const status = await checkProviderStatus(provider);
  assert.equal(status.state, "error");
});
