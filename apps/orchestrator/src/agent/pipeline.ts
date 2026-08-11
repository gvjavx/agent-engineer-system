import { auditLog } from "../db/index.js";
import { runAgentLoop as realRunAgentLoop, type RunAgentLoopParams, type RunAgentLoopResult } from "./loop.js";
import { buildPhaseSystemPrompt } from "./systemPrompt.js";
import { runTask as realRunTask, buildProviders as realBuildProviders, type RunTaskResult, type RunTaskParams } from "./runner.js";
import { DEPARTMENT_LABELS, type DepartmentKey } from "./departments.js";
import { waitForCheckpoint } from "./checkpoint.js";
import type { Provider } from "./types.js";

export interface PhaseSpec {
  department: DepartmentKey | "semua";
  note: string;
}

export type PipelineMode =
  | { kind: "git"; defaultBranch: string; workBranch: string; autoMerge: "direct" | "pr" }
  | { kind: "local"; folderPath: string };

export interface RunPipelineParams {
  taskId: string;
  cwd: string;
  projectAlias: string;
  instruction: string;
  phases: PhaseSpec[];
  abortController: AbortController;
  // Awaited at every call site — see loop.ts's RunAgentLoopParams.onProgress
  // for why this can't be fire-and-forget without risking out-of-order delivery.
  onProgress: (text: string) => Promise<void>;
  // Provider name assigned to a department (or "semua" for the fallback/default), if any.
  departmentModelLookup: (department: string) => string | undefined;
  mode: PipelineMode;
  // Opt-in, per-task: pause after each non-last phase for the user to
  // approve or ask for a revision before the next phase starts. Never
  // applies to the single-phase "semua" shortcut below — there's nothing to
  // pause between.
  checkpoints?: boolean;
  // Separate from onProgress (plain text) because a checkpoint prompt needs
  // to go out with Ya/Tidak buttons attached. Falls back to onProgress
  // (as plain text, no buttons) if checkpoints is used without this set.
  onCheckpoint?: (message: string) => Promise<void>;
  // Backs the send_document tool — see loop.ts for why this is a callback.
  sendDocument?: (relPath: string, caption: string | undefined) => Promise<string>;
  // Backs the WhatsApp confirmation gate for risky bash commands — see loop.ts.
  onDangerousBash?: (command: string, reason: string) => Promise<boolean>;
  // Swappable for tests — default to the real config-backed implementations.
  buildProvidersFn?: (preferredProvider?: string) => Provider[];
  runTaskFn?: (params: RunTaskParams) => Promise<RunTaskResult>;
  // DI seam for tests — real callers never pass this. Same pattern as
  // runTaskFn/buildProvidersFn above, added so the checkpoint loop's
  // recoverable-failure handling (Part D) is testable without depending on
  // real Figma OAuth/DB state.
  runAgentLoopFn?: (params: RunAgentLoopParams) => Promise<RunAgentLoopResult>;
}

const PHASE_MAX_TURNS = 15;

export async function runPipeline(params: RunPipelineParams): Promise<RunTaskResult> {
  const {
    taskId,
    cwd,
    projectAlias,
    instruction,
    phases,
    abortController,
    onProgress,
    departmentModelLookup,
    mode,
    checkpoints = false,
    onCheckpoint = onProgress,
    sendDocument,
    onDangerousBash,
    buildProvidersFn = realBuildProviders,
    runTaskFn = realRunTask,
    runAgentLoopFn = realRunAgentLoop,
  } = params;

  // A single "semua" phase means classification didn't find anything
  // department-specific — behave exactly like the old single-loop task.
  if (phases.length === 1 && phases[0].department === "semua") {
    const preferredProvider = departmentModelLookup("semua");
    return mode.kind === "git"
      ? runTaskFn({
          kind: "git",
          taskId,
          cwd,
          projectAlias,
          defaultBranch: mode.defaultBranch,
          workBranch: mode.workBranch,
          autoMerge: mode.autoMerge,
          instruction,
          abortController,
          preferredProvider,
          onProgress,
          sendDocument,
          onDangerousBash,
        })
      : runTaskFn({
          kind: "local",
          taskId,
          cwd,
          projectAlias,
          folderPath: mode.folderPath,
          instruction,
          abortController,
          preferredProvider,
          onProgress,
          sendDocument,
          onDangerousBash,
        });
  }

  const completedPhases: { label: string; summary: string }[] = [];

  for (let i = 0; i < phases.length; i++) {
    if (abortController.signal.aborted) {
      return { ok: false, cancelled: true, summary: "Oke, task-nya udah aku batalin." };
    }

    const phase = phases[i];
    const isLastPhase = i === phases.length - 1;
    const label = phase.department === "semua" ? "Umum" : DEPARTMENT_LABELS[phase.department];

    await onProgress(`Fase ${i + 1}/${phases.length} — ${label}: ${phase.note}`);
    auditLog.add(taskId, "note", `Phase start: ${phase.department} — ${phase.note}`);

    const systemPrompt = buildPhaseSystemPrompt({
      department: phase.department,
      departmentLabel: label,
      note: phase.note,
      projectAlias,
      isLastPhase,
      previousPhases: completedPhases,
      instruction,
      checkpoints,
      ...(mode.kind === "git"
        ? { mode: "git" as const, defaultBranch: mode.defaultBranch, workBranch: mode.workBranch, autoMerge: mode.autoMerge }
        : { mode: "local" as const, folderPath: mode.folderPath }),
    });

    const providerName = departmentModelLookup(phase.department) ?? departmentModelLookup("semua");

    let result = await runAgentLoopFn({
      providers: buildProvidersFn(providerName),
      systemPrompt,
      instruction,
      cwd,
      taskId,
      abortController,
      onProgress,
      maxTurns: PHASE_MAX_TURNS,
      sendDocument,
      onDangerousBash,
    });

    if (!result.ok) {
      // A mid-phase abort (user typed "stop" while this phase's agent loop
      // was actively running) surfaces here as result.cancelled, not just at
      // the top-of-loop/checkpoint boundaries above — must not get lost
      // inside the generic "fase gagal" wrapper, or executeTask never learns
      // it should discard the work branch.
      if (result.cancelled) {
        return { ok: false, cancelled: true, summary: result.summary };
      }
      return { ok: false, summary: `Fase "${label}" gagal, jadi aku hentiin di sini: ${result.summary}` };
    }

    if (checkpoints && !isLastPhase) {
      for (;;) {
        await onCheckpoint(
          `Fase "${label}" kelar:\n${result.summary}\n\nLanjut ke fase berikutnya, atau ketik apa yang mau diubah/ditanyain dulu.`
        );
        auditLog.add(taskId, "note", `Checkpoint: nunggu review buat fase "${label}"`);

        const resolution = await waitForCheckpoint(taskId, abortController.signal);
        if (resolution.action === "cancel") {
          return { ok: false, cancelled: true, summary: `Dibatalin pas checkpoint fase "${label}".` };
        }
        if (resolution.action === "continue") break;

        // Not "aku revisi ... : X" — X isn't necessarily an edit request. A
        // checkpoint reply that isn't yes/no could just as easily be "tunjukkan
        // plan nya" (a question) as "tambahin fitur X" (an actual revision);
        // labeling both as "revisi" upfront both misleads the user about what's
        // happening and primes the model to treat a plain question as an edit
        // instruction. Left to the model to tell apart via the instruction below.
        await onProgress(`Oke, aku tindak lanjuti dulu ya: ${resolution.instruction}`);
        const revised = await runAgentLoopFn({
          providers: buildProvidersFn(providerName),
          systemPrompt,
          instruction: `Instruksi awal buat fase ini: ${phase.note}\n\nHasil sebelumnya: ${result.summary}\n\nUser bilang: "${resolution.instruction}"\n\nKalau ini permintaan buat mengubah atau menambah sesuatu di hasil sebelumnya, revisi hasilnya sesuai itu. Kalau ini cuma pertanyaan atau minta ditunjukin/dijelasin sesuatu (mis. isi sebuah file yang udah dibikin), jawab langsung — jangan ubah hasil sebelumnya kalau memang nggak diminta.`,
          cwd,
          taskId,
          abortController,
          onProgress,
          maxTurns: PHASE_MAX_TURNS,
          sendDocument,
          onDangerousBash,
        });

        if (!revised.ok) {
          // Recoverable (e.g. "Figma belum kesambung") — the user can fix it
          // (connect Figma, paste a real link) without losing everything
          // that already ran in this task. Re-prompt at the same checkpoint
          // instead of failing the whole pipeline; `result` (last good) is
          // left untouched.
          if (revised.recoverable) {
            await onProgress(revised.summary);
            continue;
          }
          if (revised.cancelled) {
            return { ok: false, cancelled: true, summary: revised.summary };
          }
          return { ok: false, summary: `Revisi fase "${label}" gagal: ${revised.summary}` };
        }
        result = revised;
      }
    }

    completedPhases.push({ label, summary: result.summary });
    await onProgress(`Fase ${i + 1}/${phases.length} (${label}) beres.`);
  }

  const combined = completedPhases.map((p, i) => `${i + 1}. ${p.label}: ${p.summary}`).join("\n");
  return { ok: true, summary: combined };
}
