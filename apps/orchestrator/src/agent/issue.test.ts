import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIssueInstruction, type IssueContext } from "./issue.js";

const ctx: IssueContext = {
  number: 42,
  title: "Login form accepts empty password",
  body: "Steps: leave the password blank, hit submit, it logs you in.",
  state: "OPEN",
  labels: ["bug", "security"],
  url: "https://github.com/o/r/issues/42",
  comments: [{ author: "octocat", body: "Only on the mobile layout." }],
};

test("buildIssueInstruction embeds number, title, body, labels and comments", () => {
  const out = buildIssueInstruction(ctx);
  assert.match(out, /issue #42: "Login form accepts empty password"/);
  assert.match(out, /Label: bug, security/);
  assert.match(out, /leave the password blank/);
  assert.match(out, /- octocat: Only on the mobile layout\./);
  assert.match(out, /Closes #42/);
});

test("buildIssueInstruction calls out an empty body instead of leaving a blank", () => {
  const out = buildIssueInstruction({ ...ctx, body: "", labels: [], comments: [] });
  assert.match(out, /deskripsi issue-nya kosong/);
  assert.doesNotMatch(out, /Label:/);
  assert.doesNotMatch(out, /Komentar di issue/);
});
