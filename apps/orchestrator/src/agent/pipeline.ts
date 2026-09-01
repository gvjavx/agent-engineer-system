import { auditLog } from "../db/index.js";
import { runAgentLoop as realRunAgentLoop, type RunAgentLoopParams, type RunAgentLoopResult } from "./loop.js";
import { buildPhaseSystemPrompt } from "./systemPrompt.js";
import { runTask as realRunTask, buildProviders as realBuildProviders, type RunTaskResult, type RunTaskParams } from "./runner.js";
import { DEPARTMENT_LABELS, type DepartmentKey } from "./departments.js";
import { waitForCheckpoint } from "./checkpoint.js";
import { hasDesignSource } from "./designSource.js";
import { retrieveCodeContext } from "./rag/index.js";
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
  // Third param: true when this specific checkpoint should offer the
  // design-source tappable options (Upload gambar/Hubungkan Figma/Serahkan
  // ke AI) instead of the department-default options — see
  // designSourceStillNeeded in the checkpoint loop below.
  onCheckpoint?: (message: string, department: string, offerDesignSourceChoice: boolean) => Promise<void>;
  // Backs the send_document tool — see loop.ts for why this is a callback.
  sendDocument?: (relPath: string, caption: string | undefined) => Promise<string>;
  // Backs the WhatsApp confirmation gate for risky bash commands — see loop.ts.
  onDangerousBash?: (command: string, reason: string) => Promise<boolean>;
  // Swappable for tests — default to the real config-backed implementations.
  buildProvidersFn?: (preferredProvider?: string) => Provider[];
  runTaskFn?: (params: RunTaskParams) => Promise<RunTaskResult>;
  // DI seam for tests. Real callers never pass this — defaults to the real
  // agent/rag retrieval, which itself no-ops when RAG is disabled.
  retrieveCodeContextFn?: typeof retrieveCodeContext;
  // DI seam for tests — real callers never pass this. Same pattern as
  // runTaskFn/buildProvidersFn above, added so the checkpoint loop's
  // recoverable-failure handling (Part D) is testable without depending on
  // real Figma OAuth/DB state.
  runAgentLoopFn?: (params: RunAgentLoopParams) => Promise<RunAgentLoopResult>;
}

// Was 15 — real transcript showed a dev phase burn all 15 turns on 11
// straight edit_file calls building out one page's sections, never even
// reaching QA. 15 was tight even for a single-pass phase with no iteration
// at all; paired with the write-the-whole-file guidance in SHARED_TOOLS_NOTE
// (systemPrompt.ts) so the extra room gets spent converging, not on more of
// the same small-edit pattern.
const PHASE_MAX_TURNS = 25;
// QA specifically needs room for a real fix-then-retest loop (write/run a
// check, diagnose a failure, fix it, re-run) on top of that — real
// transcript: it separately hit the (lower, at the time) turn cap mid-loop
// on a genuine iteration, not stuck thrashing (see QA_PERSISTENCE_BLOCK in
// systemPrompt.ts for the other half of this fix — the prompt guidance that
// makes the extra budget actually converge instead of just delaying the cap).
const QA_PHASE_MAX_TURNS = 40;

function maxTurnsForDepartment(department: DepartmentKey | "semua"): number {
  return department === "qa" ? QA_PHASE_MAX_TURNS : PHASE_MAX_TURNS;
}

// Tap ids from MANAJEMEN_CHECKPOINT_OPTIONS (router/handler.ts) mapped to the
// role's display name. Shared here (not duplicated in handler.ts) since both
// the deterministic AI-classifier-bypass check there and the role-Q&A
// state machine below need the exact same set.
export const MANAJEMEN_ROLE_QUESTIONS: Record<string, string> = {
  "Tanya Product Owner?": "Product Owner",
  "Tanya Project Manager?": "Project Manager",
  "Tanya System Analyst?": "System Analyst",
};

// Tap id from router/handler.ts's DESAIN_SOURCE_CHECKPOINT_OPTIONS. The
// other two options there ("Hubungkan Figma" / "Serahkan ke AI") need no
// equivalent constant: "Hubungkan Figma" reuses router/parse.ts's existing
// isConnectFigmaCommand phrase match (its id is literally "hubungkan figma"),
// and "Serahkan ke AI" needs no special handling at all — it's a complete
// answer on its own, so it just flows through the normal revise path below
// like any other typed reply. Only "Upload gambar" needs code-level
// interception, since tapping it isn't itself an answer — the actual image
// has to arrive as a separate message afterward.
export const DESAIN_SOURCE_UPLOAD_IMAGE_TAP = "Upload gambar";

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
    retrieveCodeContextFn = retrieveCodeContext,
  } = params;

  // Retrieval is best-effort: a throw or a miss just means the phase runs
  // with no extra context, exactly as before RAG existed.
  const codeNotesFor = async (query: string): Promise<string[]> => {
    const note = await retrieveCodeContextFn({
      projectAlias,
      query,
      signal: abortController.signal,
      taskId,
    }).catch(() => undefined);
    return note ? [note] : [];
  };

  // A single "semua" phase means classification didn't find anything
  // department-specific — behave exactly like the old single-loop task.
  if (phases.length === 1 && phases[0].department === "semua") {
    const preferredProvider = departmentModelLookup("semua");
    const extraSystemNotes = await codeNotesFor(instruction);
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
          extraSystemNotes,
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
          extraSystemNotes,
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

    // Query with the phase's own note folded in, so e.g. the QA phase pulls
    // test files and the dev phase pulls the code it'll be editing.
    const phaseCodeNotes = await codeNotesFor(`${instruction}\n\n${phase.note}`);

    const runPhase = () =>
      runAgentLoopFn({
        providers: buildProvidersFn(providerName),
        systemPrompt,
        instruction,
        cwd,
        taskId,
        abortController,
        onProgress,
        maxTurns: maxTurnsForDepartment(phase.department),
        sendDocument,
        onDangerousBash,
        extraSystemNotes: phaseCodeNotes,
      });

    let result = await runPhase();

    // Recoverable (e.g. "Figma belum kesambung") on a phase's very first run
    // — not just the checkpoint-revision loop further down, which already
    // handled this. Reuses the same checkpoint wait/resolve primitives
    // handler.ts's handlePendingCheckpoint already resolves on the user's
    // next message (including its "hubungkan figma" special-case that sends
    // the OAuth link but leaves this pending) — "continue" and "revise" both
    // just mean "try again" here, there's nothing to revise about a
    // recoverable failure, the user just needs to fix the actual blocker.
    while (!result.ok && result.recoverable) {
      await onProgress(result.summary);
      const resolution = await waitForCheckpoint(taskId, abortController.signal);
      if (resolution.action === "cancel") {
        return { ok: false, cancelled: true, summary: `Dibatalin pas fase "${label}" nunggu perbaikan.` };
      }
      result = await runPhase();
    }

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
      // Set while waiting specifically for the follow-up question after a
      // "Tanya <Role>?" tap — see below. A local variable rather than any
      // persisted state, since its whole lifetime is this one loop.
      let pendingRoleQuestion: string | undefined;
      // Set while waiting specifically for the image after an "Upload
      // gambar" tap — same reasoning as pendingRoleQuestion above.
      let awaitingDesignImage = false;
      // True only for the desain department's first checkpoint, and only
      // when the task instruction didn't already carry a design source
      // (Figma link / image description) — same check systemPrompt.ts uses
      // to decide whether to inject the "ask first" instruction at all, so
      // the tappable options and the model's own instructions stay in sync.
      // Flips to false the moment we actually run the agent loop for this
      // phase again, whatever the resolution turned out to be — once the
      // model's had a real shot at the answer, this checkpoint behaves like
      // any other from then on, whether or not the answer was perfect.
      let designSourceStillNeeded = phase.department === "desain" && !hasDesignSource(instruction);

      for (;;) {
        // Skipped while waiting for a role-specific follow-up or the
        // promised image — re-showing the full "fase kelar" summary + menu
        // mid-exchange would read as if the checkpoint had reset, when it's
        // really just waiting on what the user already said they'd send.
        if (!pendingRoleQuestion && !awaitingDesignImage) {
          await onCheckpoint(
            `Fase "${label}" kelar:\n${result.summary}\n\nLanjut ke fase berikutnya, atau ketik apa yang mau diubah/ditanyain dulu.`,
            phase.department,
            designSourceStillNeeded
          );
        }
        auditLog.add(taskId, "note", `Checkpoint: nunggu review buat fase "${label}"`);

        const resolution = await waitForCheckpoint(taskId, abortController.signal);
        if (resolution.action === "cancel") {
          return { ok: false, cancelled: true, summary: `Dibatalin pas checkpoint fase "${label}".` };
        }
        if (resolution.action === "continue") break;

        // "Upload gambar" isn't itself a design source — it's the user
        // saying the actual image is coming next. Don't run the agent loop
        // yet (there's nothing to design from until the image arrives);
        // just say so and wait. The image itself, once sent, already flows
        // in as a normal revise instruction (router/handler.ts's
        // handlePendingCheckpoint describes it and merges it in) — no
        // special handling needed for that part.
        if (designSourceStillNeeded && resolution.instruction === DESAIN_SOURCE_UPLOAD_IMAGE_TAP) {
          awaitingDesignImage = true;
          await onProgress("Oke, kirim gambarnya sekarang ya.");
          continue;
        }

        // A "Tanya <Role>?" tap isn't itself a question the model can answer
        // — it's the user asking for the chance to ask one. Don't run the
        // agent loop yet; just invite the real question and loop back to
        // wait again (also handles switching roles mid-flow: tapping a
        // different role before asking just re-targets pendingRoleQuestion).
        const tappedRole = MANAJEMEN_ROLE_QUESTIONS[resolution.instruction];
        if (tappedRole) {
          pendingRoleQuestion = tappedRole;
          await onProgress(`Oke, mau nanya apa ke ${tappedRole}? Tinggal ketik langsung.`);
          continue;
        }

        const askedAsRole = pendingRoleQuestion;
        pendingRoleQuestion = undefined; // consumed either way — answered or not, we're out of role-Q&A mode next
        awaitingDesignImage = false;
        designSourceStillNeeded = false;

        // Not "aku revisi ... : X" — X isn't necessarily an edit request. A
        // checkpoint reply that isn't yes/no could just as easily be "tunjukkan
        // plan nya" (a question) as "tambahin fitur X" (an actual revision);
        // labeling both as "revisi" upfront both misleads the user about what's
        // happening and primes the model to treat a plain question as an edit
        // instruction. Left to the model to tell apart via the instruction below
        // — except when askedAsRole is set, where the framing is explicit
        // instead of relying on the model to infer which role is being asked.
        await onProgress(`Oke, aku tindak lanjuti dulu ya: ${resolution.instruction}`);
        const instructionForModel = askedAsRole
          ? `Instruksi awal buat fase ini: ${phase.note}\n\nHasil sebelumnya: ${result.summary}\n\nUser lagi nanya spesifik ke ${askedAsRole}: "${resolution.instruction}"\n\nJawab pertanyaan ini spesifik dari sudut pandang ${askedAsRole} — first-person, sesuai apa yang udah diputusin ${askedAsRole} buat task ini, bukan jawaban umum. Jangan ubah hasil sebelumnya, jangan narasi ulang role lain, jangan pakai format "*1./2./3.*" lagi. Singkat aja (2-4 baris, tanpa markdown header).`
          : `Instruksi awal buat fase ini: ${phase.note}\n\nHasil sebelumnya: ${result.summary}\n\nUser bilang: "${resolution.instruction}"\n\nKalau ini permintaan buat mengubah atau menambah sesuatu di hasil sebelumnya, revisi hasilnya sesuai itu. Kalau ini cuma pertanyaan atau minta ditunjukin/dijelasin sesuatu (mis. isi sebuah file yang udah dibikin), jawab langsung — jangan ubah hasil sebelumnya kalau memang nggak diminta.`;
        const revised = await runAgentLoopFn({
          providers: buildProvidersFn(providerName),
          systemPrompt,
          instruction: instructionForModel,
          cwd,
          taskId,
          abortController,
          onProgress,
          maxTurns: maxTurnsForDepartment(phase.department),
          sendDocument,
          onDangerousBash,
          extraSystemNotes: phaseCodeNotes,
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
