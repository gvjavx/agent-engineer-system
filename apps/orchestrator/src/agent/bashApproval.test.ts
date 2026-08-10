import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForBashApproval, resolveBashApproval, hasPendingBashApproval } from "./bashApproval.js";

test("resolveBashApproval returns false when nothing is waiting for that taskId", () => {
  assert.equal(resolveBashApproval("no-such-task", true), false);
});

test("hasPendingBashApproval reflects state before and after resolution", async () => {
  const controller = new AbortController();
  assert.equal(hasPendingBashApproval("task-1"), false);

  const promise = waitForBashApproval("task-1", controller.signal);
  assert.equal(hasPendingBashApproval("task-1"), true);

  const ok = resolveBashApproval("task-1", true);
  assert.equal(ok, true);
  assert.equal(hasPendingBashApproval("task-1"), false);

  assert.equal(await promise, true);
});

test("waitForBashApproval resolves with the exact decision passed to resolveBashApproval", async () => {
  const controller = new AbortController();
  const promise = waitForBashApproval("task-2", controller.signal);
  resolveBashApproval("task-2", false);
  assert.equal(await promise, false);
});

test("aborting the signal resolves the wait as not approved", async () => {
  const controller = new AbortController();
  const promise = waitForBashApproval("task-3", controller.signal);
  controller.abort();
  assert.equal(await promise, false);
  assert.equal(hasPendingBashApproval("task-3"), false);
});

test("resolving normally doesn't leave a dangling abort listener that double-resolves", async () => {
  const controller = new AbortController();
  const promise = waitForBashApproval("task-4", controller.signal);
  resolveBashApproval("task-4", true);
  controller.abort(); // should be a no-op now, not a second resolve
  assert.equal(await promise, true);
});
