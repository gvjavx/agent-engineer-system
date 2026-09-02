import assert from "node:assert/strict";
import { test } from "node:test";
import { runClassifier } from "./localClassifier.js";
import type { Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: () => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: behavior };
}

const parseKey = (t: string): { value: string } | undefined => {
  const m = t.match(/^KEY:\s*(\w+)$/m);
  return m ? { value: m[1] } : undefined;
};

test("runClassifier uses the vendor when the local model is disabled", async () => {
  let vendorCalls = 0;
  const provider = fakeProvider(async () => {
    vendorCalls++;
    return { type: "text", text: "KEY: fromvendor" };
  });
  const out = await runClassifier({
    prompt: "p",
    provider,
    signal: new AbortController().signal,
    parse: parseKey,
    fallback: "fb",
    opts: { localEnabled: false },
  });
  assert.equal(out, "fromvendor");
  assert.equal(vendorCalls, 1);
});

test("runClassifier keeps a parseable local answer and never calls the vendor", async () => {
  let vendorCalls = 0;
  const provider = fakeProvider(async () => {
    vendorCalls++;
    return { type: "text", text: "KEY: fromvendor" };
  });
  const out = await runClassifier({
    prompt: "p",
    provider,
    signal: new AbortController().signal,
    parse: parseKey,
    fallback: "fb",
    opts: { localEnabled: true, localGen: async () => "KEY: fromlocal" },
  });
  assert.equal(out, "fromlocal");
  assert.equal(vendorCalls, 0);
});

test("runClassifier falls through to the vendor when the local answer doesn't parse", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "KEY: fromvendor" }));
  const out = await runClassifier({
    prompt: "p",
    provider,
    signal: new AbortController().signal,
    parse: parseKey,
    fallback: "fb",
    opts: { localEnabled: true, localGen: async () => "i have no idea what to do here" },
  });
  assert.equal(out, "fromvendor");
});

test("runClassifier falls through to the vendor when the local model throws or returns nothing", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "KEY: fromvendor" }));
  const base = {
    prompt: "p",
    provider,
    signal: new AbortController().signal,
    parse: parseKey,
    fallback: "fb",
  };
  assert.equal(
    await runClassifier({ ...base, opts: { localEnabled: true, localGen: async () => undefined } }),
    "fromvendor"
  );
  assert.equal(
    await runClassifier({
      ...base,
      opts: {
        localEnabled: true,
        localGen: async () => {
          throw new Error("model load failed");
        },
      },
    }),
    "fromvendor"
  );
});

test("runClassifier returns the fallback when both the local model and the vendor fail to parse", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "nonsense" }));
  const out = await runClassifier({
    prompt: "p",
    provider,
    signal: new AbortController().signal,
    parse: parseKey,
    fallback: "fb",
    opts: { localEnabled: true, localGen: async () => "also nonsense" },
  });
  assert.equal(out, "fb");
});

test("runClassifier keeps a local result whose parsed value is undefined without hitting the vendor", async () => {
  let vendorCalls = 0;
  const provider = fakeProvider(async () => {
    vendorCalls++;
    return { type: "text", text: "KEY: fromvendor" };
  });
  // Mirrors requestClarity: "CLARIFY: tidak" is a real answer of "no question".
  const out = await runClassifier<string | undefined>({
    prompt: "p",
    provider,
    signal: new AbortController().signal,
    parse: (t) => (t.includes("NONE") ? { value: undefined } : undefined),
    fallback: undefined,
    opts: { localEnabled: true, localGen: async () => "NONE" },
  });
  assert.equal(out, undefined);
  assert.equal(vendorCalls, 0);
});
