import assert from "node:assert/strict";
import { test } from "node:test";
import { isDuplicateInboundMessage } from "./inboundDedup.js";

test("isDuplicateInboundMessage is false the first time an id is seen", () => {
  assert.equal(isDuplicateInboundMessage("wamid.first-seen"), false);
});

test("isDuplicateInboundMessage is true on a repeat of the same id", () => {
  assert.equal(isDuplicateInboundMessage("wamid.repeat"), false);
  assert.equal(isDuplicateInboundMessage("wamid.repeat"), true);
  assert.equal(isDuplicateInboundMessage("wamid.repeat"), true);
});

test("isDuplicateInboundMessage treats different ids independently", () => {
  assert.equal(isDuplicateInboundMessage("wamid.a"), false);
  assert.equal(isDuplicateInboundMessage("wamid.b"), false);
  assert.equal(isDuplicateInboundMessage("wamid.a"), true);
});
