import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDepartments } from "./classifier.js";
import type { Provider, ProviderResponse } from "./types.js";

function fakeProvider(behavior: () => Promise<ProviderResponse>): Provider {
  return { name: "fake", chat: behavior };
}

test("classifyDepartments parses well-formatted multi-department responses", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "manajemen: nentuin scope halaman baru\ndev: bikin halaman dan endpointnya\nqa: test halaman barunya",
  }));
  const phases = await classifyDepartments("bikin halaman baru + testnya", provider, new AbortController().signal);
  assert.deepEqual(
    phases.map((p) => p.department),
    ["manajemen", "dev", "qa"]
  );
  assert.equal(phases[1].note, "bikin halaman dan endpointnya");
});

test("classifyDepartments ignores noise around valid lines and dedups repeats", async () => {
  const provider = fakeProvider(async () => ({
    type: "text",
    text: "Here's the plan:\ndev: implement the fix\ndev: implement the fix again\nrandom line with no colon\nqa: verify it works",
  }));
  const phases = await classifyDepartments("fix bug", provider, new AbortController().signal);
  assert.deepEqual(
    phases.map((p) => p.department),
    ["dev", "qa"]
  );
});

test("classifyDepartments falls back to semua when nothing parses", async () => {
  const provider = fakeProvider(async () => ({ type: "text", text: "I'm not sure how to categorize this." }));
  const phases = await classifyDepartments("do something vague", provider, new AbortController().signal);
  assert.deepEqual(phases, [{ department: "semua", note: "do something vague" }]);
});

test("classifyDepartments falls back to semua on tool_calls response or provider error", async () => {
  const toolCallsProvider = fakeProvider(async () => ({ type: "tool_calls", calls: [] }));
  assert.deepEqual(await classifyDepartments("x", toolCallsProvider, new AbortController().signal), [
    { department: "semua", note: "x" },
  ]);

  const throwingProvider = fakeProvider(async () => {
    throw new Error("boom");
  });
  assert.deepEqual(await classifyDepartments("y", throwingProvider, new AbortController().signal), [
    { department: "semua", note: "y" },
  ]);
});
