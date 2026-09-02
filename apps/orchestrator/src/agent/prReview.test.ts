import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateDiff, buildReviewPrompt, formatPrList, type PrContext } from "./prReview.js";

test("truncateDiff leaves a short diff alone", () => {
  const d = "diff --git a/x b/x\n+one\n-two\n";
  assert.deepEqual(truncateDiff(d, 1000), { text: d, truncated: false });
});

test("truncateDiff cuts on a line boundary and flags it", () => {
  const d = ["line-a", "line-b", "line-c", "line-d"].join("\n");
  const { text, truncated } = truncateDiff(d, 15); // mid "line-c"
  assert.equal(truncated, true);
  assert.equal(text, "line-a\nline-b");
  assert.ok(!text.includes("line-c"));
});

const ctx: PrContext = {
  number: 12,
  title: "Add health check endpoint",
  body: "Adds /healthz for the load balancer.",
  author: "octocat",
  state: "OPEN",
  additions: 40,
  deletions: 3,
  changedFiles: 2,
  url: "https://github.com/o/r/pull/12",
  diff: "diff --git a/app.ts b/app.ts\n+app.get('/healthz', ...)\n",
  diffTruncated: false,
};

test("buildReviewPrompt embeds the metadata, body and diff", () => {
  const p = buildReviewPrompt(ctx);
  assert.match(p, /Add health check endpoint/);
  assert.match(p, /octocat · status: OPEN · 2 file, \+40\/-3/);
  assert.match(p, /Deskripsi PR:\nAdds \/healthz/);
  assert.match(p, /```diff\ndiff --git a\/app\.ts/);
  assert.doesNotMatch(p, /diff dipotong/);
});

test("buildReviewPrompt notes a truncated diff and omits an empty body", () => {
  const p = buildReviewPrompt({ ...ctx, body: "", diffTruncated: true });
  assert.match(p, /diff dipotong karena kepanjangan/);
  assert.doesNotMatch(p, /Deskripsi PR:/);
});

test("formatPrList lists number, draft flag, title and branch — or says none", () => {
  assert.equal(formatPrList([]), "Gak ada PR yang lagi kebuka.");
  const out = formatPrList([
    { number: 5, title: "Add search", headRefName: "feat/search", isDraft: false, url: "https://gh/o/r/pull/5" },
    { number: 6, title: "WIP redesign", headRefName: "feat/redesign", isDraft: true, url: "https://gh/o/r/pull/6" },
  ]);
  assert.match(out, /#5 — Add search\n {2}feat\/search · https/);
  assert.match(out, /#6 \(draft\) — WIP redesign/);
});
