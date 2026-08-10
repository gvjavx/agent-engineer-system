import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  conversationRepo,
  projectsRepo,
  tasksRepo,
  auditLog,
  type Project,
} from "../db/index.js";
import { sendWhatsApp, sendWhatsAppDocument, type QuickReplyOption } from "../whatsappClient.js";
import { ensureWorkspace, createWorkBranch, ensureLocalFolder } from "../git/repo.js";
import { buildProviders, splitProviderSpec } from "../agent/runner.js";
import { checkProviderStatus } from "../agent/providerStatus.js";
import { classifyDepartments } from "../agent/classifier.js";
import { classifyCommandIntent } from "../agent/commandIntent.js";
import { classifyConfirmationIntent, type ConfirmationIntent } from "../agent/confirmationIntent.js";
import { describeImage } from "../agent/imageDescription.js";
import { explainInSimpleTerms } from "../agent/explainAssistant.js";
import { listGeminiModels, listOpenAiCompatibleModels } from "../agent/modelCatalog.js";
import { runPipeline, type PhaseSpec, type PipelineMode } from "../agent/pipeline.js";
import { DEPARTMENT_KEYS, DEPARTMENT_LABELS, normalizeDepartment } from "../agent/departments.js";
import { buildAuthorizeUrl } from "../agent/mcp/figmaAuth.js";
import { createPendingState } from "../agent/mcp/figmaOAuthState.js";
import { resolveCheckpoint, hasPendingCheckpoint } from "../agent/checkpoint.js";
import { waitForBashApproval, resolveBashApproval, hasPendingBashApproval } from "../agent/bashApproval.js";
import { resolveWithin } from "../agent/tools.js";
import { resolveDocumentMimeType, MAX_DOCUMENT_BYTES } from "../agent/documentGuard.js";
import { config } from "../config.js";
import { enqueueProjectTask, cancelActiveTask, getActiveTaskId } from "../queue/taskQueue.js";
import {
  parseAddProject,
  parseAddFolder,
  parseUseProject,
  parseUseModel,
  parseListModelsForProvider,
  isListProjectsCommand,
  isListModelsCommand,
  isHelpCommand,
  isStatusCommand,
  isStopCommand,
  isConfirmYes,
  isConfirmNo,
  isConfirmYesWithCheckpoints,
  isIntroCommand,
  isConnectFigmaCommand,
  isGreetingCommand,
  isAllowedRepoUrl,
  isPlausibleShortCommand,
} from "./parse.js";

const INTRO_TEXT = `Aku Mas ADE — AI Developer Engineer. Gampangnya, aku ini software house yang isinya AI: bisa jadi PM buat nangkep kebutuhan, BA buat analisis, engineer buat ngoding (backend/frontend), sampai QA buat ngetes — semua dari chat WhatsApp ini. Yang gak aku pegang cuma manajemen eksekutif; selain itu, dari ide sampai push ke repo, aku yang jalanin.

Mau mulai? Daftarin project dulu, atau ketik "bantuan" buat lihat semua perintahnya.`;

const GREETING_TEXT = `Halo, baik nih! Ada yang mau dikerjain, atau ketik "bantuan" dulu kalau mau lihat-lihat perintahnya.`;

// For non-technical "how does this work" questions — no command syntax, no
// jargon. Separate from HELP_TEXT (the command cheatsheet) on purpose: someone
// asking in plain language wants a plain-language answer, not a syntax dump.
const EXPLAIN_TEXT = `Gampangnya gini: kamu tinggal certain apa yang kamu mau, kayak ngobrol biasa aja — misalnya "bikinin aku toko online buat jualan baju" atau "tambahin fitur login di aplikasi yang kemarin".

Abis itu, buat request bikin aplikasi, biasanya aku jalanin langkah-langkah kayak gini (cuma yang relevan buat request kamu aja yang jalan, gak semuanya tiap kali):
1. Pertama, aku bertindak sebagai Product Owner — nangkep dulu kebutuhan kamu sebenernya dan nentuin cakupan yang paling masuk akal.
2. Abis itu aku bertindak sebagai Project Manager — ngatur urutan kerjaan, bagian mana yang perlu dikerjain duluan.
3. Lalu aku bertindak sebagai System Analyst — mikirin alur kerja dan kebutuhan sistemnya biar sesuai sama yang kamu mau.
4. Masuk ke bagian UI/UX — kamu bisa hubungin aku ke desain Figma yang udah kamu buat sebelumnya, atau biarin aku yang desain otomatis.
5. Abis UI/UX kelar, aku mulai nulis kodenya berdasarkan yang udah disepakati di langkah-langkah sebelumnya.
6. Terakhir aku bertindak sebagai QA/Tester — nyariin bug dan mastiin semua fungsinya jalan dengan bener.

Kalau requestnya butuh (mis. mau di-publish biar bisa diakses orang, atau ada hal non-teknis di sisi bisnis), kadang ada tahap tambahan buat urus infrastruktur/publikasi atau sisi bisnisnya juga.

Sebelum mulai, aku kasih tau dulu rencananya dan tunggu kamu bilang oke. Selama proses aku kabarin progressnya lewat chat ini, dan kamu bisa berhentiin kapan aja kalau berubah pikiran. Begitu kelar, hasilnya langsung siap dipakai — gak perlu kamu utak-atik sendiri.

Kalau nanti udah lebih kenal dan mau tau perintah-perintah teknisnya, tinggal ketik "bantuan".`;

const DEPARTMENT_LIST_TEXT = DEPARTMENT_KEYS.map((k) => `${k} (${DEPARTMENT_LABELS[k]})`).join(", ");

const HELP_TEXT = `Ini yang bisa aku bantu:
- *daftar project* — lihat semua project yang udah terdaftar
- *tambah project <nama> <url-repo>* — daftarin repo GitHub baru
- *tambah folder <nama> <path-lokal>* — daftarin folder lokal di server (bukan lewat git)
- *pakai <nama>* — ganti project aktif buat chat ini
- *daftar model* — cek AI model yang aku pakai per departemen, masih bisa dipakai atau lagi bermasalah
- *daftar model <provider> <kata kunci>* — cari model spesifik di provider itu (mis. "daftar model gemini flash") — cuma yang bisa dipakai yang ditampilin
- *pakai model <nama>* atau *pakai model <provider>/<model>* — model AI default (dipakai departemen yang belum punya model sendiri)
- *pakai model <departemen> <nama>* atau *pakai model <departemen> <provider>/<model>* — model AI khusus satu departemen (${DEPARTMENT_LIST_TEXT})
- *status* — cek task yang lagi jalan
- *stop* — batalin task yang lagi jalan di project aktif
- *hubungkan figma* — sambungin akun Figma kamu (sekali aja) biar aku bisa baca desainnya
- Tempel link Figma langsung di instruksi (mis. "bikin komponen dari desain ini: https://figma.com/design/...") — aku bakal baca layer/style/variabel-nya, cuma baca aja, gak pernah aku ubah
- Kirim gambar (screenshot, mockup, dsb) bareng caption instruksinya (mis. "perbaiki tampilan sesuai screenshot ini") — aku bakal liat gambarnya dulu baru mulai kerjain. Kirim tanpa caption juga boleh, nanti aku ceritain apa yang aku liat terus tanya mau diapain.
- Atau langsung ketik aja apa yang mau dikerjain (mis. "tambahin endpoint health check"). Aku bakal tebak departemen mana yang perlu ngerjain, kasih tau rencananya, baru mulai setelah kamu konfirmasi — kalau rencananya lebih dari satu fase, kamu bisa pilih "review tiap fase" biar aku pause dulu abis tiap fase kelar, nunggu kamu approve atau minta revisi sebelum lanjut.`;

interface PendingAddFolder {
  type: "confirm_add_folder";
  alias: string;
  path: string;
}

interface PendingPipeline {
  type: "confirm_pipeline";
  alias: string;
  instruction: string;
  phases: PhaseSpec[];
}

type PendingActionData = PendingAddFolder | PendingPipeline;

const YES_NO_OPTIONS: QuickReplyOption[] = [
  { id: "ya", title: "Ya, lanjut" },
  { id: "tidak", title: "Tidak, batal" },
];

// Offered instead of YES_NO_OPTIONS when a plan has more than one phase —
// checkpoint mode is opt-in per task, chosen right here instead of a
// separate toggle command, so it's always an explicit, visible choice.
const PLAN_CONFIRM_OPTIONS: QuickReplyOption[] = [
  { id: "ya", title: "Ya, langsung" },
  { id: "ya, checkpoint", title: "Ya, review tiap fase" },
  { id: "tidak", title: "Tidak, batal" },
];

// Cap on how long a message can be before it's not even worth spending an AI
// call to check whether it's a paraphrase of one of these commands — see
// isPlausibleShortCommand in parse.ts. Provisional, easy to retune.
const COMMAND_INTENT_MAX_WORDS = 12;
// Confirmation replies are inherently short, so a tighter bound is safe here.
const CONFIRMATION_INTENT_MAX_WORDS = 8;

export async function handleInboundMessage(
  from: string,
  text: string,
  image?: { mimeType: string; base64Data: string }
): Promise<void> {
  const trimmed = text.trim();

  const bashApprovalReply = await handlePendingBashApproval(from, trimmed);
  if (bashApprovalReply) return;

  const checkpointReply = await handlePendingCheckpoint(from, trimmed);
  if (checkpointReply) return;

  const pendingReply = await handlePendingConfirmation(from, trimmed);
  if (pendingReply) return;

  // Checked after the three pending-state handlers above (not before) — an
  // image arriving while the user has an unresolved confirmation must not
  // silently overwrite it. Image and text are mutually exclusive at the
  // webhook level, so this doesn't create any ordering conflict with the
  // text-command matchers below.
  if (image) {
    await handleImageMessage(from, trimmed, image);
    return;
  }

  if (isIntroCommand(trimmed)) {
    await handleIntroCommand(from);
    return;
  }

  if (isGreetingCommand(trimmed)) {
    await handleGreetingCommand(from);
    return;
  }

  if (isHelpCommand(trimmed)) {
    await handleHelpCommand(from);
    return;
  }

  if (isListProjectsCommand(trimmed)) {
    await handleListProjectsCommand(from);
    return;
  }

  if (isListModelsCommand(trimmed)) {
    await handleListModelsCommand(from);
    return;
  }

  const listModelsForProvider = parseListModelsForProvider(trimmed);
  if (listModelsForProvider) {
    await handleListModelsForProvider(from, listModelsForProvider.provider, listModelsForProvider.query);
    return;
  }

  const useModelCommand = parseUseModel(trimmed);
  if (useModelCommand) {
    const department = normalizeDepartment(useModelCommand.department);
    if (!department) {
      await sendWhatsApp(
        from,
        `Departemen "${useModelCommand.department}" gak aku kenal. Pilihannya: ${DEPARTMENT_LIST_TEXT}, atau "semua".`
      );
      return;
    }
    const { name: providerName, model } = splitProviderSpec(useModelCommand.provider);
    if (!config.providerOrder.includes(providerName)) {
      const names = config.providerOrder.map((n) => `• ${n}`).join("\n");
      await sendWhatsApp(
        from,
        `Provider "${providerName}" gak ada di daftar. Yang aktif sekarang:\n${names}`
      );
      return;
    }
    if (model) {
      await sendWhatsApp(from, `Bentar, aku cek dulu apakah "${model}" di ${providerName} bisa dipakai...`);
      const candidate = buildProviders(useModelCommand.provider)[0];
      const status = await checkProviderStatus(candidate);
      if (status.state !== "ok") {
        const reason =
          status.state === "rate_limited" ? "lagi kena limit" : `error: ${status.message.slice(0, 150)}`;
        await sendWhatsApp(
          from,
          `Model "${providerName}/${model}" gak bisa dipakai sekarang (${reason}). Coba model lain, atau ketik "daftar model ${providerName} <kata kunci>" buat cari yang masih bisa.`
        );
        return;
      }
    }
    if (department === "semua") {
      conversationRepo.setPreferredProvider(from, useModelCommand.provider);
      await sendWhatsApp(from, `Oke, "${useModelCommand.provider}" jadi model default buat chat ini.`);
    } else {
      conversationRepo.setDepartmentModel(from, department, useModelCommand.provider);
      await sendWhatsApp(
        from,
        `Oke, ${DEPARTMENT_LABELS[department]} sekarang pakai model "${useModelCommand.provider}".`
      );
    }
    return;
  }

  const addCommand = parseAddProject(trimmed);
  if (addCommand) {
    const { alias, repoUrl } = addCommand;
    if (projectsRepo.get(alias)) {
      await sendWhatsApp(from, `Project "${alias}" udah ada, gak perlu didaftarin lagi.`);
      return;
    }
    if (!isAllowedRepoUrl(repoUrl)) {
      await sendWhatsApp(
        from,
        `URL "${repoUrl}" gak valid. Harus link repo GitHub https://, format https://github.com/owner/repo.`
      );
      return;
    }
    await sendWhatsApp(from, `Oke, aku daftarin "${alias}" dulu ya, lagi clone repo-nya...`);
    try {
      const project = projectsRepo.create(alias, repoUrl);
      await ensureWorkspace(project);
      conversationRepo.setActiveProject(from, alias);
      await sendWhatsApp(
        from,
        `Beres, "${alias}" udah terdaftar dan siap dipakai. Sekarang jadi project aktif buat chat ini.`
      );
    } catch (err) {
      await sendWhatsApp(
        from,
        `Waduh, gagal daftarin/clone "${alias}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }

  const addFolderCommand = parseAddFolder(trimmed);
  if (addFolderCommand) {
    const { alias, path: rawPath } = addFolderCommand;
    if (projectsRepo.get(alias)) {
      await sendWhatsApp(from, `Project "${alias}" udah ada, gak perlu didaftarin lagi.`);
      return;
    }
    const resolvedPath = path.resolve(rawPath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      await sendWhatsApp(from, `Folder "${resolvedPath}" gak ketemu di server. Cek lagi path-nya ya.`);
      return;
    }
    const pending: PendingAddFolder = { type: "confirm_add_folder", alias, path: resolvedPath };
    conversationRepo.setPendingAction(from, JSON.stringify(pending));
    await sendWhatsApp(
      from,
      `Ini folder lokal di server, bukan repo git — kalau aku daftarin, aku bisa baca, ubah, dan bikin file/folder apapun di dalam "${resolvedPath}" (semua isinya, bukan cuma yang kamu sebut). Boleh lanjut?`,
      YES_NO_OPTIONS
    );
    return;
  }

  const useAlias = parseUseProject(trimmed);
  if (useAlias) {
    const alias = useAlias;
    const project = projectsRepo.get(alias);
    if (!project) {
      await sendWhatsApp(from, `Project "${alias}" belum ada. Ketik "daftar project" buat lihat daftarnya.`);
      return;
    }
    conversationRepo.setActiveProject(from, alias);
    await sendWhatsApp(from, `Oke, project aktif sekarang "${alias}".`);
    return;
  }

  if (isStatusCommand(trimmed)) {
    await handleStatusCommand(from);
    return;
  }

  if (isStopCommand(trimmed)) {
    await handleStopCommand(from);
    return;
  }

  if (isConnectFigmaCommand(trimmed)) {
    await handleConnectFigmaCommand(from);
    return;
  }

  // Nothing matched exactly — before assuming it's a coding task, check
  // whether it's actually a paraphrase of one of the 7 commands above.
  if (await tryHandleSemanticCommand(from, trimmed)) return;

  // Default: free-text instruction -> classify departments -> confirm -> pipeline.
  await handleFreeTextInstruction(from, trimmed);
}

async function handleIntroCommand(from: string): Promise<void> {
  await sendWhatsApp(from, INTRO_TEXT);
}

async function handleGreetingCommand(from: string): Promise<void> {
  await sendWhatsApp(from, GREETING_TEXT);
}

async function handleHelpCommand(from: string): Promise<void> {
  await sendWhatsApp(from, HELP_TEXT);
}

async function handleExplainCommand(from: string, question: string): Promise<void> {
  const state = conversationRepo.get(from);
  const providers = buildProviders(state?.preferred_provider ?? undefined);
  const answer =
    providers.length > 0
      ? await explainInSimpleTerms(question, providers[0], new AbortController().signal)
      : undefined;
  await sendWhatsApp(from, answer ?? EXPLAIN_TEXT);
}

async function handleListProjectsCommand(from: string): Promise<void> {
  const projects = projectsRepo.list();
  if (projects.length === 0) {
    await sendWhatsApp(
      from,
      "Belum ada project yang terdaftar nih. Daftarin dulu ya, ketik: tambah project <nama> <url-repo>"
    );
  } else {
    const lines = projects.map((p) => `• ${p.alias}${p.kind === "local" ? " (folder lokal)" : ""} — ${p.repo_url}`);
    await sendWhatsApp(from, `Ini project yang udah terdaftar:\n${lines.join("\n")}`);
  }
}

async function handleListModelsCommand(from: string): Promise<void> {
  const state = conversationRepo.get(from);
  const providers = buildProviders();
  await sendWhatsApp(from, "Bentar, aku cek satu-satu dulu ya...");

  const results = await Promise.all(
    providers.map(async (provider) => ({
      name: provider.name,
      status: await checkProviderStatus(provider),
    }))
  );

  // Multiple API keys for the same provider all share provider.name — number
  // them ("gemini (key 2/5)") so a dead key among several isn't invisible.
  const totalPerName = new Map<string, number>();
  for (const r of results) totalPerName.set(r.name, (totalPerName.get(r.name) ?? 0) + 1);
  const seenPerName = new Map<string, number>();

  const providerLines = results.map(({ name, status }) => {
    const total = totalPerName.get(name) ?? 1;
    const index = (seenPerName.get(name) ?? 0) + 1;
    seenPerName.set(name, index);
    const label = total > 1 ? `${name} (key ${index}/${total})` : name;
    const tag = name === state?.preferred_provider ? " (default)" : "";
    const desc =
      status.state === "ok"
        ? "bisa dipakai"
        : status.state === "rate_limited"
          ? "lagi kena limit, coba lagi sebentar"
          : `error — ${status.message.slice(0, 150)}`;
    return `• ${label}${tag} — ${desc}`;
  });

  const deptModels = conversationRepo.getDepartmentModels(from);
  const deptLines = DEPARTMENT_KEYS.map(
    (key) => `• ${DEPARTMENT_LABELS[key]}: ${deptModels[key] ?? "(pakai default)"}`
  );
  const defaultLine = `Default (semua): ${state?.preferred_provider ?? "otomatis, provider pertama yang aktif"}`;

  await sendWhatsApp(
    from,
    `Provider yang aktif:\n${providerLines.join("\n")}\n\nModel per departemen:\n${deptLines.join("\n")}\n${defaultLine}`
  );
}

async function handleStatusCommand(from: string): Promise<void> {
  const state = conversationRepo.get(from);
  if (!state?.active_project_alias) {
    await sendWhatsApp(from, 'Belum ada project aktif nih. Ketik "pakai <nama>" dulu ya.');
    return;
  }
  const activeTaskId = getActiveTaskId(state.active_project_alias);
  if (!activeTaskId) {
    const recent = tasksRepo.recentForNumber(from, 1)[0];
    await sendWhatsApp(
      from,
      recent
        ? `Gak ada task yang lagi jalan di "${state.active_project_alias}". Task terakhir statusnya: ${recent.status}.`
        : `Gak ada task yang lagi jalan di "${state.active_project_alias}".`
    );
  } else {
    const task = tasksRepo.get(activeTaskId);
    const phaseNote = auditLog.latestNote(activeTaskId);
    await sendWhatsApp(
      from,
      `Masih ngerjain task di "${state.active_project_alias}" nih:\n"${task?.instruction ?? ""}"` +
        (phaseNote ? `\n\nTerakhir: ${phaseNote}` : "")
    );
  }
}

async function handleStopCommand(from: string): Promise<void> {
  const state = conversationRepo.get(from);
  if (!state?.active_project_alias) {
    await sendWhatsApp(from, "Belum ada project aktif.");
    return;
  }
  const cancelledId = cancelActiveTask(state.active_project_alias);
  if (cancelledId) {
    tasksRepo.setStatus(cancelledId, "cancelled", "Dibatalkan oleh user via WhatsApp.");
    await sendWhatsApp(from, `Oke, task di "${state.active_project_alias}" udah aku batalin.`);
  } else {
    await sendWhatsApp(from, "Gak ada task yang lagi jalan.");
  }
}

async function handleConnectFigmaCommand(from: string): Promise<void> {
  if (!config.figma) {
    await sendWhatsApp(
      from,
      "Figma belum disetel di server (client ID OAuth-nya belum diisi di .env). Bilang ke yang pegang server ya."
    );
    return;
  }
  const state = createPendingState(from);
  const authorizeUrl = buildAuthorizeUrl(state);
  await sendWhatsApp(
    from,
    `Buka link ini buat sambungin akun Figma kamu, izinin aksesnya, nanti aku kabarin kalau udah connect:\n${authorizeUrl}`
  );
}

async function handleImageMessage(
  from: string,
  caption: string,
  image: { mimeType: string; base64Data: string }
): Promise<void> {
  const state = conversationRepo.get(from);
  const providers = buildProviders(state?.preferred_provider ?? undefined);
  if (providers.length === 0) {
    await sendWhatsApp(from, "Belum ada AI provider yang aktif, jadi aku belum bisa liat gambarnya.");
    return;
  }

  await sendWhatsApp(from, "Oke, aku liatin dulu ya gambarnya, bentar...");

  const description = await describeImage(
    image.base64Data,
    image.mimeType,
    caption || undefined,
    providers,
    new AbortController().signal
  );

  if (description === undefined) {
    await sendWhatsApp(
      from,
      'Waduh, kayaknya model AI yang aktif buat chat ini gak bisa "lihat" gambar. Coba ganti model dulu (ketik "daftar model" buat lihat pilihannya, terus "pakai model <nama>"), habis itu kirim ulang gambarnya ya.'
    );
    return;
  }

  if (caption) {
    const mergedInstruction = `${caption}\n\n(Gambar yang dikirim bareng ini nunjukkin: ${description})`;
    await handleFreeTextInstruction(from, mergedInstruction);
    return;
  }

  await sendWhatsApp(
    from,
    `Ini yang aku tangkep dari gambarnya:\n\n${description}\n\nMau aku apain nih? Kasih instruksinya ya, abis itu aku lanjutin.`
  );
}

// Fallback for when none of the commands above matched exactly — asks an
// AI provider whether this message means one of them anyway (a paraphrase),
// before handleFreeTextInstruction assumes it's a coding task. Gated by
// isPlausibleShortCommand so this never runs (and never costs an AI call)
// for messages that are clearly full task instructions already.
async function tryHandleSemanticCommand(from: string, trimmed: string): Promise<boolean> {
  if (!isPlausibleShortCommand(trimmed, COMMAND_INTENT_MAX_WORDS)) return false;

  const state = conversationRepo.get(from);
  const providers = buildProviders(state?.preferred_provider ?? undefined);
  if (providers.length === 0) return false; // let handleFreeTextInstruction give its own "no provider" message

  const intent = await classifyCommandIntent(trimmed, providers[0], new AbortController().signal);
  switch (intent) {
    case "intro":
      await handleIntroCommand(from);
      return true;
    case "greeting":
      await handleGreetingCommand(from);
      return true;
    case "help":
      await handleHelpCommand(from);
      return true;
    case "explain":
      await handleExplainCommand(from, trimmed);
      return true;
    case "list_projects":
      await handleListProjectsCommand(from);
      return true;
    case "list_models":
      await handleListModelsCommand(from);
      return true;
    case "status":
      await handleStatusCommand(from);
      return true;
    case "stop":
      await handleStopCommand(from);
      return true;
    case "connect_figma":
      await handleConnectFigmaCommand(from);
      return true;
    default:
      return false; // "none"
  }
}

// Shared by the three pending-handlers below. Fail-closed is structural, not
// something each caller audits: this only ever runs when both isConfirmYes
// and isConfirmNo already missed, and its "yes"/"no" results take exactly
// the same code paths those deterministic checks used to take — "unclear"
// (including "no provider configured" or "reply too long to bother") takes
// exactly the pre-existing default path each caller already had. No new code
// paths are introduced, only new ways to reach the existing ones.
async function interpretConfirmationReply(
  preferredProvider: string | undefined,
  trimmed: string
): Promise<ConfirmationIntent> {
  if (isConfirmYes(trimmed)) return "yes";
  if (isConfirmNo(trimmed)) return "no";
  if (!isPlausibleShortCommand(trimmed, CONFIRMATION_INTENT_MAX_WORDS)) return "unclear";
  const providers = buildProviders(preferredProvider);
  if (providers.length === 0) return "unclear";
  return classifyConfirmationIntent(trimmed, providers[0], new AbortController().signal);
}

// Checked before everything else: same in-memory-pending-per-taskId pattern
// as handlePendingCheckpoint below, but for a single risky bash command
// rather than a whole pipeline phase. Fails closed on anything but an
// explicit "ya" — an ambiguous reply shouldn't accidentally green-light a
// command flagged as dangerous in the first place.
async function handlePendingBashApproval(from: string, trimmed: string): Promise<boolean> {
  const state = conversationRepo.get(from);
  const taskId = state?.active_project_alias ? getActiveTaskId(state.active_project_alias) : undefined;
  if (!taskId || !hasPendingBashApproval(taskId)) return false;

  const intent = await interpretConfirmationReply(state?.preferred_provider ?? undefined, trimmed);
  const approved = intent === "yes";
  resolveBashApproval(taskId, approved);
  await sendWhatsApp(
    from,
    approved ? "Oke, aku jalanin ya." : "Oke, aku skip command itu, cari cara lain dulu."
  );
  return true;
}

// Checked before handlePendingConfirmation: a checkpoint pause is tied to a
// task that's currently mid-run (in-memory, see agent/checkpoint.ts), not to
// conversation_state.pending_action like the other confirmation flows below.
async function handlePendingCheckpoint(from: string, trimmed: string): Promise<boolean> {
  const state = conversationRepo.get(from);
  const taskId = state?.active_project_alias ? getActiveTaskId(state.active_project_alias) : undefined;
  if (!taskId || !hasPendingCheckpoint(taskId)) return false;

  const intent = await interpretConfirmationReply(state?.preferred_provider ?? undefined, trimmed);
  if (intent === "yes") {
    resolveCheckpoint(taskId, { action: "continue" });
  } else if (intent === "no") {
    resolveCheckpoint(taskId, { action: "cancel" });
  } else {
    // Anything else (including "unclear") is treated as the revision itself — no separate command needed.
    resolveCheckpoint(taskId, { action: "revise", instruction: trimmed });
  }
  return true; // the pipeline itself sends the next WhatsApp message once it resumes
}

// Local-folder registration and multi-department pipelines both need explicit
// confirmation before they run — local folders because the agent gets free
// rein over an arbitrary server folder, pipelines because the department
// breakdown is a guess that needs a human sanity check before it burns AI
// calls doing the wrong thing.
async function handlePendingConfirmation(from: string, trimmed: string): Promise<boolean> {
  const state = conversationRepo.get(from);
  if (!state?.pending_action) return false;

  let pending: PendingActionData;
  try {
    pending = JSON.parse(state.pending_action);
  } catch {
    conversationRepo.setPendingAction(from, null);
    return false;
  }

  if (pending.type === "confirm_add_folder") {
    const intent = await interpretConfirmationReply(state?.preferred_provider ?? undefined, trimmed);
    if (intent === "yes") {
      conversationRepo.setPendingAction(from, null);
      projectsRepo.createLocal(pending.alias, pending.path);
      conversationRepo.setActiveProject(from, pending.alias);
      await sendWhatsApp(
        from,
        `Oke, "${pending.alias}" aku daftarin ke folder itu. Sekarang jadi project aktif buat chat ini.`
      );
      return true;
    }
    conversationRepo.setPendingAction(from, null);
    if (intent === "no") {
      await sendWhatsApp(from, "Oke, gak jadi ya.");
    } else {
      await sendWhatsApp(from, 'Gak jelas jawabannya, jadi aku batalin dulu. Ulangi "tambah folder" lagi kalau masih mau.');
    }
    return true;
  }

  if (pending.type === "confirm_pipeline") {
    conversationRepo.setPendingAction(from, null);
    // Exact-match only — this option is always tap-generated via the third
    // quick-reply button, so there's no paraphrase to recognize here.
    if (isConfirmYesWithCheckpoints(trimmed)) {
      const project = projectsRepo.get(pending.alias);
      if (!project) {
        await sendWhatsApp(from, `Waduh, project "${pending.alias}" udah gak ada. Coba ulangi instruksinya.`);
        return true;
      }
      await executeTask(from, project, pending.instruction, pending.phases, true);
      return true;
    }
    const intent = await interpretConfirmationReply(state?.preferred_provider ?? undefined, trimmed);
    if (intent === "yes") {
      const project = projectsRepo.get(pending.alias);
      if (!project) {
        await sendWhatsApp(from, `Waduh, project "${pending.alias}" udah gak ada. Coba ulangi instruksinya.`);
        return true;
      }
      await executeTask(from, project, pending.instruction, pending.phases, false);
      return true;
    }
    if (intent === "no") {
      await sendWhatsApp(from, "Oke, gak jadi ya.");
    } else {
      await sendWhatsApp(from, "Gak jelas jawabannya, jadi aku batalin dulu. Kirim lagi instruksinya kalau masih mau.");
    }
    return true;
  }

  return false;
}

// Live-checked, not just catalog-listed: a model can exist in a provider's
// catalog but still 404/429 for this specific key (we've hit this ourselves
// with Gemini free-tier models), so "gak bisa dipakai jangan tampilkan" means
// actually calling each candidate, not just filtering the catalog metadata.
const MODEL_CHECK_LIMIT = 8;

async function handleListModelsForProvider(from: string, providerName: string, query: string): Promise<void> {
  if (!config.providerOrder.includes(providerName)) {
    const names = config.providerOrder.map((n) => `• ${n}`).join("\n");
    await sendWhatsApp(from, `Provider "${providerName}" gak ada di daftar. Yang aktif sekarang:\n${names}`);
    return;
  }

  await sendWhatsApp(from, `Bentar, aku cariin model "${query}" di ${providerName}...`);

  let candidates: string[];
  try {
    if (providerName === "gemini" && config.gemini) {
      // Catalog is the same regardless of which key asks, so the first one is enough here.
      candidates = await listGeminiModels(config.gemini.apiKeys[0], query);
    } else if (config.openAiCompatibleProviders[providerName]) {
      const { baseUrl, apiKeys } = config.openAiCompatibleProviders[providerName];
      candidates = await listOpenAiCompatibleModels(baseUrl, apiKeys[0], query);
    } else {
      await sendWhatsApp(from, `Provider "${providerName}" gak punya konfigurasi yang valid.`);
      return;
    }
  } catch (err) {
    await sendWhatsApp(
      from,
      `Gagal ambil daftar model dari ${providerName}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (candidates.length === 0) {
    await sendWhatsApp(from, `Gak ketemu model yang cocok sama "${query}" di ${providerName}.`);
    return;
  }

  const toCheck = candidates.slice(0, MODEL_CHECK_LIMIT);
  const results = await Promise.all(
    toCheck.map(async (model) => ({
      model,
      status: await checkProviderStatus(buildProviders(`${providerName}/${model}`)[0]),
    }))
  );

  const usable = results.filter((r) => r.status.state === "ok").map((r) => r.model);
  const capNote =
    candidates.length > MODEL_CHECK_LIMIT
      ? `\n\n(Ada ${candidates.length} model yang namanya cocok, aku cuma cek ${MODEL_CHECK_LIMIT} pertama biar gak kelamaan.)`
      : "";

  if (usable.length === 0) {
    await sendWhatsApp(
      from,
      `Ketemu ${toCheck.length} model yang namanya cocok, tapi semuanya lagi gak bisa dipakai (error/limit).${capNote}`
    );
    return;
  }

  const options: QuickReplyOption[] = usable.map((m) => ({
    id: `pakai model semua ${providerName}/${m}`,
    title: m,
    description: `${providerName}/${m}`,
  }));
  await sendWhatsApp(
    from,
    `Model yang cocok dan bisa dipakai sekarang — tap buat jadiin default, atau ketik "pakai model <departemen> ${providerName}/<nama-model>" buat satu departemen tertentu.${capNote}`,
    options,
    "Pilih model"
  );
}

async function handleFreeTextInstruction(from: string, instruction: string): Promise<void> {
  const state = conversationRepo.get(from);
  let alias = state?.active_project_alias ?? undefined;

  if (!alias) {
    const projects = projectsRepo.list();
    if (projects.length === 0) {
      await sendWhatsApp(
        from,
        `Belum ada project yang terdaftar nih. Daftarin dulu ya:\ntambah project <nama> <url-repo>`
      );
      return;
    }
    if (projects.length === 1) {
      alias = projects[0].alias;
      conversationRepo.setActiveProject(from, alias);
    } else {
      const options: QuickReplyOption[] = projects.map((p) => ({
        id: `pakai ${p.alias}`,
        title: p.alias,
        description: p.kind === "local" ? "Folder lokal" : p.repo_url,
      }));
      await sendWhatsApp(from, "Maksudnya project yang mana ya?", options, "Pilih project");
      return;
    }
  }

  const project = projectsRepo.get(alias) as Project;

  const classifierProviders = buildProviders(state?.preferred_provider ?? undefined);
  if (classifierProviders.length === 0) {
    await sendWhatsApp(from, "Belum ada AI provider yang aktif, jadi aku belum bisa kerja.");
    return;
  }

  await sendWhatsApp(from, "Bentar, aku pikirin dulu departemen mana yang perlu ngerjain ini...");
  const phases = await classifyDepartments(instruction, classifierProviders[0], new AbortController().signal);

  const deptModels = conversationRepo.getDepartmentModels(from);
  const planLines = phases.map((phase, i) => {
    const label = phase.department === "semua" ? "Satu langkah umum" : DEPARTMENT_LABELS[phase.department];
    const model =
      phase.department === "semua"
        ? (state?.preferred_provider ?? "default")
        : (deptModels[phase.department] ?? state?.preferred_provider ?? "default");
    return `${i + 1}. ${label} — ${phase.note} (model: ${model})`;
  });

  const pending: PendingPipeline = { type: "confirm_pipeline", alias: project.alias, instruction, phases };
  conversationRepo.setPendingAction(from, JSON.stringify(pending));

  // Checkpoint review only makes sense with an actual multi-fase pipeline —
  // the single-phase "semua" shortcut has nothing to pause between.
  const options = phases.length > 1 ? PLAN_CONFIRM_OPTIONS : YES_NO_OPTIONS;
  await sendWhatsApp(from, `Rencananya gini:\n${planLines.join("\n")}\n\nLanjut?`, options);
}

async function executeTask(
  from: string,
  project: Project,
  instruction: string,
  phases: PhaseSpec[],
  checkpoints: boolean
): Promise<void> {
  const state = conversationRepo.get(from);
  const taskId = crypto.randomUUID();
  tasksRepo.create(taskId, project.alias, from, instruction);

  await sendWhatsApp(from, `Oke, aku terima ya. Kalau ada task lain di depannya, ini bakal antre dulu.`);

  enqueueProjectTask(project.alias, taskId, async (abortController) => {
    tasksRepo.setStatus(taskId, "running");
    await sendWhatsApp(from, `Oke, mulai aku kerjain: "${instruction}"`);

    try {
      const onProgress = (msg: string) => {
        sendWhatsApp(from, msg).catch(() => {});
      };
      const onCheckpoint = (msg: string) => {
        sendWhatsApp(from, msg, YES_NO_OPTIONS).catch(() => {});
      };

      let cwd: string;
      let mode: PipelineMode;
      if (project.kind === "local") {
        cwd = await ensureLocalFolder(project);
        mode = { kind: "local", folderPath: cwd };
      } else {
        cwd = await ensureWorkspace(project);
        const workBranch = await createWorkBranch(cwd, taskId);
        mode = { kind: "git", defaultBranch: project.default_branch, workBranch, autoMerge: project.auto_merge };
      }

      const sendDocument = async (relPath: string, caption: string | undefined): Promise<string> => {
        let full: string;
        try {
          full = resolveWithin(cwd, relPath);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        const mimeType = resolveDocumentMimeType(full);
        if (!mimeType) {
          return `Error: tipe file "${relPath}" gak didukung buat dikirim sebagai dokumen.`;
        }
        const stat = await fs.promises.stat(full).catch(() => undefined);
        if (!stat) {
          return `Error: file "${relPath}" gak ketemu.`;
        }
        if (stat.size > MAX_DOCUMENT_BYTES) {
          return `Error: file "${relPath}" kegedean buat dikirim (maks ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB).`;
        }
        try {
          const contentBase64 = (await fs.promises.readFile(full)).toString("base64");
          await sendWhatsAppDocument(from, path.basename(full), mimeType, contentBase64, caption);
          return `Dokumen "${relPath}" berhasil dikirim ke user.`;
        } catch (err) {
          return `Error: gagal kirim dokumen — ${err instanceof Error ? err.message : String(err)}`;
        }
      };

      const onDangerousBash = async (command: string, reason: string): Promise<boolean> => {
        await sendWhatsApp(
          from,
          `Mau aku jalanin command ini?\n\`${command}\`\n\nAku tanya dulu soalnya: ${reason}. Balas ya/tidak.`,
          YES_NO_OPTIONS
        );
        return waitForBashApproval(taskId, abortController.signal);
      };

      const result = await runPipeline({
        taskId,
        cwd,
        projectAlias: project.alias,
        instruction,
        phases,
        abortController,
        onProgress,
        checkpoints,
        onCheckpoint,
        sendDocument,
        onDangerousBash,
        departmentModelLookup: (department) =>
          department === "semua"
            ? (state?.preferred_provider ?? undefined)
            : conversationRepo.getDepartmentModel(from, department),
        mode,
      });

      tasksRepo.setStatus(taskId, result.ok ? "done" : "failed", result.summary);
      await sendWhatsApp(
        from,
        result.ok ? `Udah selesai. ${result.summary}` : `Gagal nih. ${result.summary}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tasksRepo.setStatus(taskId, "failed", message);
      await sendWhatsApp(from, `Gagal nih, ada error: ${message}`);
    }
  });
}
