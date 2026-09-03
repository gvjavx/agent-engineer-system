import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTaskLog } from "./taskLog.js";

test("formatTaskLog prefixes each row by kind and keeps the header", () => {
  const out = formatTaskLog(
    [
      { kind: "note", detail: "Phase start: dev — bikin endpoint" },
      { kind: "tool_use", detail: "bash: npm test" },
      { kind: "error", detail: "test gagal" },
      { kind: "tool_use", detail: "Menulis src/health.ts" },
    ],
    'Task "tambah /health" — done'
  );
  assert.match(out, /^Task "tambah \/health" — done\n\n/);
  assert.match(out, /— Phase start: dev/);
  assert.match(out, /• bash: npm test/);
  assert.match(out, /\[error\] test gagal/);
});

test("formatTaskLog truncates a long trail and notes how many were dropped", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ kind: "tool_use", detail: `step ${i}` }));
  const out = formatTaskLog(rows, "H");
  assert.match(out, /\(10 langkah awal disingkat\)/);
  assert.ok(out.includes("step 49"));
  assert.ok(!out.includes("step 9\n")); // first 10 dropped
});

test("formatTaskLog handles an empty trail", () => {
  assert.match(formatTaskLog([], "H"), /gak ada catatan langkahnya/);
});
