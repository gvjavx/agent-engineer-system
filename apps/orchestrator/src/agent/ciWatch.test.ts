import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRuns, type GhRun } from "./ciWatch.js";

function run(over: Partial<GhRun>): GhRun {
  return {
    databaseId: 1,
    headSha: "abc",
    status: "completed",
    conclusion: "success",
    url: "https://github.com/o/r/actions/runs/1",
    workflowName: "CI",
    ...over,
  };
}

test("classifyRuns reports 'none' when no run matches the sha", () => {
  assert.deepEqual(classifyRuns([run({ headSha: "other" })], "abc"), { state: "none", failing: [] });
});

test("classifyRuns reports 'pending' while any matching run is unfinished", () => {
  const runs = [run({ conclusion: null, status: "in_progress" }), run({ databaseId: 2 })];
  assert.equal(classifyRuns(runs, "abc").state, "pending");
});

test("classifyRuns reports 'success' when every matching run passed", () => {
  const runs = [run({ workflowName: "CI" }), run({ databaseId: 2, workflowName: "Lint" })];
  assert.deepEqual(classifyRuns(runs, "abc"), { state: "success", failing: [] });
});

test("classifyRuns reports 'failure' and lists the failing runs", () => {
  const runs = [
    run({ databaseId: 2, workflowName: "Lint", conclusion: "failure" }),
    run({ databaseId: 3, workflowName: "Types", conclusion: "timed_out" }),
    run({ databaseId: 4, workflowName: "CI", conclusion: "success" }),
  ];
  const res = classifyRuns(runs, "abc");
  assert.equal(res.state, "failure");
  assert.deepEqual(res.failing.map((r) => r.workflowName), ["Lint", "Types"]);
});

test("classifyRuns does not treat a hand-cancelled run as a failure", () => {
  assert.equal(classifyRuns([run({ conclusion: "cancelled" })], "abc").state, "success");
});
