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
    instruction: "tambahin endpoint health check",
    checkpoints: false,
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
    instruction: "tambahin endpoint health check",
    checkpoints: false,
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
    instruction: "bikin fitur checkout",
    checkpoints: false,
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
    instruction: "bikin fitur checkout",
    checkpoints: false,
    mode: "git",
    defaultBranch: "main",
    workBranch: "agent/abc123",
    autoMerge: "direct",
  });
  assert.doesNotMatch(devPrompt, /Product Owner/);
});

test("buildPhaseSystemPrompt adds the design-source ask-first block only for desain phases with checkpoints on and no design source yet", () => {
  const base = {
    department: "desain",
    departmentLabel: "Tim Desain",
    note: "rancang tampilan landing page",
    projectAlias: "demo",
    isLastPhase: false,
    previousPhases: [],
    mode: "git" as const,
    defaultBranch: "main",
    workBranch: "agent/abc123",
    autoMerge: "direct" as const,
  };

  const asksFirst = buildPhaseSystemPrompt({
    ...base,
    instruction: "buatkan website landing page",
    checkpoints: true,
  });
  assert.match(asksFirst, /don't generate or write any design/);

  const withFigmaLink = buildPhaseSystemPrompt({
    ...base,
    instruction: "buatkan sesuai desain ini https://www.figma.com/design/abc123/Landing-Page",
    checkpoints: true,
  });
  assert.doesNotMatch(withFigmaLink, /don't generate or write any design/);

  const withImageDescription = buildPhaseSystemPrompt({
    ...base,
    instruction: 'buatkan sesuai ini\n\n(Gambar yang dikirim bareng ini nunjukkin: mockup landing page dengan hero section)',
    checkpoints: true,
  });
  assert.doesNotMatch(withImageDescription, /don't generate or write any design/);

  const withoutCheckpoints = buildPhaseSystemPrompt({
    ...base,
    instruction: "buatkan website landing page",
    checkpoints: false,
  });
  assert.doesNotMatch(withoutCheckpoints, /don't generate or write any design/);

  const notDesain = buildPhaseSystemPrompt({
    ...base,
    department: "dev",
    departmentLabel: "Tim Pengembangan",
    instruction: "buatkan website landing page",
    checkpoints: true,
  });
  assert.doesNotMatch(notDesain, /don't generate or write any design/);
});
