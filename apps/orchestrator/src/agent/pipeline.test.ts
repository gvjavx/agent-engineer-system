import assert from "node:assert/strict";
import { test } from "node:test";
import { runPipeline } from "./pipeline.js";
import { hasPendingCheckpoint, resolveCheckpoint } from "./checkpoint.js";
import type { Provider, ChatMessage, ProviderResponse } from "./types.js";
import type { RunTaskParams, RunTaskResult } from "./runner.js";
import type { RunAgentLoopResult } from "./loop.js";

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
    onProgress: async () => {},
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
    onProgress: async () => {},
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

// Regression: onProgress used to be fire-and-forget, so a phase's "beres"
// message and the next phase's "start" message raced with no guaranteed
// delivery order — WhatsApp could show "start" before "beres". A slow
// onProgress here proves the pipeline now actually waits for one send to
// finish before raising the next one.
test("onProgress is awaited before the pipeline moves on, so messages can't arrive out of order", async () => {
  const seen: string[] = [];
  const onProgress = async (msg: string): Promise<void> => {
    if (msg.includes("beres")) {
      await new Promise((r) => setTimeout(r, 20));
    }
    seen.push(msg);
  };

  const providersByDept: Record<string, Provider> = {
    manajemen: textProvider("manajemen-model", "Scope-nya: cuma tambahin endpoint /health."),
    dev: textProvider("dev-model", "Endpoint /health udah ditambahin."),
  };

  const result = await runPipeline({
    ...baseParams,
    instruction: "tambahin endpoint health check",
    phases: [
      { department: "manajemen", note: "tentuin scope endpoint health check" },
      { department: "dev", note: "implementasi endpoint-nya" },
    ],
    abortController: new AbortController(),
    onProgress,
    departmentModelLookup: (dept) => (dept in providersByDept ? dept : undefined),
    buildProvidersFn: (preferredProvider) => (preferredProvider ? [providersByDept[preferredProvider]] : []),
  });

  assert.equal(result.ok, true);
  const beresIndex = seen.findIndex((m) => m.includes("beres"));
  const phase2StartIndex = seen.findIndex((m) => m.startsWith("Fase 2/2"));
  assert.ok(beresIndex !== -1 && phase2StartIndex !== -1);
  assert.ok(beresIndex < phase2StartIndex, `expected "beres" (${beresIndex}) before phase 2 start (${phase2StartIndex})`);
});

test("a desain phase's system prompt gets the ask-first block when checkpoints are on and no design source was given", async () => {
  const taskId = "desain-ask-first-wiring";
  let desainSystemPrompt = "";
  const providersByDept: Record<string, Provider> = {
    desain: textProvider("desain-model", "Oke, mau auto-generate atau kamu punya desain sendiri?", (msgs) => {
      desainSystemPrompt = String(msgs[0]?.content);
    }),
    dev: textProvider("dev-model", "Landing page diimplementasi."),
  };

  const resultPromise = runPipeline({
    ...baseParams,
    taskId,
    instruction: "buatkan website landing page",
    phases: [
      { department: "desain", note: "rancang tampilan landing page" },
      { department: "dev", note: "implementasi landing page" },
    ],
    abortController: new AbortController(),
    onProgress: async () => {},
    checkpoints: true,
    onCheckpoint: async () => {},
    departmentModelLookup: (dept) => (dept in providersByDept ? dept : undefined),
    buildProvidersFn: (preferredProvider) => (preferredProvider ? [providersByDept[preferredProvider]] : []),
  });

  await waitUntilCheckpointPending(taskId);
  resolveCheckpoint(taskId, { action: "continue" });
  await resultPromise;

  assert.match(desainSystemPrompt, /don't generate or write any design/);
});

test("a recoverable revise failure (e.g. Figma not linked) re-prompts at the same checkpoint instead of failing the task", async () => {
  const taskId = "checkpoint-recoverable";
  const checkpointMessages: string[] = [];
  const progressMessages: string[] = [];

  let callCount = 0;
  const runAgentLoopFn = async (): Promise<RunAgentLoopResult> => {
    callCount++;
    if (callCount === 1) return { ok: true, summary: "Desain awal, nunggu sumber desain." };
    if (callCount === 2) {
      return { ok: false, recoverable: true, summary: 'Figma belum kesambung. Ketik "hubungkan figma" dulu ya.' };
    }
    if (callCount === 3) return { ok: true, summary: "Desain udah dibikin pakai link Figma." };
    return { ok: true, summary: "Landing page diimplementasi." };
  };

  const resultPromise = runPipeline({
    ...baseParams,
    taskId,
    instruction: "buatkan website landing page",
    phases: [
      { department: "desain", note: "rancang tampilan landing page" },
      { department: "dev", note: "implementasi landing page" },
    ],
    abortController: new AbortController(),
    onProgress: async (msg) => {
      progressMessages.push(msg);
    },
    checkpoints: true,
    onCheckpoint: async (msg) => {
      checkpointMessages.push(msg);
    },
    departmentModelLookup: () => "fake",
    buildProvidersFn: () => [],
    runAgentLoopFn,
  });

  await waitUntilCheckpointPending(taskId);
  assert.equal(checkpointMessages.length, 1);
  resolveCheckpoint(taskId, { action: "revise", instruction: "https://figma.com/design/abc123" });

  // The recoverable failure must not end the task — it re-prompts at the
  // same checkpoint, still showing the last-good ("Desain awal...") summary.
  await waitUntilCheckpointPending(taskId);
  assert.equal(checkpointMessages.length, 2);
  assert.match(checkpointMessages[1], /Desain awal, nunggu sumber desain\./);
  assert.ok(progressMessages.some((m) => m.includes("hubungkan figma")));

  resolveCheckpoint(taskId, { action: "revise", instruction: "udah connect, ini link Figma-nya lagi" });
  await waitUntilCheckpointPending(taskId);
  assert.equal(checkpointMessages.length, 3);
  assert.match(checkpointMessages[2], /Desain udah dibikin pakai link Figma\./);

  resolveCheckpoint(taskId, { action: "continue" });
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.match(result.summary, /Landing page diimplementasi\./);
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
    onProgress: async () => {},
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

test("tapping 'Tanya <Role>?' invites the real question first instead of answering the tap itself, then answers with explicit role framing once asked", async () => {
  const taskId = "checkpoint-role-question";
  const progressMessages: string[] = [];
  let checkpointCalls = 0;
  const agentLoopCalls: string[] = [];

  const runAgentLoopFn = async (params: { instruction: string }): Promise<RunAgentLoopResult> => {
    agentLoopCalls.push(params.instruction);
    return agentLoopCalls.length === 1
      ? { ok: true, summary: "Fokusnya landing page minimalis." }
      : { ok: true, summary: "Fokusnya gitu biar cepat rilis, sesuai keputusan awal." };
  };

  const resultPromise = runPipeline({
    ...baseParams,
    taskId,
    instruction: "bikin landing page",
    phases: [
      { department: "manajemen", note: "tentuin scope landing page" },
      { department: "dev", note: "implementasi landing page" },
    ],
    abortController: new AbortController(),
    onProgress: async (msg) => {
      progressMessages.push(msg);
    },
    checkpoints: true,
    onCheckpoint: async () => {
      checkpointCalls++;
    },
    departmentModelLookup: () => "fake",
    buildProvidersFn: () => [],
    runAgentLoopFn,
  });

  await waitUntilCheckpointPending(taskId);
  assert.equal(checkpointCalls, 1);
  assert.equal(agentLoopCalls.length, 1);

  // Tap: should invite the question, NOT run the agent loop or re-show the checkpoint.
  resolveCheckpoint(taskId, { action: "revise", instruction: "Tanya Product Owner?" });
  await waitUntilCheckpointPending(taskId);
  assert.equal(checkpointCalls, 1, "checkpoint should not re-fire while waiting for the follow-up question");
  assert.equal(agentLoopCalls.length, 1, "the tap itself should not run the agent loop");
  assert.ok(progressMessages.some((m) => m.includes("Product Owner")));

  // The real follow-up question: now the agent loop runs, with explicit role framing.
  resolveCheckpoint(taskId, { action: "revise", instruction: "kenapa fokusnya gitu?" });
  await waitUntilCheckpointPending(taskId);
  assert.equal(checkpointCalls, 2, "checkpoint (with the full menu) should reappear once the role Q&A is answered");
  assert.equal(agentLoopCalls.length, 2);
  assert.match(agentLoopCalls[1], /User lagi nanya spesifik ke Product Owner/);
  assert.match(agentLoopCalls[1], /kenapa fokusnya gitu\?/);

  resolveCheckpoint(taskId, { action: "continue" });
  const result = await resultPromise;
  assert.equal(result.ok, true);
});

test("onCheckpoint receives the phase's department, so the caller can pick manajemen-specific options", async () => {
  const taskId = "checkpoint-department-arg";
  const seenDepartments: string[] = [];
  const providersByDept: Record<string, Provider> = {
    manajemen: textProvider("manajemen-model", "Scope-nya: tambahin login."),
    dev: textProvider("dev-model", "Login diimplementasi."),
    qa: textProvider("qa-model", "Login udah dites."),
  };

  const resultPromise = runPipeline({
    ...baseParams,
    taskId,
    instruction: "bikin fitur login",
    phases: [
      { department: "manajemen", note: "tentuin scope login" },
      { department: "dev", note: "implementasi login" },
      { department: "qa", note: "tes fitur login" },
    ],
    abortController: new AbortController(),
    onProgress: async () => {},
    checkpoints: true,
    onCheckpoint: async (_msg, department) => {
      seenDepartments.push(department);
    },
    departmentModelLookup: (dept) => (dept in providersByDept ? dept : undefined),
    buildProvidersFn: (preferredProvider) => (preferredProvider ? [providersByDept[preferredProvider]] : []),
  });

  await waitUntilCheckpointPending(taskId);
  resolveCheckpoint(taskId, { action: "continue" });
  await waitUntilCheckpointPending(taskId);
  resolveCheckpoint(taskId, { action: "continue" });

  await resultPromise;
  assert.deepEqual(seenDepartments, ["manajemen", "dev"]);
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
    onProgress: async () => {},
    checkpoints: true,
    onCheckpoint: async (msg) => {
      checkpointMessages.push(msg);
    },
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
    onProgress: async () => {},
    checkpoints: true,
    onCheckpoint: async (msg) => {
      checkpointMessages.push(msg);
    },
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
    onProgress: async () => {},
    checkpoints: true,
    onCheckpoint: async () => {},
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
  assert.equal(result.cancelled, true);
  assert.match(result.summary, /checkpoint/i);
  assert.equal(devPhaseRan, false);
});

test("a mid-phase abort (stop command while a phase is actively running) keeps the cancelled flag, doesn't get wrapped as a generic phase failure", async () => {
  const taskId = "abort-mid-phase";
  const runAgentLoopFn = async (): Promise<RunAgentLoopResult> => ({
    ok: false,
    cancelled: true,
    summary: "Oke, task-nya udah aku batalin.",
  });

  const result = await runPipeline({
    ...baseParams,
    taskId,
    instruction: "bikin fitur login",
    phases: [
      { department: "manajemen", note: "tentuin scope login" },
      { department: "dev", note: "implementasi login" },
    ],
    abortController: new AbortController(),
    onProgress: async () => {},
    checkpoints: false,
    departmentModelLookup: () => "fake",
    buildProvidersFn: () => [],
    runAgentLoopFn,
  });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.summary, "Oke, task-nya udah aku batalin.");
  assert.doesNotMatch(result.summary, /gagal/i);
});

test("checkpoints never pause the single-phase 'semua' shortcut", async () => {
  const result = await runPipeline({
    ...baseParams,
    taskId: "checkpoint-semua-shortcut",
    instruction: "fix typo",
    phases: [{ department: "semua", note: "fix typo" }],
    abortController: new AbortController(),
    onProgress: async () => {},
    checkpoints: true,
    onCheckpoint: () => {
      throw new Error("checkpoint should never fire for the semua shortcut");
    },
    departmentModelLookup: () => undefined,
    runTaskFn: async () => ({ ok: true, summary: "done" }),
  });

  assert.equal(result.ok, true);
});
