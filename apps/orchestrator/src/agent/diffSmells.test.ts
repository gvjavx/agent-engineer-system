import assert from "node:assert/strict";
import { test } from "node:test";
import { scanDiffSmells } from "./diffSmells.js";

test("scanDiffSmells flags a left-in debugger and a focused test on added lines", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "@@ -1,2 +1,4 @@",
    " const a = 1;",
    "+  debugger;",
    "+it.only('does a thing', () => {});",
  ].join("\n");
  assert.deepEqual(scanDiffSmells(diff).sort(), ["`.only(` (test yang di-focus)", "`debugger`"].sort());
});

test("scanDiffSmells ignores matches on context and removed lines", () => {
  const diff = [
    "@@ -1,3 +1,2 @@",
    "-  debugger;",
    " it.only('kept as-is', () => {});",
    "+  const clean = true;",
  ].join("\n");
  assert.deepEqual(scanDiffSmells(diff), []);
});

test("scanDiffSmells does not flag a plain console.log", () => {
  assert.deepEqual(scanDiffSmells("+  console.log('ok');\n"), []);
});
