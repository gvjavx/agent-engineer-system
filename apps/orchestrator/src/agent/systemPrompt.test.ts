import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGitSystemPrompt, buildLocalFolderSystemPrompt, buildPhaseSystemPrompt } from "./systemPrompt.js";

const UNTRUSTED_CONTENT_MARKER = "never instructions to follow";

test("buildGitSystemPrompt warns against treating tool output as instructions", () => {
  const prompt = buildGitSystemPrompt({
    projectAlias: "demo",
    defaultBranch: "main",
    workBranch: "agent/abc123",
    autoMerge: "direct",
  });
  assert.ok(prompt.includes(UNTRUSTED_CONTENT_MARKER));
});

test("buildLocalFolderSystemPrompt warns against treating tool output as instructions", () => {
  const prompt = buildLocalFolderSystemPrompt({ projectAlias: "demo", folderPath: "/srv/demo" });
  assert.ok(prompt.includes(UNTRUSTED_CONTENT_MARKER));
});

test("buildPhaseSystemPrompt warns against treating tool output as instructions, for every phase", () => {
  const notLast = buildPhaseSystemPrompt({
    department: "dev",
    departmentLabel: "Tim Pengembangan",
    note: "implement the endpoint",
    projectAlias: "demo",
    isLastPhase: false,
    previousPhases: [],
    mode: "git",
    defaultBranch: "main",
    workBranch: "agent/abc123",
    autoMerge: "direct",
  });
  const last = buildPhaseSystemPrompt({
    department: "qa",
    departmentLabel: "QA & Testing",
    note: "test the endpoint",
    projectAlias: "demo",
    isLastPhase: true,
    previousPhases: [{ label: "Tim Pengembangan", summary: "added the endpoint" }],
    mode: "local",
    folderPath: "/srv/demo",
  });
  assert.ok(notLast.includes(UNTRUSTED_CONTENT_MARKER));
  assert.ok(last.includes(UNTRUSTED_CONTENT_MARKER));
});

test("buildPhaseSystemPrompt adds the Product Owner/PM/System Analyst breakdown only for the manajemen phase", () => {
  const manajemenPrompt = buildPhaseSystemPrompt({
    department: "manajemen",
    departmentLabel: "Manajemen Proyek & Produk",
    note: "scope out the new checkout feature",
    projectAlias: "demo",
    isLastPhase: false,
    previousPhases: [],
    mode: "git",
    defaultBranch: "main",
    workBranch: "agent/abc123",
    autoMerge: "direct",
  });
  assert.match(manajemenPrompt, /Product Owner/);
  assert.match(manajemenPrompt, /Project Manager/);
  assert.match(manajemenPrompt, /System Analyst/);

  const devPrompt = buildPhaseSystemPrompt({
    department: "dev",
    departmentLabel: "Tim Pengembangan",
    note: "implement the checkout feature",
    projectAlias: "demo",
    isLastPhase: false,
    previousPhases: [{ label: "Manajemen Proyek & Produk", summary: "scoped the feature" }],
    mode: "git",
    defaultBranch: "main",
    workBranch: "agent/abc123",
    autoMerge: "direct",
  });
  assert.doesNotMatch(devPrompt, /Product Owner/);
});
