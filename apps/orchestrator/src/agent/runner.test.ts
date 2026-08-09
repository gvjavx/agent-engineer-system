import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPreferredProvider } from "./runner.js";
import type { Provider } from "./types.js";

function fakeProvider(name: string): Provider {
  return { name, async chat() { return { type: "text", text: "" }; } };
}

test("applyPreferredProvider leaves the chain untouched when nothing is preferred", () => {
  const providers = [fakeProvider("gemini"), fakeProvider("openrouter")];
  const result = applyPreferredProvider(providers, undefined, () => []);
  assert.equal(result, providers);
});

test("applyPreferredProvider moves every key of the preferred provider to the front, as a group", () => {
  // Simulates 3 Gemini keys sitting behind "openrouter" in provider order.
  const providers = [
    fakeProvider("openrouter"),
    fakeProvider("gemini"),
    fakeProvider("gemini"),
    fakeProvider("gemini"),
    fakeProvider("qwen"),
  ];

  const result = applyPreferredProvider(providers, "gemini", () => []);

  assert.deepEqual(
    result.map((p) => p.name),
    ["gemini", "gemini", "gemini", "openrouter", "qwen"]
  );
  // Same instances, not rebuilt, since no model override was given.
  assert.deepEqual(result.slice(0, 3), providers.slice(1, 4));
});

test("applyPreferredProvider rebuilds every key with the override model when one is given", () => {
  const providers = [fakeProvider("gemini"), fakeProvider("gemini"), fakeProvider("openrouter")];
  const rebuilt = [fakeProvider("gemini"), fakeProvider("gemini")];
  let calledWith: { name: string; model: string | undefined } | undefined;

  const result = applyPreferredProvider(providers, "gemini/gemini-3.5-pro", (name, model) => {
    calledWith = { name, model };
    return rebuilt;
  });

  assert.deepEqual(calledWith, { name: "gemini", model: "gemini-3.5-pro" });
  assert.deepEqual(result, [...rebuilt, providers[2]]);
});

test("applyPreferredProvider is a no-op when the preferred provider isn't configured", () => {
  const providers = [fakeProvider("openrouter")];
  const result = applyPreferredProvider(providers, "gemini", () => []);
  assert.equal(result, providers);
});
