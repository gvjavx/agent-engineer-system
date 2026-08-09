import { auditLog } from "../db/index.js";
import { runAgentLoop } from "./loop.js";
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
  onProgress: (text: string) => void;
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
  onCheckpoint?: (message: string) => void;
  // Backs the send_document tool — see loop.ts for why this is a callback.
  sendDocument?: (relPath: string, caption: string | undefined) => Promise<string>;
  // Swappable for tests — default to the real config-backed implementations.
  buildProvidersFn?: (preferredProvider?: string) => Provider[];
  runTaskFn?: (params: RunTaskParams) => Promise<RunTaskResult>;
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
    buildProvidersFn = realBuildProviders,
    runTaskFn = realRunTask,
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
        });
  }

  const completedPhases: { label: string; summary: string }[] = [];

  for (let i = 0; i < phases.length; i++) {
    if (abortController.signal.aborted) {
      return { ok: false, summary: "Oke, task-nya udah aku batalin." };
    }

    const phase = phases[i];
    const isLastPhase = i === phases.length - 1;
    const label = phase.department === "semua" ? "Umum" : DEPARTMENT_LABELS[phase.department];

    onProgress(`Fase ${i + 1}/${phases.length} — ${label}: ${phase.note}`);
    auditLog.add(taskId, "note", `Phase start: ${phase.department} — ${phase.note}`);

    const systemPrompt = buildPhaseSystemPrompt({
      department: phase.department,
      departmentLabel: label,
      note: phase.note,
      projectAlias,
      isLastPhase,
      previousPhases: completedPhases,
      ...(mode.kind === "git"
        ? { mode: "git" as const, defaultBranch: mode.defaultBranch, workBranch: mode.workBranch, autoMerge: mode.autoMerge }
        : { mode: "local" as const, folderPath: mode.folderPath }),
    });

    const providerName = departmentModelLookup(phase.department) ?? departmentModelLookup("semua");

    let result = await runAgentLoop({
      providers: buildProvidersFn(providerName),
      systemPrompt,
      instruction,
      cwd,
      taskId,
      abortController,
      onProgress,
      maxTurns: PHASE_MAX_TURNS,
      sendDocument,
    });

    if (!result.ok) {
      return { ok: false, summary: `Fase "${label}" gagal, jadi aku hentiin di sini: ${result.summary}` };
    }

    if (checkpoints && !isLastPhase) {
      for (;;) {
        onCheckpoint(
          `Fase "${label}" kelar:\n${result.summary}\n\nLanjut ke fase berikutnya, atau ketik revisinya kalau ada yang mau diubah.`
        );
        auditLog.add(taskId, "note", `Checkpoint: nunggu review buat fase "${label}"`);

        const resolution = await waitForCheckpoint(taskId, abortController.signal);
        if (resolution.action === "cancel") {
          return { ok: false, summary: `Dibatalin pas checkpoint fase "${label}".` };
        }
        if (resolution.action === "continue") break;

        onProgress(`Oke, aku revisi fase "${label}" dulu ya: ${resolution.instruction}`);
        result = await runAgentLoop({
          providers: buildProvidersFn(providerName),
          systemPrompt,
          instruction: `Instruksi awal buat fase ini: ${phase.note}\n\nHasil sebelumnya: ${result.summary}\n\nUser minta revisi: ${resolution.instruction}`,
          cwd,
          taskId,
          abortController,
          onProgress,
          maxTurns: PHASE_MAX_TURNS,
          sendDocument,
        });

        if (!result.ok) {
          return { ok: false, summary: `Revisi fase "${label}" gagal: ${result.summary}` };
        }
      }
    }

    completedPhases.push({ label, summary: result.summary });
    onProgress(`Fase ${i + 1}/${phases.length} (${label}) beres.`);
  }

  const combined = completedPhases.map((p, i) => `${i + 1}. ${p.label}: ${p.summary}`).join("\n");
  return { ok: true, summary: combined };
}
