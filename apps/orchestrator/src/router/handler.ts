import crypto from "node:crypto";
import {
  conversationRepo,
  projectsRepo,
  tasksRepo,
  type Project,
} from "../db/index.js";
import { sendWhatsApp } from "../whatsappClient.js";
import { ensureWorkspace, createWorkBranch } from "../git/repo.js";
import { runTask } from "../agent/runner.js";
import { enqueueProjectTask, cancelActiveTask, getActiveTaskId } from "../queue/taskQueue.js";
import {
  parseAddProject,
  parseUseProject,
  isListProjectsCommand,
  isHelpCommand,
  isStatusCommand,
  isStopCommand,
} from "./parse.js";

const HELP_TEXT = `Perintah yang tersedia:
- *daftar project* — lihat semua project terdaftar
- *tambah project <nama> <url-repo>* — daftarkan repo baru
- *pakai <nama>* — pilih project aktif untuk chat ini
- *status* — lihat task yang sedang berjalan
- *stop* — batalkan task yang sedang berjalan di project aktif
- Ketik instruksi bebas apa saja (mis. "tambahin endpoint health check") untuk memberi tugas ke project aktif.`;

export async function handleInboundMessage(from: string, text: string): Promise<void> {
  const trimmed = text.trim();

  if (isHelpCommand(trimmed)) {
    await sendWhatsApp(from, HELP_TEXT);
    return;
  }

  if (isListProjectsCommand(trimmed)) {
    const projects = projectsRepo.list();
    if (projects.length === 0) {
      await sendWhatsApp(
        from,
        "Belum ada project terdaftar. Daftarkan dengan:\ntambah project <nama> <url-repo>"
      );
    } else {
      const lines = projects.map((p) => `• ${p.alias} — ${p.repo_url}`);
      await sendWhatsApp(from, `Project terdaftar:\n${lines.join("\n")}`);
    }
    return;
  }

  const addCommand = parseAddProject(trimmed);
  if (addCommand) {
    const { alias, repoUrl } = addCommand;
    if (projectsRepo.get(alias)) {
      await sendWhatsApp(from, `Project "${alias}" sudah terdaftar.`);
      return;
    }
    await sendWhatsApp(from, `⏳ Mendaftarkan "${alias}" dan meng-clone repo...`);
    try {
      const project = projectsRepo.create(alias, repoUrl);
      await ensureWorkspace(project);
      conversationRepo.setActiveProject(from, alias);
      await sendWhatsApp(
        from,
        `✅ Project "${alias}" terdaftar dan siap dipakai. Sekarang jadi project aktif untuk chat ini.`
      );
    } catch (err) {
      await sendWhatsApp(
        from,
        `❌ Gagal mendaftarkan/clone "${alias}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }

  const useAlias = parseUseProject(trimmed);
  if (useAlias) {
    const alias = useAlias;
    const project = projectsRepo.get(alias);
    if (!project) {
      await sendWhatsApp(from, `Project "${alias}" belum terdaftar. Ketik "daftar project" untuk lihat daftar.`);
      return;
    }
    conversationRepo.setActiveProject(from, alias);
    await sendWhatsApp(from, `✅ Project aktif diganti ke "${alias}".`);
    return;
  }

  if (isStatusCommand(trimmed)) {
    const state = conversationRepo.get(from);
    if (!state?.active_project_alias) {
      await sendWhatsApp(from, "Belum ada project aktif. Ketik \"pakai <nama>\" dulu.");
      return;
    }
    const activeTaskId = getActiveTaskId(state.active_project_alias);
    if (!activeTaskId) {
      const recent = tasksRepo.recentForNumber(from, 1)[0];
      await sendWhatsApp(
        from,
        recent
          ? `Tidak ada task berjalan di "${state.active_project_alias}". Task terakhir: ${recent.status}.`
          : `Tidak ada task berjalan di "${state.active_project_alias}".`
      );
    } else {
      const task = tasksRepo.get(activeTaskId);
      await sendWhatsApp(
        from,
        `⏳ Sedang mengerjakan task di "${state.active_project_alias}":\n"${task?.instruction ?? ""}"`
      );
    }
    return;
  }

  if (isStopCommand(trimmed)) {
    const state = conversationRepo.get(from);
    if (!state?.active_project_alias) {
      await sendWhatsApp(from, "Tidak ada project aktif.");
      return;
    }
    const cancelledId = cancelActiveTask(state.active_project_alias);
    if (cancelledId) {
      tasksRepo.setStatus(cancelledId, "cancelled", "Dibatalkan oleh user via WhatsApp.");
      await sendWhatsApp(from, `🛑 Task di "${state.active_project_alias}" dibatalkan.`);
    } else {
      await sendWhatsApp(from, "Tidak ada task yang sedang berjalan.");
    }
    return;
  }

  // Default: free-text instruction -> new task on the active project.
  await handleFreeTextInstruction(from, trimmed);
}

async function handleFreeTextInstruction(from: string, instruction: string): Promise<void> {
  const state = conversationRepo.get(from);
  let alias = state?.active_project_alias ?? undefined;

  if (!alias) {
    const projects = projectsRepo.list();
    if (projects.length === 0) {
      await sendWhatsApp(
        from,
        `Belum ada project terdaftar. Daftarkan dulu dengan:\ntambah project <nama> <url-repo>`
      );
      return;
    }
    if (projects.length === 1) {
      alias = projects[0].alias;
      conversationRepo.setActiveProject(from, alias);
    } else {
      const names = projects.map((p) => `• ${p.alias}`).join("\n");
      await sendWhatsApp(
        from,
        `Project mana yang dimaksud? Ketik "pakai <nama>" dulu:\n${names}`
      );
      return;
    }
  }

  const project = projectsRepo.get(alias) as Project;
  const taskId = crypto.randomUUID();
  tasksRepo.create(taskId, project.alias, from, instruction);

  await sendWhatsApp(from, `📥 Task diterima untuk "${project.alias}". Antre di belakang task lain (jika ada)...`);

  enqueueProjectTask(project.alias, taskId, async (abortController) => {
    tasksRepo.setStatus(taskId, "running");
    await sendWhatsApp(from, `🚀 Mulai kerjain: "${instruction}"`);

    try {
      const dir = await ensureWorkspace(project);
      const workBranch = await createWorkBranch(dir, taskId);

      const result = await runTask({
        taskId,
        cwd: dir,
        projectAlias: project.alias,
        defaultBranch: project.default_branch,
        workBranch,
        autoMerge: project.auto_merge,
        instruction,
        abortController,
        onProgress: (msg) => {
          sendWhatsApp(from, msg).catch(() => {});
        },
      });

      tasksRepo.setStatus(taskId, result.ok ? "done" : "failed", result.summary);
      await sendWhatsApp(
        from,
        `${result.ok ? "✅" : "⚠️"} ${result.summary}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tasksRepo.setStatus(taskId, "failed", message);
      await sendWhatsApp(from, `❌ Task gagal: ${message}`);
    }
  });
}
