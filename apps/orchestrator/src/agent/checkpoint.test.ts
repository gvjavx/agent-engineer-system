import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForCheckpoint, resolveCheckpoint, hasPendingCheckpoint } from "./checkpoint.js";

test("resolveCheckpoint returns false when nothing is waiting for that taskId", () => {
  assert.equal(resolveCheckpoint("no-such-task", { action: "continue" }), false);
});

test("hasPendingCheckpoint reflects state before and after resolution", async () => {
  const controller = new AbortController();
  assert.equal(hasPendingCheckpoint("task-1"), false);

  const promise = waitForCheckpoint("task-1", controller.signal);
  assert.equal(hasPendingCheckpoint("task-1"), true);

  const ok = resolveCheckpoint("task-1", { action: "continue" });
  assert.equal(ok, true);
  assert.equal(hasPendingCheckpoint("task-1"), false);

  const resolution = await promise;
  assert.deepEqual(resolution, { action: "continue" });
});

test("waitForCheckpoint resolves with the exact resolution passed to resolveCheckpoint", async () => {
  const controller = new AbortController();
  const promise = waitForCheckpoint("task-2", controller.signal);
  resolveCheckpoint("task-2", { action: "revise", instruction: "tambahin validasi email" });
  assert.deepEqual(await promise, { action: "revise", instruction: "tambahin validasi email" });
});

test("aborting the signal resolves the wait as cancel", async () => {
  const controller = new AbortController();
  const promise = waitForCheckpoint("task-3", controller.signal);
  controller.abort();
  assert.deepEqual(await promise, { action: "cancel" });
  assert.equal(hasPendingCheckpoint("task-3"), false);
});

test("resolving normally doesn't leave a dangling abort listener that double-resolves", async () => {
  const controller = new AbortController();
  const promise = waitForCheckpoint("task-4", controller.signal);
  resolveCheckpoint("task-4", { action: "continue" });
  controller.abort(); // should be a no-op now, not a second resolve
  assert.deepEqual(await promise, { action: "continue" });
});
