import assert from "node:assert/strict";
import { test } from "node:test";
import { runPipeline } from "./pipeline.js";
import { hasPendingCheckpoint, resolveCheckpoint } from "./checkpoint.js";
import type { Provider, ChatMessage, ProviderResponse } from "./types.js";
import type { RunTaskParams, RunTaskResult } from "./runner.js";

async function waitUntilCheckpointPending(taskId: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!hasPendingCheckpoint(taskId)) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for checkpoint on ${taskId}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function textProvider(name: string, text: string, onChat?: (messages: ChatMessage[]) => void): Provider {
  return {
    name,
    async chat(messages): Promise<ProviderResponse> {
      onChat?.(messages);
      return { type: "text", text };
    },
  };
}

function throwingProvider(name: string): Provider {
  return {
    name,
    async chat() {
      throw new Error(`${name} is down`);
    },
  };
}

// Returns each text in order on successive calls — used to simulate a
// revision producing a different result the second time around.
function sequentialProvider(name: string, texts: string[]): Provider {
  let call = 0;
  return {
    name,
    async chat(): Promise<ProviderResponse> {
      const text = texts[Math.min(call, texts.length - 1)];
      call++;
      return { type: "text", text };
    },
  };
}

const baseParams = {
  taskId: "test-task",
  cwd: "/does/not/matter",
  projectAlias: "demo",
  mode: { kind: "local" as const, folderPath: "/does/not/matter" },
};

test("a single 'semua' phase delegates straight to runTaskFn, no phase loop", async () => {
  let received: RunTaskParams | undefined;
  const fakeRunTask = async (p: RunTaskParams): Promise<RunTaskResult> => {
    received = p;
    return { ok: true, summary: "done via single loop" };
  };

  const result = await runPipeline({
    ...baseParams,
    instruction: "tambahin health check",
    phases: [{ department: "semua", note: "tambahin health check" }],
    abortController: new AbortController(),
    onProgress: () => {},
    departmentModelLookup: () => undefined,
    runTaskFn: fakeRunTask,
    buildProvidersFn: () => {
      throw new Error("should not build providers directly for the semua shortcut");
    },
  });

  assert.deepEqual(result, { ok: true, summary: "done via single loop" });
  assert.equal(received?.kind, "local");
  assert.equal(received?.instruction, "tambahin health check");
});

test("multi-phase pipeline runs phases in order and hands summaries forward as context", async () => {
  const seenSystemPrompts: string[] = [];

  const providersByDept: Record<string, Provider> = {
    manajemen: textProvider("manajemen-model", "Scope-nya: cuma tambahin endpoint /health.", (msgs) =>
      seenSystemPrompts.push(String(msgs[0]?.content))
    ),
    dev: textProvider("dev-model", "Endpoint /health udah ditambahin di src/index.ts.", (msgs) =>
      seenSystemPrompts.push(String(msgs[0]?.content))
    ),
  };

  const result = await runPipeline({
    ...baseParams,
    instruction: "tambahin endpoint health check",
    phases: [
      { department: "manajemen", note: "tentuin scope endpoint health check" },
      { department: "dev", note: "implementasi endpoint-nya" },
    ],
    abortController: new AbortController(),
    onProgress: () => {},
    departmentModelLookup: (dept) => (dept in providersByDept ? dept : undefined),
    buildProvidersFn: (preferredProvider) => (preferredProvider ? [providersByDept[preferredProvider]] : []),
  });

  assert.equal(result.ok, true);
  assert.match(result.summary, /Manajemen Proyek & Produk/);
  assert.match(result.summary, /Tim Pengembangan/);
  // phase 2's system prompt should carry phase 1's summary as context
  assert.equal(seenSystemPrompts.length, 2);
  assert.doesNotMatch(seenSystemPrompts[0], /cuma tambahin endpoint \/health/);
  assert.match(seenSystemPrompts[1], /Scope-nya: cuma tambahin endpoint \/health\./);
});

test("a failing phase stops the pipeline before later phases run", async () => {
  let devPhaseRan = false;

  const result = await runPipeline({
    ...baseParams,
    instruction: "bikin fitur X",
    phases: [
      { department: "manajemen", note: "tentuin scope" },
      { department: "dev", note: "implementasi" },
    ],
    abortController: new AbortController(),
    onProgress: () => {},
    departmentModelLookup: (dept) => dept,
    buildProvidersFn: (preferredProvider) => {
      if (preferredProvider === "dev") devPhaseRan = true;
      return preferredProvider === "manajemen" ? [throwingProvider("manajemen-model")] : [];
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.summary, /Manajemen Proyek & Produk/);
  assert.equal(devPhaseRan, false, "dev phase must not run after manajemen phase fails");
});

test("checkpoint pauses after a non-last phase and resumes when the user approves", async () => {
  const taskId = "checkpoint-continue";
  const checkpointMessages: string[] = [];
  const providersByDept: Record<string, Provider> = {
    manajemen: textProvider("manajemen-model", "Scope-nya: tambahin login."),
    dev: textProvider("dev-model", "Login udah diimplementasi."),
  };

  const resultPromise = runPipeline({
    ...baseParams,
    taskId,
    instruction: "bikin fitur login",
    phases: [
      { department: "manajemen", note: "tentuin scope login" },
      { department: "dev", note: "implementasi login" },
    ],
    abortController: new AbortController(),
    onProgress: () => {},
    checkpoints: true,
    onCheckpoint: (msg) => checkpointMessages.push(msg),
    departmentModelLookup: (dept) => (dept in providersByDept ? dept : undefined),
    buildProvidersFn: (preferredProvider) => (preferredProvider ? [providersByDept[preferredProvider]] : []),
  });

  await waitUntilCheckpointPending(taskId);
  assert.equal(checkpointMessages.length, 1);
  assert.match(checkpointMessages[0], /Scope-nya: tambahin login\./);

  resolveCheckpoint(taskId, { action: "continue" });

  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.match(result.summary, /Login udah diimplementasi\./);
});

test("checkpoint revision re-runs the same phase with the revision as context, then checkpoints again", async () => {
  const taskId = "checkpoint-revise";
  const checkpointMessages: string[] = [];
  let devSawSystemPrompt = "";

  const providersByDept: Record<string, Provider> = {
    manajemen: sequentialProvider("manajemen-model", [
      "Scope-nya: cuma login email.",
      "Scope-nya: login email + login Google.",
    ]),
    dev: textProvider("dev-model", "Login diimplementasi.", (msgs) => {
      devSawSystemPrompt = String(msgs[0]?.content);
    }),
  };

  const resultPromise = runPipeline({
    ...baseParams,
    taskId,
    instruction: "bikin fitur login",
    phases: [
      { department: "manajemen", note: "tentuin scope login" },
      { department: "dev", note: "implementasi login" },
    ],
    abortController: new AbortController(),
    onProgress: () => {},
    checkpoints: true,
    onCheckpoint: (msg) => checkpointMessages.push(msg),
    departmentModelLookup: (dept) => (dept in providersByDept ? dept : undefined),
    buildProvidersFn: (preferredProvider) => (preferredProvider ? [providersByDept[preferredProvider]] : []),
  });

  await waitUntilCheckpointPending(taskId);
  resolveCheckpoint(taskId, { action: "revise", instruction: "tambahin juga login Google" });

  await waitUntilCheckpointPending(taskId);
  assert.equal(checkpointMessages.length, 2);
  assert.match(checkpointMessages[1], /login Google/);

  resolveCheckpoint(taskId, { action: "continue" });

  const result = await resultPromise;
  assert.equal(result.ok, true);
  // dev phase's system prompt should carry the revised (second) manajemen summary as context, not the first.
  assert.match(devSawSystemPrompt, /login Google/);
});

test("cancelling at a checkpoint stops the pipeline before the next phase runs", async () => {
  const taskId = "checkpoint-cancel";
  let devPhaseRan = false;
  const providersByDept: Record<string, Provider> = {
    manajemen: textProvider("manajemen-model", "Scope-nya: tambahin login."),
    dev: textProvider("dev-model", "Login diimplementasi."),
  };

  const resultPromise = runPipeline({
    ...baseParams,
    taskId,
    instruction: "bikin fitur login",
    phases: [
      { department: "manajemen", note: "tentuin scope login" },
      { department: "dev", note: "implementasi login" },
    ],
    abortController: new AbortController(),
    onProgress: () => {},
    checkpoints: true,
    onCheckpoint: () => {},
    departmentModelLookup: (dept) => (dept in providersByDept ? dept : undefined),
    buildProvidersFn: (preferredProvider) => {
      if (preferredProvider === "dev") devPhaseRan = true;
      return preferredProvider ? [providersByDept[preferredProvider]] : [];
    },
  });

  await waitUntilCheckpointPending(taskId);
  resolveCheckpoint(taskId, { action: "cancel" });

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.match(result.summary, /checkpoint/i);
  assert.equal(devPhaseRan, false);
});

test("checkpoints never pause the single-phase 'semua' shortcut", async () => {
  const result = await runPipeline({
    ...baseParams,
    taskId: "checkpoint-semua-shortcut",
    instruction: "fix typo",
    phases: [{ department: "semua", note: "fix typo" }],
    abortController: new AbortController(),
    onProgress: () => {},
    checkpoints: true,
    onCheckpoint: () => {
      throw new Error("checkpoint should never fire for the semua shortcut");
    },
    departmentModelLookup: () => undefined,
    runTaskFn: async () => ({ ok: true, summary: "done" }),
  });

  assert.equal(result.ok, true);
});
