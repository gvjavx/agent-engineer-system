import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSelfReviewPrompt, parseBlockingLines } from "./selfReview.js";

test("parseBlockingLines keeps BLOCK: lines and drops the none sentinel", () => {
  assert.deepEqual(parseBlockingLines("BLOCK: none"), []);
  assert.deepEqual(
    parseBlockingLines("Ada dua hal:\nBLOCK: console.log ketinggalan di src/a.ts:12\nblock:  API key ke-hardcode di config\ncatatan lain"),
    ["console.log ketinggalan di src/a.ts:12", "API key ke-hardcode di config"]
  );
  assert.deepEqual(parseBlockingLines("Semuanya oke, gak ada yang perlu ditahan."), []);
});

test("buildSelfReviewPrompt embeds the diff and asks for the BLOCK format", () => {
  const p = buildSelfReviewPrompt("diff --git a/x b/x\n+  debugger;\n");
  assert.match(p, /```diff\ndiff --git a\/x/);
  assert.match(p, /diawali "BLOCK: "/);
  assert.match(p, /"BLOCK: none"/);
});
