import assert from "node:assert/strict";
import { test } from "node:test";
import { enqueueProjectTask, cancelActiveTask, getActiveTaskId, planResume, MAX_RESUME_ATTEMPTS } from "./taskQueue.js";
import { tasksRepo, scheduledTasksRepo, type Task } from "../db/index.js";

const settle = () => new Promise((r) => setTimeout(r, 10));

function taskRow(over: Partial<Task>): Task {
  return {
    id: "t",
    project_alias: "p",
    from_number: "62800",
    instruction: "do a thing",
    status: "queued",
    result_summary: null,
    created_at: "2026-01-01T00:00:00Z",
    finished_at: null,
    phases_json: JSON.stringify([{ department: "semua", note: "do a thing" }]),
    checkpoints: 0,
    resume_count: 0,
    ...over,
  };
}

test("enqueueProjectTask runs same-project tasks strictly in order", async () => {
  const order: string[] = [];
  const gate = (ms: number, tag: string) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    order.push(tag);
  };
  enqueueProjectTask("proj-serial", "a", gate(30, "a"));
  enqueueProjectTask("proj-serial", "b", gate(1, "b"));
  await settle();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(order, ["a", "b"], "b must wait for a even though b is faster");
});

test("enqueueProjectTask runs different projects concurrently", async () => {
  const order: string[] = [];
  enqueueProjectTask("proj-x", "x", async () => {
    await new Promise((r) => setTimeout(r, 40));
    order.push("x");
  });
  enqueueProjectTask("proj-y", "y", async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push("y");
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(order, ["y", "x"], "y finishes first because it isn't behind x");
});

test("getActiveTaskId / cancelActiveTask track the running task and abort it", async () => {
  let sawAbort = false;
  enqueueProjectTask("proj-cancel", "c1", async (ac) => {
    await new Promise<void>((resolve) => {
      ac.signal.addEventListener("abort", () => {
        sawAbort = true;
        resolve();
      });
      setTimeout(resolve, 500);
    });
  });
  await settle();
  assert.equal(getActiveTaskId("proj-cancel"), "c1");
  assert.equal(cancelActiveTask("proj-cancel"), "c1");
  await settle();
  assert.equal(sawAbort, true);
  assert.equal(cancelActiveTask("proj-cancel"), undefined, "nothing active once it finished");
});

test("planResume keeps reconstructable tasks oldest-first and abandons the rest", () => {
  const rows = [
    taskRow({ id: "new", created_at: "2026-01-03T00:00:00Z" }),
    taskRow({ id: "old", created_at: "2026-01-01T00:00:00Z" }),
    taskRow({ id: "looped", resume_count: MAX_RESUME_ATTEMPTS }),
    taskRow({ id: "legacy", phases_json: null }),
  ];
  const { resume, abandon } = planResume(rows);
  assert.deepEqual(resume.map((t) => t.id), ["old", "new"]);
  assert.deepEqual(abandon.map((t) => t.id).sort(), ["legacy", "looped"]);
});

test("tasksRepo persists the plan and markResumed bumps the counter without losing it", () => {
  const phases = JSON.stringify([{ department: "dev", note: "x" }]);
  tasksRepo.create("persist-1", "proj-db", "62811", "add a button", phases, true);

  let row = tasksRepo.get("persist-1")!;
  assert.equal(row.phases_json, phases);
  assert.equal(row.checkpoints, 1);
  assert.equal(row.resume_count, 0);

  tasksRepo.setStatus("persist-1", "running");
  assert.deepEqual(tasksRepo.interrupted().map((t) => t.id).includes("persist-1"), true);

  tasksRepo.markResumed("persist-1");
  row = tasksRepo.get("persist-1")!;
  assert.equal(row.status, "queued");
  assert.equal(row.resume_count, 1);
  assert.equal(row.phases_json, phases, "plan survives a resume");

  tasksRepo.setStatus("persist-1", "done", "beres");
  assert.equal(tasksRepo.interrupted().some((t) => t.id === "persist-1"), false);
});

test("tasksRepo.pendingForProject counts queued + running oldest-first", () => {
  tasksRepo.create("pf-a", "proj-pending", "62811", "one", "[]", false);
  tasksRepo.create("pf-b", "proj-pending", "62811", "two", "[]", false);
  tasksRepo.setStatus("pf-a", "running");
  const pending = tasksRepo.pendingForProject("proj-pending");
  assert.deepEqual(pending.map((t) => t.id), ["pf-a", "pf-b"]);
  tasksRepo.setStatus("pf-a", "done");
  tasksRepo.setStatus("pf-b", "cancelled");
});

test("scheduledTasksRepo: create, due filtering, markRan advances next_run_at, deleteForProject", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  scheduledTasksRepo.create("sc-1", "628", "proj-sch", "update deps", "tiap hari jam 07:00", "{}", past);
  scheduledTasksRepo.create("sc-2", "628", "proj-sch", "run lint", "tiap 6 jam", "{}", future);
  scheduledTasksRepo.create("sc-3", "628", "proj-other", "x", "tiap hari jam 08:00", "{}", past);

  assert.deepEqual(scheduledTasksRepo.listForNumber("628").map((s) => s.id), ["sc-1", "sc-2", "sc-3"]);

  const dueIds = scheduledTasksRepo.due(new Date().toISOString()).map((s) => s.id);
  assert.ok(dueIds.includes("sc-1") && dueIds.includes("sc-3"));
  assert.ok(!dueIds.includes("sc-2"), "sc-2's next run is still in the future");

  scheduledTasksRepo.markRan("sc-1", future);
  const sc1 = scheduledTasksRepo.listForNumber("628").find((s) => s.id === "sc-1")!;
  assert.equal(sc1.next_run_at, future);
  assert.ok(sc1.last_run_at);
  assert.equal(scheduledTasksRepo.due(new Date().toISOString()).some((s) => s.id === "sc-1"), false);

  assert.equal(scheduledTasksRepo.deleteForProject("proj-sch"), 2);
  assert.deepEqual(scheduledTasksRepo.listForProject("proj-sch"), []);
  assert.equal(scheduledTasksRepo.listForNumber("628").length, 1); // sc-3 survives
  scheduledTasksRepo.delete("sc-3");
});

test("tasksRepo.stats rolls up outcomes and average duration over the window", () => {
  // Other tests in this file share the in-memory DB, so assert on the delta.
  const before = tasksRepo.stats(7);
  for (const [id, status] of [
    ["st-1", "done"],
    ["st-2", "done"],
    ["st-3", "failed"],
    ["st-4", "cancelled"],
    ["st-5", "running"],
  ] as const) {
    tasksRepo.create(id, "proj-stats", "62811", id, "[]", false);
    tasksRepo.setStatus(id, status);
  }
  const after = tasksRepo.stats(7);
  assert.equal(after.done - before.done, 2);
  assert.equal(after.failed - before.failed, 1);
  assert.equal(after.cancelled - before.cancelled, 1);
  assert.equal(after.running - before.running, 1);
  assert.equal(after.total - before.total, 5);
  // finished_at is set by setStatus at ~the same instant as created_at here,
  // so the average is a small non-negative number, not null.
  assert.ok(after.avgMinutes != null && after.avgMinutes >= 0);
});
