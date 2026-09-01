import assert from "node:assert/strict";
import { test } from "node:test";
import { isDuplicateInboundMessage } from "./inboundDedup.js";

// Random suffixes: these hit the real sqlite file (same as every other test
// in this codebase), so ids must not collide across runs.
const uid = (tag: string) => `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("first delivery is not a duplicate; immediate re-deliveries are", () => {
  const id = uid("basic");
  assert.equal(isDuplicateInboundMessage(id), false);
  assert.equal(isDuplicateInboundMessage(id), true);
  assert.equal(isDuplicateInboundMessage(id), true);
});

test("distinct message ids don't collide", () => {
  const a = uid("a");
  const b = uid("b");
  assert.equal(isDuplicateInboundMessage(a), false);
  assert.equal(isDuplicateInboundMessage(b), false);
  assert.equal(isDuplicateInboundMessage(a), true);
});

test("a re-delivery past the dedup window is treated as fresh again", () => {
  const id = uid("window");
  const t0 = 1_700_000_000_000;
  assert.equal(isDuplicateInboundMessage(id, t0), false);
  assert.equal(isDuplicateInboundMessage(id, t0 + 5 * 60 * 1000), true); // 5 min later
  assert.equal(isDuplicateInboundMessage(id, t0 + 2 * 60 * 60 * 1000), false); // 2 h later, row pruned
});
