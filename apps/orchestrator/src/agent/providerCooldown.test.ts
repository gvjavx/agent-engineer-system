import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  markRateLimited,
  isCoolingDown,
  cooldownRemainingMs,
  deprioritizeCooledDown,
  coolingDownNow,
  clearCooldownsForTests,
} from "./providerCooldown.js";

beforeEach(() => clearCooldownsForTests());

test("markRateLimited parks an id and it clears once the window passes", () => {
  markRateLimited("gemini@m#aaaa", 40);
  assert.equal(isCoolingDown("gemini@m#aaaa"), true);
  assert.ok(cooldownRemainingMs("gemini@m#aaaa") > 0);
  assert.equal(isCoolingDown("other"), false);
});

test("cooldown window is clamped to a sane floor even for a tiny retryAfter", () => {
  markRateLimited("x", 1);
  assert.ok(cooldownRemainingMs("x") >= 4_000, "clamped up to the 5s floor");
});

test("deprioritizeCooledDown moves parked instances to the back, order otherwise intact", () => {
  const providers = [
    { name: "gemini", id: "gemini@a#1" },
    { name: "gemini", id: "gemini@a#2" },
    { name: "qwen", id: "qwen@c#3" },
    { name: "openrouter", id: "openrouter@d#4" },
  ];
  markRateLimited("gemini@a#1");
  markRateLimited("qwen@c#3");
  const out = deprioritizeCooledDown(providers).map((p) => p.id);
  assert.deepEqual(out, ["gemini@a#2", "openrouter@d#4", "gemini@a#1", "qwen@c#3"]);
});

test("deprioritizeCooledDown falls back to keying on name when a provider has no id", () => {
  markRateLimited("gemini");
  const out = deprioritizeCooledDown([{ name: "gemini" }, { name: "qwen" }]).map((p) => p.name);
  assert.deepEqual(out, ["qwen", "gemini"]);
});

test("coolingDownNow lists parked ids longest-remaining first", () => {
  markRateLimited("short", 6_000);
  markRateLimited("long", 120_000);
  const ids = coolingDownNow().map((c) => c.id);
  assert.deepEqual(ids, ["long", "short"]);
  assert.ok(coolingDownNow().every((c) => c.secondsLeft > 0));
});
