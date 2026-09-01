import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  conversationRepo,
  projectsRepo,
  tasksRepo,
  auditLog,
  memoryRepo,
  chatHistoryRepo,
  sessionRepo,
  figmaAppConfigRepo,
  type Project,
} from "../db/index.js";
import { sendWhatsApp, sendWhatsAppDocument, type QuickReplyOption } from "../whatsappClient.js";
import { ensureWorkspace, createWorkBranch, ensureLocalFolder, removeWorkspace, discardWorkBranch, workspacePath } from "../git/repo.js";
import { indexProject, deleteProjectIndex } from "../agent/rag/index.js";
import { recordInteraction } from "../agent/chatKb.js";
import { chatKbRepo, kbStatsRepo } from "../db/chatKb.js";
import { buildProviders, splitProviderSpec, primaryModelForProvider } from "../agent/runner.js";
import { checkProviderStatus, describeProviderStatus } from "../agent/providerStatus.js";
import { classifyDepartments } from "../agent/classifier.js";
import { classifyIntent } from "../agent/commandIntent.js";
import { checkNeedsClarification } from "../agent/requestClarity.js";
import { classifyConfirmationIntent, type ConfirmationIntent } from "../agent/confirmationIntent.js";
import { describeImage, mergeImageDescription } from "../agent/imageDescription.js";
import { generateChatReply, needsConversationContext } from "../agent/chatAssistant.js";
import type { Provider } from "../agent/types.js";
import { explainInSimpleTerms, introduceYourself, explainHelp } from "../agent/dynamicReplies.js";
import { listGeminiModels, listOpenAiCompatibleModels } from "../agent/modelCatalog.js";
import {
  runPipeline,
  MANAJEMEN_ROLE_QUESTIONS,
  DESAIN_SOURCE_UPLOAD_IMAGE_TAP,
  type PhaseSpec,
  type PipelineMode,
} from "../agent/pipeline.js";
import { DEPARTMENT_KEYS, DEPARTMENT_LABELS, normalizeDepartment, type DepartmentKey } from "../agent/departments.js";
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
  isBareAddProjectCommand,
  parseAddFolder,
  isBareAddFolderCommand,
  parseDeleteProject,
  isBareDeleteProjectCommand,
  isRetryCommand,
  isValidAliasInput,
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
  isCreatorCommand,
  isConnectFigmaCommand,
  isGreetingCommand,
  isAllowedRepoUrl,
  extractGithubRepoUrl,
  isPlausibleShortCommand,
  isListMemoryCommand,
  isClearMemoryCommand,
  isSessionHistoryCommand,
} from "./parse.js";

const INTRO_TEXT = `Aku Mas ADE — AI Developer Engineer. Aku ini software house yang isinya AI: bisa jadi PM buat nangkep kebutuhan, BA buat analisis, engineer buat ngoding (backend/frontend), sampai QA buat ngetes — semua dari chat WhatsApp ini. Yang gak aku pegang cuma manajemen eksekutif; selain itu, dari ide sampai push ke repo, aku yang jalanin.

Mau mulai? Daftarin project dulu, atau ketik "bantuan" buat lihat semua perintahnya.`;

// Fixed, factual — deterministic reply, no AI call, same reasoning as
// localGreetingReply (nothing here needs a model's judgment, and a
// generated answer risks garbling real contact details).
const CREATOR_INFO_TEXT = `Aku dibuat sama Naufal Hilmi Abdurrahman.

WhatsApp: +62 896-7906-6300
Email: naufalhilmi1809@gmail.com
GitHub: https://github.com/gvjavx/
LinkedIn: https://www.linkedin.com/in/naufal-h-68576a197/`;

// Ade's "own brain" for pure small talk ("halo", "apa kabar", dsb) — decided
// locally, never hits an AI provider. A greeting doesn't need a creative
// answer, so an AI call would only add quota + latency on a path hit
// constantly. Only the time-of-day varies (WIB, same clock as currentDateLine
// in dynamicReplies.ts). It used to also quote the most recent remembered
// fact, but doing that on every single "halo" read as repetitive and kept
// resurfacing weakly-judged old facts — memory still feeds the normal chat
// path, just not this one.
function localGreetingReply(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Jakarta" }).format(new Date())
  );
  const timeOfDay =
    hour >= 4 && hour < 11 ? "pagi" : hour >= 11 && hour < 15 ? "siang" : hour >= 15 && hour < 18 ? "sore" : "malam";
  return `Halo, selamat ${timeOfDay}! Baik nih. Ada yang mau dikerjain, atau ketik "bantuan" dulu kalau mau lihat-lihat perintahnya.`;
}

// For non-technical "how does this work" questions — no command syntax, no
// jargon. Separate from HELP_TEXT (the command cheatsheet) on purpose: someone
// asking in plain language wants a plain-language answer, not a syntax dump.
const EXPLAIN_TEXT = `Kamu tinggal certain apa yang kamu mau, kayak ngobrol biasa aja — misalnya "bikinin aku toko online buat jualan baju" atau "tambahin fitur login di aplikasi yang kemarin".

Abis itu, buat request bikin aplikasi, biasanya aku jalanin langkah-langkah kayak gini (cuma yang relevan buat request kamu aja yang jalan, gak semuanya tiap kali):
1. Pertama, aku bertindak sebagai Product Owner — nangkep dulu kebutuhan kamu sebenernya dan nentuin cakupan yang paling masuk akal.
2. Abis itu aku bertindak sebagai Project Manager — ngatur urutan kerjaan, bagian mana yang perlu dikerjain duluan.
3. Lalu aku bertindak sebagai System Analyst — mikirin alur kerja dan kebutuhan sistemnya biar sesuai sama yang kamu mau.
4. Masuk ke bagian UI/UX — biarin aku yang desain otomatis, atau kirim gambar/screenshot referensi desain kamu.
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
- *hapus project <nama>* — unregister project dari daftar (gak ngehapus apa pun di server — clone/folder aslinya tetap ada)
- *pakai <nama>* — ganti project aktif buat chat ini
- *daftar model* — cek AI model yang aku pakai per departemen, masih bisa dipakai atau lagi bermasalah
- *daftar model <provider> <kata kunci>* — cari model spesifik di provider itu (mis. "daftar model gemini flash") — ditampilin semua beserta statusnya (bisa dipakai / kena limit / error)
- *pakai model <nama>* atau *pakai model <provider>/<model>* — model AI default (dipakai departemen yang belum punya model sendiri)
- *pakai model <departemen> <nama>* atau *pakai model <departemen> <provider>/<model>* — model AI khusus satu departemen (${DEPARTMENT_LIST_TEXT})
- *status* — cek task yang lagi jalan
- *stop* — batalin task yang lagi jalan di project aktif
- Ngobrol santai juga boleh, gak harus selalu perintah kerjaan — aku bakal inget hal-hal soal kamu dari obrolan kita buat kedepannya. Ketik *lihat memori* buat liat apa yang aku inget, atau *lupain semua* buat aku lupain lagi
- Kirim gambar (screenshot, mockup, dsb) bareng caption instruksinya (mis. "perbaiki tampilan sesuai screenshot ini") — aku bakal liat gambarnya dulu baru mulai kerjain. Kirim tanpa caption juga boleh, nanti aku ceritain apa yang aku liat terus tanya mau diapain.
- Atau langsung ketik aja apa yang mau dikerjain (mis. "tambahin endpoint health check"). Aku bakal tebak departemen mana yang perlu ngerjain, kasih tau rencananya, baru mulai setelah kamu konfirmasi — kalau rencananya lebih dari satu fase, kamu bisa pilih "review tiap fase" biar aku pause dulu abis tiap fase kelar, nunggu kamu approve atau minta revisi sebelum lanjut.`;

interface PendingAddFolder {
  type: "confirm_add_folder";
  alias: string;
  path: string;
}

interface PendingDeleteProject {
  type: "confirm_delete_project";
  alias: string;
}

// Turn-by-turn collection for the "bantuan" menu's argument-taking rows (tap
// -> asked one field at a time -> reuses the same registration logic the
// direct command already uses). WhatsApp can't pre-fill the input box from a
// button tap, so a tappable option can't hand over a ready-made "tambah
// project <alias> <url>" — this asks for each piece instead of guessing.
interface PendingGuidedGitProject {
  type: "guided_git_project";
  step: "alias" | "url";
  alias?: string;
}

interface PendingGuidedFolder {
  type: "guided_folder";
  step: "alias" | "path";
  alias?: string;
}

interface PendingPipeline {
  type: "confirm_pipeline";
  alias: string;
  instruction: string;
  phases: PhaseSpec[];
}

interface PendingClearMemory {
  type: "confirm_clear_memory";
}

// See classifyAndPresentPlan/checkNeedsClarification — set when a fresh task
// instruction had zero concrete product info to plan from, waiting on either
// a free-text answer or the CLARIFY_SKIP_TAP shortcut before classification
// actually runs.
interface PendingClarifyInstruction {
  type: "clarify_instruction";
  alias: string;
  instruction: string;
}

// Walks client_id -> client_secret -> redirect_uri one at a time, same shape
// as PendingGuidedGitProject/PendingGuidedFolder — see
// startFigmaSetupWizard/handleConnectFigmaCommand.
interface PendingFigmaSetup {
  type: "figma_setup";
  step: "client_id" | "client_secret" | "redirect_uri";
  clientId?: string;
  clientSecret?: string;
}

// Set when a captionless image was described but the user hasn't said what
// to do with it yet — without this, the description shown once was never
// referenced again, so a follow-up like "perbaiki sesuai gambar tadi" ran as
// plain text with zero knowledge of the image. See handleImageMessage.
interface PendingImageFollowup {
  type: "image_followup";
  description: string;
}

type PendingActionData =
  | PendingAddFolder
  | PendingDeleteProject
  | PendingGuidedGitProject
  | PendingGuidedFolder
  | PendingPipeline
  | PendingClearMemory
  | PendingClarifyInstruction
  | PendingFigmaSetup
  | PendingImageFollowup;

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

// Offered instead of YES_NO_OPTIONS at a manajemen-phase checkpoint. The
// three role-tap ids come straight from pipeline.ts's MANAJEMEN_ROLE_QUESTIONS
// (single source of truth — see the state machine in that file's checkpoint
// loop for how a tap turns into an actual role-specific answer) so the
// button labels and the detection logic can't silently drift apart.
// "Lanjutkan"/"Batal" reuse the same "ya"/"tidak" ids YES_NO_OPTIONS already
// uses, zero new logic there.
const MANAJEMEN_CHECKPOINT_OPTIONS: QuickReplyOption[] = [
  ...Object.keys(MANAJEMEN_ROLE_QUESTIONS).map((id) => ({ id, title: id })),
  { id: "ya", title: "Lanjutkan" },
  { id: "tidak", title: "Batal" },
];

// Offered at a desain-phase checkpoint specifically when no design source
// has been given yet (pipeline.ts's designSourceStillNeeded). "Upload
// gambar"'s id comes from pipeline.ts's DESAIN_SOURCE_UPLOAD_IMAGE_TAP
// (single source of truth with the state machine that intercepts it). No
// "Hubungkan Figma" option here — see handleConnectFigmaCommand for why
// that's disabled. "Serahkan ke AI" needs no special id — it's a complete
// answer on its own, so it just flows into the normal revise path as typed
// text would.
const DESAIN_SOURCE_CHECKPOINT_OPTIONS: QuickReplyOption[] = [
  { id: DESAIN_SOURCE_UPLOAD_IMAGE_TAP, title: DESAIN_SOURCE_UPLOAD_IMAGE_TAP },
  { id: "Serahkan ke AI, aku gak punya desain sendiri, auto-generate aja", title: "Serahkan ke AI" },
  { id: "ya", title: "Lanjutkan" },
  { id: "tidak", title: "Batal" },
];

// Sentinels for the "bantuan" menu rows that need arguments a single tap
// can't supply (WhatsApp sends the tapped id back as a normal message, it
// doesn't pre-fill the input box for further editing). Exact-string
// constants rather than natural-language questions on purpose — an earlier
// version used questions like "gimana cara tambah project baru?" and relied
// on the AI classifier to route them to help, which wasn't reliable enough
// for something a tap must always get right: a misclassification sent it
// down the free-text task path instead, attempting a "task" with no actual
// project name/URL to work with. These sentinels never collide with
// anything a human would type, so matching is exact and requires no AI call.
const HELP_WIZARD_GIT_PROJECT_ID = "__wizard_tambah_git_project__";
const HELP_WIZARD_FOLDER_ID = "__wizard_tambah_folder__";
const HELP_PICKER_DELETE_PROJECT_ID = "__picker_hapus_project__";
const HELP_TOPIC_START_TASK_ID = "__topik_mulai_kerja__";
// Tap shortcut offered alongside a clarify_instruction question — lets the
// user skip answering and just let the agent guess, same convenience as
// desain's "Serahkan ke AI" option.
const CLARIFY_SKIP_TAP = "Lanjut tanpa detail tambahan";

// figma_setup wizard's client_secret step — some Figma OAuth apps don't use
// one at all (figmaAuth.ts already treats it as optional). Includes the bare
// "tidak"/"gak"/"nggak" forms on purpose: at this specific data-entry step
// ("Client Secret-nya?"), a short "no" answer means "no secret", not "cancel
// the wizard" — checked before the generic isConfirmNo cancel check below,
// or "gak ada" would already fall through to isConfirmNo and cancel instead
// of being read as an answer.
const FIGMA_SECRET_SKIP_PHRASES = new Set([
  "tidak ada",
  "tidak",
  "gak ada",
  "gak",
  "ga ada",
  "ga",
  "nggak ada",
  "nggak",
  "none",
  "no",
  "n",
  "-",
  "skip",
  "kosong",
]);
// Real cancellation intent at the client_secret step specifically — narrower
// than isConfirmNo's CONFIRM_NO_PHRASES, which overlaps with the skip-phrase
// set above ("tidak"/"gak"/"nggak" mean different things depending on step).
const FIGMA_WIZARD_CANCEL_PHRASES = new Set(["batal", "cancel", "jangan"]);

// Attached to every "bantuan" reply. Parameter-less commands use the real
// exact phrase as the id (tap hits the real command directly). "Ganti
// project aktif"/"ganti model AI" aren't separate rows — "daftar
// project"/"daftar model" already show a tappable picker for exactly that.
const HELP_OPTIONS: QuickReplyOption[] = [
  { id: "daftar project", title: "Daftar project", description: "Lihat atau ganti project aktif" },
  {
    id: HELP_WIZARD_GIT_PROJECT_ID,
    title: "Tambah project (GitHub)",
    description: "Aku tanya alias & link repo-nya",
  },
  {
    id: HELP_WIZARD_FOLDER_ID,
    title: "Tambah folder lokal",
    description: "Aku tanya alias & path foldernya",
  },
  {
    id: HELP_PICKER_DELETE_PROJECT_ID,
    title: "Hapus project",
    description: "Pilih dari daftar yang udah ada",
  },
  { id: "daftar model", title: "Daftar model", description: "Lihat atau ganti model AI default" },
  { id: "status", title: "Status", description: "Cek task yang lagi jalan" },
  { id: "stop", title: "Stop", description: "Batalin task yang lagi jalan" },
  {
    id: HELP_TOPIC_START_TASK_ID,
    title: "Mulai ngerjain sesuatu",
    description: "Instruksi bebas, atau kirim gambar",
  },
];

// Cap on how long a message can be before it's not even worth spending an AI
// call to check whether it's a paraphrase of one of the fixed commands, or
// just chat, rather than a task — see isPlausibleShortCommand in parse.ts.
// Started at 12 and had to be raised: a real "explain" question like "jika
// saya meminta bantuan untuk bikin aplikasi dari awal apa yang akan kamu
// lakukan" is already 14 words, and missing that classification entirely
// sent it straight into the task pipeline instead of getting an actual
// explanation.
const INTENT_MAX_WORDS = 40;
// Confirmation replies are inherently short, so a tighter bound is safe here.
const CONFIRMATION_INTENT_MAX_WORDS = 8;
// How many past chat turns to load as context for a reply — a handful of
// exchanges, not the full history (see chatHistoryRepo.recent).
const CHAT_HISTORY_TURNS = 12;
// Caps how many stored facts get folded into the chat prompt, independent of
// how many actually exist in the DB — keeps prompt size bounded.
const MAX_FACTS_IN_PROMPT = 30;

// Provider spec for every chat/classification call — intro, greeting, help,
// chat replies, and all the classifiers (department/command/message-kind/
// confirmation-intent). None of these execute code, so they always resolve
// through the "manajemen" department lane, never whatever "dev" happens to
// be pinned to for a running task. Same precedence pipeline.ts's
// departmentModelLookup uses for real departments: per-department override,
// then the user's global override, then the system default (config.ts).
function resolveManajemenProvider(from: string, state: ReturnType<typeof conversationRepo.get>): string | undefined {
  return (
    conversationRepo.getDepartmentModel(from, "manajemen") ??
    state?.preferred_provider ??
    config.departmentDefaultProviders.manajemen
  );
}

// Decides whether this message continues the sender's current chat session
// or starts a fresh one (no session yet, or idle longer than
// config.sessionIdleMinutes), then logs it to session_log either way. Self-
// healing by design: even if session/idleNotifier.ts's background scanner
// missed a tick (process restart, etc.), the very next real message still
// detects the gap correctly here — it just won't have gotten the proactive
// "sesi berakhir" notice for the old one.
function touchAndLogSession(from: string, loggedContent: string): void {
  const state = conversationRepo.get(from);
  const idleMs = config.sessionIdleMinutes * 60_000;
  const isNewSession =
    !state?.current_session_id ||
    !state.last_message_at ||
    Date.now() - new Date(state.last_message_at).getTime() > idleMs;
  const sessionId = isNewSession ? crypto.randomUUID() : state!.current_session_id!;
  conversationRepo.touchSession(from, sessionId, isNewSession);
  sessionRepo.append(from, sessionId, "user", loggedContent);
}

export async function handleInboundMessage(
  from: string,
  text: string,
  image?: { mimeType: string; base64Data: string }
): Promise<void> {
  const trimmed = text.trim();

  touchAndLogSession(from, image ? trimmed || "[gambar]" : trimmed);

  const bashApprovalReply = await handlePendingBashApproval(from, trimmed, image);
  if (bashApprovalReply) return;

  const checkpointReply = await handlePendingCheckpoint(from, trimmed, image);
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

  if (isCreatorCommand(trimmed)) {
    await handleCreatorCommand(from);
    return;
  }

  if (isIntroCommand(trimmed)) {
    await handleIntroCommand(from, trimmed);
    return;
  }

  if (isGreetingCommand(trimmed)) {
    await handleGreetingCommand(from);
    return;
  }

  if (isHelpCommand(trimmed)) {
    await handleHelpCommand(from, trimmed);
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
    await registerGitProject(from, addCommand.alias, addCommand.repoUrl);
    return;
  }

  // "tambah project" with no alias/url — same reasoning as
  // isBareDeleteProjectCommand: start the guided wizard instead of letting it
  // fall through to the task classifier.
  if (isBareAddProjectCommand(trimmed)) {
    await startGuidedGitProjectWizard(from);
    return;
  }

  if (isBareAddFolderCommand(trimmed)) {
    await startGuidedFolderWizard(from);
    return;
  }

  // The three "bantuan" menu rows that need arguments a tap can't supply —
  // dispatched here deterministically (exact sentinel match, never touching
  // the AI classifier) so a tap always does what it says, never gets
  // misread as a free-text task attempt. See the pending-state handling in
  // handlePendingConfirmation for how each guided flow continues.
  if (trimmed === HELP_WIZARD_GIT_PROJECT_ID) {
    await startGuidedGitProjectWizard(from);
    return;
  }

  if (trimmed === HELP_WIZARD_FOLDER_ID) {
    await startGuidedFolderWizard(from);
    return;
  }

  if (trimmed === HELP_PICKER_DELETE_PROJECT_ID) {
    await showDeleteProjectPicker(from);
    return;
  }

  if (trimmed === HELP_TOPIC_START_TASK_ID) {
    await handleHelpCommand(from, "gimana cara mulai ngerjain sebuah task, misalnya bikin aplikasi baru?");
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

  const deleteAlias = parseDeleteProject(trimmed);
  if (deleteAlias) {
    const project = projectsRepo.get(deleteAlias);
    if (!project) {
      await sendWhatsApp(from, `Project "${deleteAlias}" gak ketemu. Ketik "daftar project" buat lihat daftarnya.`);
      return;
    }
    if (getActiveTaskId(deleteAlias)) {
      await sendWhatsApp(from, `Masih ada task yang lagi jalan di "${deleteAlias}". Ketik "stop" dulu sebelum hapus.`);
      return;
    }
    const pending: PendingDeleteProject = { type: "confirm_delete_project", alias: deleteAlias };
    conversationRepo.setPendingAction(from, JSON.stringify(pending));
    const diskNote =
      project.kind === "local"
        ? "cuma ke-unregister dari sini, foldernya di server gak ke-hapus"
        : "ke-unregister dari sini DAN clone lokalnya di server ikut kehapus (repo aslinya di GitHub jelas gak kesentuh, tinggal clone ulang kalau butuh lagi)";
    await sendWhatsApp(from, `Yakin mau hapus project "${deleteAlias}"? (${diskNote}) Boleh lanjut?`, YES_NO_OPTIONS);
    return;
  }

  if (isBareDeleteProjectCommand(trimmed)) {
    await showDeleteProjectPicker(from);
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

  if (isListMemoryCommand(trimmed)) {
    await handleListMemoryCommand(from);
    return;
  }

  if (isClearMemoryCommand(trimmed)) {
    await handleClearMemoryCommand(from);
    return;
  }

  if (isSessionHistoryCommand(trimmed)) {
    await handleSessionHistoryCommand(from);
    return;
  }

  if (isRetryCommand(trimmed)) {
    await handleRetryCommand(from);
    return;
  }

  // Nothing matched exactly — before assuming it's a coding task, check
  // whether it's actually a paraphrase of one of the fixed commands above,
  // or just conversation (a question, a comment, small talk).
  if (await tryHandleSemanticIntent(from, trimmed)) return;

  // Default: free-text instruction -> classify departments -> confirm -> pipeline.
  await handleFreeTextInstruction(from, trimmed);
}

// Shared by the "bantuan" menu's "Tambah project (GitHub)" row and "tambah
// project" typed with no alias/url.
async function startGuidedGitProjectWizard(from: string): Promise<void> {
  const pending: PendingGuidedGitProject = { type: "guided_git_project", step: "alias" };
  conversationRepo.setPendingAction(from, JSON.stringify(pending));
  await sendWhatsApp(from, 'Oke, project baru dari repo GitHub. Nama alias-nya apa? (satu kata, misalnya "toko-online")');
}

// Shared by the "bantuan" menu's "Tambah folder lokal" row and "tambah
// folder" typed with no alias/path.
async function startGuidedFolderWizard(from: string): Promise<void> {
  const pending: PendingGuidedFolder = { type: "guided_folder", step: "alias" };
  conversationRepo.setPendingAction(from, JSON.stringify(pending));
  await sendWhatsApp(from, 'Oke, project dari folder lokal di server. Nama alias-nya apa? (satu kata, misalnya "toko-lama")');
}

// Shared by the "bantuan" menu's delete-project row and "hapus project"
// typed with no alias — both need to ask which project, not guess or fall
// through to the task pipeline.
async function showDeleteProjectPicker(from: string): Promise<void> {
  const projects = projectsRepo.list();
  if (projects.length === 0) {
    await sendWhatsApp(from, "Belum ada project yang terdaftar buat dihapus.");
    return;
  }
  const options: QuickReplyOption[] = projects.map((p) => ({
    id: `hapus project ${p.alias}`,
    title: p.alias,
    description: p.kind === "local" ? "Folder lokal" : p.repo_url,
  }));
  await sendWhatsApp(from, "Project mana yang mau dihapus?", options, "Pilih project");
}

interface LastFailedRegisterGitProject {
  type: "register_git_project";
  alias: string;
  repoUrl: string;
}

// Fire-and-forget: build the code index right after a project is registered
// so the first task doesn't pay the whole cost. Says nothing unless it
// actually indexed files — a failure, or a no-op because RAG is off, stays quiet.
async function indexNewProjectInBackground(from: string, alias: string, mode: "git" | "local"): Promise<void> {
  try {
    const project = projectsRepo.get(alias);
    if (!project) return;
    const cwd = mode === "git" ? workspacePath(alias) : project.repo_url;
    const res = await indexProject({ projectAlias: alias, cwd, mode, signal: new AbortController().signal });
    if (!res.skipped && res.filesIndexed > 0) {
      await sendWhatsApp(
        from,
        `Kode "${alias}" udah aku indeks (${res.filesIndexed} file) biar lebih cepet nyari konteks pas ngerjain task.`
      );
    }
  } catch (err) {
    console.error(`[rag] gagal indeks project "${alias}":`, err);
  }
}

// Shared by the direct "tambah project <alias> <url>" command, the
// guided_git_project wizard's final step, and handleRetryCommand below — all
// three entry points can't silently drift apart, and a retry re-runs exactly
// this function with the same args rather than needing its own path.
async function registerGitProject(from: string, alias: string, repoUrl: string): Promise<void> {
  // The guided wizard already validates its alias step, but the direct
  // "tambah project <alias> <url>" command's regex only requires non-
  // whitespace — without this, an alias like "../../etc" would resolve
  // workspacePath(alias) outside workspacesDir entirely, which matters a lot
  // more now that project deletion removes that path from disk.
  if (!isValidAliasInput(alias)) {
    await sendWhatsApp(from, 'Alias-nya harus satu kata, tanpa spasi/garis miring. Coba lagi dengan alias lain.');
    return;
  }
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
    conversationRepo.setLastFailedAction(from, null);
    await sendWhatsApp(
      from,
      `Beres, "${alias}" udah terdaftar dan siap dipakai. Sekarang jadi project aktif buat chat ini.`
    );
    void indexNewProjectInBackground(from, alias, "git");
  } catch (err) {
    // Roll back the row create() just inserted — otherwise the next "tambah
    // project" attempt for this alias hits "udah ada" even though the clone
    // never actually succeeded, and the user has no way to retry.
    projectsRepo.delete(alias);
    // Remembered so a plain "coba lagi" right after can retry this exact
    // registration — without it, "coba lagi" has no fixed meaning at all and
    // used to get read by the task classifier as a request to build a "retry
    // feature" in the codebase instead of retrying what just failed.
    const failed: LastFailedRegisterGitProject = { type: "register_git_project", alias, repoUrl };
    conversationRepo.setLastFailedAction(from, JSON.stringify(failed));
    await sendWhatsApp(
      from,
      `Waduh, gagal daftarin/clone "${alias}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleRetryCommand(from: string): Promise<void> {
  const raw = conversationRepo.get(from)?.last_failed_action;
  if (!raw) {
    await sendWhatsApp(from, "Coba lagi apa ya? Nggak ada yang gagal barusan yang bisa aku ulang.");
    return;
  }
  let failed: LastFailedRegisterGitProject;
  try {
    failed = JSON.parse(raw);
  } catch {
    conversationRepo.setLastFailedAction(from, null);
    await sendWhatsApp(from, "Coba lagi apa ya? Nggak ada yang gagal barusan yang bisa aku ulang.");
    return;
  }
  if (failed.type === "register_git_project") {
    await registerGitProject(from, failed.alias, failed.repoUrl);
    return;
  }
  await sendWhatsApp(from, "Coba lagi apa ya? Nggak ada yang gagal barusan yang bisa aku ulang.");
}

async function handleCreatorCommand(from: string): Promise<void> {
  await sendWhatsApp(from, CREATOR_INFO_TEXT);
}

// Each of these three follows the same shape: try an AI-generated reply
// tailored to what was actually asked, fall back to the static text if
// there's no provider configured or the call fails — never leaves the user
// without an answer just because a provider hiccuped.
async function handleIntroCommand(from: string, question: string): Promise<void> {
  const state = conversationRepo.get(from);
  const providers = buildProviders(resolveManajemenProvider(from, state));
  const answer =
    providers.length > 0 ? await introduceYourself(question, providers[0], new AbortController().signal) : undefined;
  await sendWhatsApp(from, answer ?? INTRO_TEXT);
}

async function handleGreetingCommand(from: string): Promise<void> {
  await sendWhatsApp(from, localGreetingReply());
}

async function handleHelpCommand(from: string, question: string): Promise<void> {
  const state = conversationRepo.get(from);
  const providers = buildProviders(resolveManajemenProvider(from, state));
  const answer =
    providers.length > 0
      ? await explainHelp(question, HELP_TEXT, providers[0], new AbortController().signal)
      : undefined;
  await sendWhatsApp(from, answer ?? HELP_TEXT, HELP_OPTIONS, "Pilih topik");
}

async function handleExplainCommand(from: string, question: string): Promise<void> {
  const state = conversationRepo.get(from);
  const providers = buildProviders(resolveManajemenProvider(from, state));
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
    return;
  }
  const lines = projects.map((p) => `• ${p.alias}${p.kind === "local" ? " (folder lokal)" : ""} — ${p.repo_url}`);
  // Tappable, same id shape as the project picker in handleFreeTextInstruction
  // ("pakai <alias>") — tap switches the active project directly instead of
  // making the user type it out after reading the list.
  const options: QuickReplyOption[] = projects.map((p) => ({
    id: `pakai ${p.alias}`,
    title: p.alias,
    description: p.kind === "local" ? "Folder lokal" : p.repo_url,
  }));
  await sendWhatsApp(from, `Ini project yang udah terdaftar:\n${lines.join("\n")}`, options, "Pilih project");
}

async function handleListModelsCommand(from: string): Promise<void> {
  const state = conversationRepo.get(from);
  const providers = buildProviders();
  await sendWhatsApp(from, "Bentar, aku cek satu-satu dulu ya...");

  const results = await Promise.all(
    providers.map(async (provider) => ({
      name: provider.name,
      model: provider.model,
      status: await checkProviderStatus(provider),
    }))
  );

  // Gemini now fans each key out across GEMINI_FALLBACK_MODELS too (see
  // runner.ts), so "gemini" entries no longer all share one model — show the
  // model whenever a provider has more than one showing up, and only append
  // "(key i/n)" when that same model itself has more than one key behind it.
  const modelsPerName = new Map<string, Set<string>>();
  for (const r of results) {
    if (!r.model) continue;
    const set = modelsPerName.get(r.name) ?? new Set<string>();
    set.add(r.model);
    modelsPerName.set(r.name, set);
  }
  const seenPerNameModel = new Map<string, number>();
  const totalPerNameModel = new Map<string, number>();
  for (const r of results) {
    const key = `${r.name}:${r.model ?? ""}`;
    totalPerNameModel.set(key, (totalPerNameModel.get(key) ?? 0) + 1);
  }

  // The fallback-model entries share a name with the provider's actual
  // default, so "(default)" needs to land on exactly the one entry that
  // matches the current spec — its pinned model if one was given, otherwise
  // that provider's own configured default model — not on every entry that
  // happens to be the same provider.
  const preferredSpec = state?.preferred_provider ? splitProviderSpec(state.preferred_provider) : undefined;

  const providerLines = results.map(({ name, model, status }) => {
    const distinctModels = modelsPerName.get(name)?.size ?? 0;
    const key = `${name}:${model ?? ""}`;
    const totalForModel = totalPerNameModel.get(key) ?? 1;
    const index = (seenPerNameModel.get(key) ?? 0) + 1;
    seenPerNameModel.set(key, index);
    const modelTag = model && distinctModels > 1 ? ` (${model})` : "";
    const keyTag = totalForModel > 1 ? ` (key ${index}/${totalForModel})` : "";
    const isDefault =
      preferredSpec?.name === name && model === (preferredSpec.model ?? primaryModelForProvider(name));
    const tag = isDefault ? " (default)" : "";
    return `• ${name}${modelTag}${keyTag}${tag} — ${describeProviderStatus(status)}`;
  });

  const deptModels = conversationRepo.getDepartmentModels(from);
  const deptLines = DEPARTMENT_KEYS.map(
    (key) =>
      `• ${DEPARTMENT_LABELS[key]}: ${deptModels[key] ?? state?.preferred_provider ?? config.departmentDefaultProviders[key] ?? "(pakai default)"}`
  );
  const defaultLine = `Default (semua): ${state?.preferred_provider ?? "otomatis, provider pertama yang aktif"}`;

  // Tappable shortcut to switch the default provider — deduped by name since
  // multiple keys for the same provider would otherwise offer the same tap
  // more than once.
  const usableProviderNames = [...new Set(results.filter((r) => r.status.state === "ok").map((r) => r.name))];
  const options: QuickReplyOption[] = usableProviderNames.map((name) => ({
    id: `pakai model semua ${name}`,
    title: name,
    description: name === state?.preferred_provider ? "Provider default sekarang" : "Jadiin provider default",
  }));

  await sendWhatsApp(
    from,
    `Provider yang aktif:\n${providerLines.join("\n")}\n\nModel per departemen:\n${deptLines.join("\n")}\n${defaultLine}`,
    options,
    "Pilih provider"
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
        (phaseNote ? `\n\nTerakhir: ${phaseNote}` : ""),
      [{ id: "stop", title: "Stop" }]
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

// Shared tail for both the already-configured case and the last step of the
// figma_setup wizard below — generates a fresh authorize link either way.
async function sendFigmaAuthorizeLink(from: string): Promise<void> {
  const { state, codeVerifier } = createPendingState(from);
  const authorizeUrl = buildAuthorizeUrl(state, codeVerifier);
  await sendWhatsApp(
    from,
    `Buka link ini buat sambungin akun Figma kamu, izinin aksesnya, nanti aku kabarin kalau udah connect:\n${authorizeUrl}`
  );
}

// Disabled, not removed — Figma restricts the mcp:connect OAuth scope to an
// allowlist of clients they've pre-approved themselves (confirmed by Figma
// support on their own forum: "the mcp:connect scope isn't available for
// general third-party OAuth apps"). A self-registered app — which is
// exactly what the figma_setup wizard (see handlePendingConfirmation,
// unchanged and still fully working) walks someone through creating —
// always gets rejected with "Invalid scope: mcp:connect", no matter how
// correctly the request is built (verified: PKCE and the RFC 8707 resource
// parameter were both genuinely missing bugs, fixed in agent/mcp/figmaAuth.ts,
// but neither was the actual blocker). There's no self-service path to get
// approved. If Figma opens this up later, or this app specifically gets
// allowlisted, restore the wizard-starting branch this replaced — see git
// history for this function — everything it depends on is still here.
async function handleConnectFigmaCommand(from: string): Promise<void> {
  await sendWhatsApp(
    from,
    "Integrasi Figma lagi gak bisa dipakai dulu nih. Figma sendiri yang batesin akses OAuth-nya cuma buat aplikasi yang udah mereka approve duluan, dan belum ada jalur buat daftar sendiri — jadi ini di luar kendali aku, bukan soal setup yang salah."
  );
}

async function handleListMemoryCommand(from: string): Promise<void> {
  const facts = memoryRepo.list(from);
  const kbCount = config.chatKb.enabled ? chatKbRepo.countForNumber(from) : 0;
  if (facts.length === 0 && kbCount === 0) {
    await sendWhatsApp(from, "Belum ada yang aku inget soal kamu nih.");
    return;
  }
  const factList =
    facts.length > 0 ? `Ini yang aku inget soal kamu:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}` : "Belum ada fakta khusus yang aku catat soal kamu.";
  const kbLine = kbCount > 0 ? `\n\nAku juga nyimpen ${kbCount} tanya-jawab dari obrolan kita buat belajar. "lupain semua" hapus ini juga.` : "";
  const stats = config.chatKb.enabled ? kbStatsRepo.summary(30) : undefined;
  const statsLine =
    stats && stats.total > 0
      ? `\n\n30 hari terakhir: ${stats.total} pertanyaan chat, ${stats.kb + stats.arithmetic} dijawab tanpa AI (${stats.withoutAiPct}%) — ${stats.kb} dari memori, ${stats.arithmetic} hitungan.`
      : "";
  await sendWhatsApp(from, factList + kbLine + statsLine);
}

async function handleClearMemoryCommand(from: string): Promise<void> {
  const kbCount = config.chatKb.enabled ? chatKbRepo.countForNumber(from) : 0;
  if (memoryRepo.list(from).length === 0 && kbCount === 0) {
    await sendWhatsApp(from, "Belum ada yang aku inget soal kamu, jadi gak ada yang perlu dilupain.");
    return;
  }
  const pending: PendingClearMemory = { type: "confirm_clear_memory" };
  conversationRepo.setPendingAction(from, JSON.stringify(pending));
  await sendWhatsApp(from, "Yakin mau aku lupain semua yang aku inget soal kamu? Ini gak bisa dibalikin lagi.", YES_NO_OPTIONS);
}

async function handleSessionHistoryCommand(from: string): Promise<void> {
  const state = conversationRepo.get(from);
  const session = sessionRepo.getMostRecentCompletedSession(from, state?.current_session_id);
  if (!session || session.messages.length === 0) {
    await sendWhatsApp(from, "Belum ada sesi obrolan sebelumnya yang kesimpen nih.");
    return;
  }
  const transcript = session.messages.map((m) => `${m.role === "user" ? "Kamu" : "Aku"}: ${m.content}`).join("\n");
  await sendWhatsApp(from, `Ini yang kita bahas di sesi sebelumnya:\n\n${transcript}`);
}

async function handleImageMessage(
  from: string,
  caption: string,
  image: { mimeType: string; base64Data: string }
): Promise<void> {
  const state = conversationRepo.get(from);
  const providers = buildProviders(resolveManajemenProvider(from, state));
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
    await handleFreeTextInstruction(from, mergeImageDescription(caption, description));
    return;
  }

  const pending: PendingImageFollowup = { type: "image_followup", description };
  conversationRepo.setPendingAction(from, JSON.stringify(pending));
  await sendWhatsApp(
    from,
    `Ini yang aku tangkep dari gambarnya:\n\n${description}\n\nMau aku apain nih? Kasih instruksinya ya, abis itu aku lanjutin.`
  );
}

// Fallback for when none of the commands above matched exactly — one AI call
// decides whether this message means one of the fixed commands (a
// paraphrase), is just conversation (a question, a comment, small talk), or
// is actually a coding task, before handleFreeTextInstruction takes over for
// that last case. Used to be two sequential classifier calls (command intent,
// then message kind) — merged into one round-trip since they're really one
// decision. Gated by isPlausibleShortCommand so this never runs (and never
// costs an AI call) for messages that are clearly full task instructions
// already.
async function tryHandleSemanticIntent(from: string, trimmed: string): Promise<boolean> {
  if (!isPlausibleShortCommand(trimmed, INTENT_MAX_WORDS)) return false;

  const state = conversationRepo.get(from);
  const providers = buildProviders(resolveManajemenProvider(from, state));
  if (providers.length === 0) return false; // let handleFreeTextInstruction give its own "no provider" message

  const intent = await classifyIntent(trimmed, providers[0], new AbortController().signal);
  switch (intent) {
    case "intro":
      await handleIntroCommand(from, trimmed);
      return true;
    case "creator":
      await handleCreatorCommand(from);
      return true;
    case "greeting":
      await handleGreetingCommand(from);
      return true;
    case "help":
      await handleHelpCommand(from, trimmed);
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
    case "session_history":
      await handleSessionHistoryCommand(from);
      return true;
    case "chat":
      await handleChatMessage(from, trimmed, providers[0]);
      return true;
    default:
      return false; // "task"
  }
}

async function handleChatMessage(from: string, message: string, provider: Provider): Promise<void> {
  // Only feed prior turns when the message is a follow-up — otherwise a
  // free-tier model tends to echo the last answer into an unrelated reply.
  const history = needsConversationContext(message) ? chatHistoryRepo.recent(from, CHAT_HISTORY_TURNS) : [];
  const facts = memoryRepo.list(from).slice(-MAX_FACTS_IN_PROMPT);
  const result = await generateChatReply(message, history, facts, provider, new AbortController().signal, {
    fromNumber: from,
  });
  const reply = result?.reply ?? "Provider yang aktif lagi susah diajak mikir buat ini, coba lagi bentar ya.";
  await sendWhatsApp(from, reply);
  if (result) {
    chatHistoryRepo.append(from, "user", message);
    chatHistoryRepo.append(from, "assistant", reply);
    if (result.newFact) memoryRepo.add(from, result.newFact);
    if (config.chatKb.enabled) kbStatsRepo.bump(result.source ?? "model");
    // A "kb" reply is already in the store — re-recording would just pile up
    // duplicates. Only the model/arithmetic paths produce something new.
    if (result.source !== "kb") {
      void recordInteraction({
        fromNumber: from,
        kind: result.source === "arithmetic" ? "chat_arithmetic" : "chat_model",
        question: message,
        answer: reply,
        precomputedVector: result.questionVector,
      });
    }
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
  providerSpec: string | undefined,
  trimmed: string
): Promise<ConfirmationIntent> {
  if (isConfirmYes(trimmed)) return "yes";
  if (isConfirmNo(trimmed)) return "no";
  if (!isPlausibleShortCommand(trimmed, CONFIRMATION_INTENT_MAX_WORDS)) return "unclear";
  const providers = buildProviders(providerSpec);
  if (providers.length === 0) return "unclear";
  return classifyConfirmationIntent(trimmed, providers[0], new AbortController().signal);
}

// Catches the case a real user actually hit: mid-wizard/mid-confirmation,
// they send something that's obviously a different, unrelated real command
// ("halo" while the "tambah project" wizard is waiting on a GitHub URL) —
// not their answer to what was asked, just them moving on. Without this,
// that message gets swallowed by whatever's pending and comes back as a
// non-sequitur (e.g. a "no valid GitHub link found" retry prompt in reply to
// a plain greeting). Checked ahead of every pending-flow branch below except
// handlePendingCheckpoint, which deliberately treats *any* non-yes/no text as
// the revision instruction itself — that's the documented, intentional
// behavior there, not a case this should override. (handlePendingCheckpoint
// does carve out its own single, narrow exception inline — an exact
// "hubungkan figma" — since the agent loop has no tool to act on that itself;
// unlike this function it doesn't cancel/end the pending state, it just sends
// the OAuth link as a side reply and leaves the checkpoint waiting.)
function looksLikeAnotherCommand(trimmed: string): boolean {
  return (
    isIntroCommand(trimmed) ||
    isCreatorCommand(trimmed) ||
    isGreetingCommand(trimmed) ||
    isHelpCommand(trimmed) ||
    isListProjectsCommand(trimmed) ||
    isListModelsCommand(trimmed) ||
    isStatusCommand(trimmed) ||
    isStopCommand(trimmed) ||
    isConnectFigmaCommand(trimmed) ||
    isListMemoryCommand(trimmed) ||
    isClearMemoryCommand(trimmed) ||
    isSessionHistoryCommand(trimmed) ||
    parseAddProject(trimmed) !== undefined ||
    isBareAddProjectCommand(trimmed) ||
    parseAddFolder(trimmed) !== undefined ||
    isBareAddFolderCommand(trimmed) ||
    parseDeleteProject(trimmed) !== undefined ||
    isBareDeleteProjectCommand(trimmed) ||
    parseUseProject(trimmed) !== undefined ||
    parseUseModel(trimmed) !== undefined ||
    parseListModelsForProvider(trimmed) !== undefined
  );
}

// Checked before everything else: same in-memory-pending-per-taskId pattern
// as handlePendingCheckpoint below, but for a single risky bash command
// rather than a whole pipeline phase. Fails closed on anything but an
// explicit "ya" — an ambiguous reply shouldn't accidentally green-light a
// command flagged as dangerous in the first place.
async function handlePendingBashApproval(
  from: string,
  trimmed: string,
  image?: { mimeType: string; base64Data: string }
): Promise<boolean> {
  const state = conversationRepo.get(from);
  const taskId = state?.active_project_alias ? getActiveTaskId(state.active_project_alias) : undefined;
  if (!taskId || !hasPendingBashApproval(taskId)) return false;

  // An image can't answer a ya/tidak gate — resolving it either way here
  // would be a guess. Leave the approval pending instead of silently
  // auto-denying it (empty caption used to read as "unclear" -> denied).
  if (image) {
    await sendWhatsApp(from, "Ini butuh jawaban ya/tidak buat command yang aku tanyain, bukan gambar. Ketik ya atau tidak dulu ya.");
    return true;
  }

  if (looksLikeAnotherCommand(trimmed)) {
    resolveBashApproval(taskId, false);
    await sendWhatsApp(from, "Oke, aku skip command itu, cari cara lain dulu.");
    return false;
  }

  const intent = await interpretConfirmationReply(resolveManajemenProvider(from, state), trimmed);
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
async function handlePendingCheckpoint(
  from: string,
  trimmed: string,
  image?: { mimeType: string; base64Data: string }
): Promise<boolean> {
  const state = conversationRepo.get(from);
  const taskId = state?.active_project_alias ? getActiveTaskId(state.active_project_alias) : undefined;
  if (!taskId || !hasPendingCheckpoint(taskId)) return false;

  // One deliberate, narrow exception to "anything non-yes/no is the
  // revision/question itself" (see looksLikeAnotherCommand's comment): left
  // to the usual path, "hubungkan figma" typed mid-checkpoint would just
  // become inert revision text instead of the recognized command it is.
  // Handled here directly instead, leaving the checkpoint pending either
  // way. handleConnectFigmaCommand currently always declines (see its own
  // comment) — this carve-out stays regardless, since the command is still
  // real and still shouldn't be misread as a revision instruction.
  if (!image && isConnectFigmaCommand(trimmed)) {
    await handleConnectFigmaCommand(from);
    return true;
  }

  // Same reasoning as the hubungkan figma carve-out above: these 3 tap ids
  // (MANAJEMEN_CHECKPOINT_OPTIONS) are fully deterministic, so skip
  // interpretConfirmationReply's AI call entirely instead of paying for a
  // classification whose answer is already known — goes straight into the
  // existing revise/question loop with the exact tap text as the instruction.
  if (!image && MANAJEMEN_ROLE_QUESTIONS[trimmed] !== undefined) {
    resolveCheckpoint(taskId, { action: "revise", instruction: trimmed });
    return true;
  }

  if (image) {
    const providers = buildProviders(resolveManajemenProvider(from, state));
    if (providers.length === 0) {
      await sendWhatsApp(from, "Belum ada AI provider yang aktif, jadi aku belum bisa liat gambarnya.");
      return true;
    }
    await sendWhatsApp(from, "Oke, aku liatin dulu ya gambarnya, bentar...");
    const description = await describeImage(
      image.base64Data,
      image.mimeType,
      trimmed || undefined,
      providers,
      new AbortController().signal
    );
    if (description === undefined) {
      await sendWhatsApp(
        from,
        'Waduh, kayaknya model AI yang aktif buat chat ini gak bisa "lihat" gambar. Coba ganti model dulu (ketik "daftar model" buat lihat pilihannya, terus "pakai model <nama>"), habis itu kirim ulang gambarnya ya.'
      );
      return true;
    }
    // No captionless-image "mau diapain nih?" round-trip here, unlike
    // handleImageMessage at the top level — the context is already known
    // (mid-phase, waiting for exactly this), so the image on its own is a
    // complete, self-explanatory revision.
    resolveCheckpoint(taskId, { action: "revise", instruction: mergeImageDescription(trimmed || undefined, description) });
    return true;
  }

  const intent = await interpretConfirmationReply(resolveManajemenProvider(from, state), trimmed);
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

  if (looksLikeAnotherCommand(trimmed)) {
    conversationRepo.setPendingAction(from, null);
    await sendWhatsApp(from, "Oke, yang tadi aku batalin dulu ya.");
    return false;
  }

  if (pending.type === "guided_git_project") {
    // Plain exact-phrase check, not interpretConfirmationReply — this loop
    // must stay fully deterministic (see the sentinel comment above
    // HELP_OPTIONS), so a reply that doesn't exactly say "batal"/"tidak"/etc.
    // is just treated as the alias/URL itself instead of risking an AI call
    // here too.
    if (isConfirmNo(trimmed)) {
      conversationRepo.setPendingAction(from, null);
      await sendWhatsApp(from, "Oke, gak jadi ya.");
      return true;
    }
    if (pending.step === "alias") {
      if (!isValidAliasInput(trimmed)) {
        await sendWhatsApp(
          from,
          'Alias-nya harus satu kata, tanpa spasi/garis miring. Coba lagi, atau ketik "batal".'
        );
        return true;
      }
      const next: PendingGuidedGitProject = { type: "guided_git_project", step: "url", alias: trimmed };
      conversationRepo.setPendingAction(from, JSON.stringify(next));
      await sendWhatsApp(
        from,
        `Sip, "${trimmed}". Sekarang kasih link repo GitHub-nya (format https://github.com/owner/repo).`
      );
      return true;
    }
    // step === "url" — extracted rather than matched exact-format on purpose:
    // a pasted browser link often carries a trailing /tree/<branch>, a query
    // string, a ".git" suffix, or surrounding words ("ini reponya <link> ya")
    // that the direct "tambah project <alias> <url>" command's strict regex
    // would reject outright. Stays in this step (doesn't clear pending) on a
    // miss, same retry-in-place behavior as the alias step above.
    const repoUrl = extractGithubRepoUrl(trimmed);
    if (!repoUrl) {
      await sendWhatsApp(
        from,
        'Gak nemu link GitHub yang valid di situ. Kirim link repo-nya (mis. https://github.com/owner/repo), atau ketik "batal".'
      );
      return true;
    }
    conversationRepo.setPendingAction(from, null);
    await registerGitProject(from, pending.alias ?? "", repoUrl);
    return true;
  }

  if (pending.type === "guided_folder") {
    if (isConfirmNo(trimmed)) {
      conversationRepo.setPendingAction(from, null);
      await sendWhatsApp(from, "Oke, gak jadi ya.");
      return true;
    }
    if (pending.step === "alias") {
      if (!isValidAliasInput(trimmed)) {
        await sendWhatsApp(
          from,
          'Alias-nya harus satu kata, tanpa spasi/garis miring. Coba lagi, atau ketik "batal".'
        );
        return true;
      }
      if (projectsRepo.get(trimmed)) {
        await sendWhatsApp(from, `Project "${trimmed}" udah ada. Coba nama lain, atau ketik "batal".`);
        return true;
      }
      const next: PendingGuidedFolder = { type: "guided_folder", step: "path", alias: trimmed };
      conversationRepo.setPendingAction(from, JSON.stringify(next));
      await sendWhatsApp(from, `Sip, "${trimmed}". Sekarang kasih path absolut foldernya di server (mis. /home/user/proyek-lama).`);
      return true;
    }
    const alias = pending.alias ?? "";
    const resolvedPath = path.resolve(trimmed);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      await sendWhatsApp(from, `Folder "${resolvedPath}" gak ketemu di server. Cek lagi path-nya, atau ketik "batal".`);
      return true;
    }
    const confirmPending: PendingAddFolder = { type: "confirm_add_folder", alias, path: resolvedPath };
    conversationRepo.setPendingAction(from, JSON.stringify(confirmPending));
    await sendWhatsApp(
      from,
      `Ini folder lokal di server, bukan repo git — kalau aku daftarin, aku bisa baca, ubah, dan bikin file/folder apapun di dalam "${resolvedPath}" (semua isinya, bukan cuma yang kamu sebut). Boleh lanjut?`,
      YES_NO_OPTIONS
    );
    return true;
  }

  if (pending.type === "figma_setup") {
    // Checked before the generic isConfirmNo cancel below — "tidak"/"gak" at
    // this specific step means "no secret", not "cancel the wizard". Only an
    // unambiguous cancel word actually cancels here.
    if (pending.step === "client_secret") {
      const lower = trimmed.toLowerCase();
      if (FIGMA_WIZARD_CANCEL_PHRASES.has(lower)) {
        conversationRepo.setPendingAction(from, null);
        await sendWhatsApp(from, "Oke, gak jadi ya.");
        return true;
      }
      const clientSecret = FIGMA_SECRET_SKIP_PHRASES.has(lower) ? undefined : trimmed;
      const next: PendingFigmaSetup = {
        type: "figma_setup",
        step: "redirect_uri",
        clientId: pending.clientId,
        clientSecret,
      };
      conversationRepo.setPendingAction(from, JSON.stringify(next));
      await sendWhatsApp(
        from,
        "Terakhir, redirect URI yang kamu daftarin di app Figma-nya (harus persis sama) — biasanya https://<domain-server-kamu>/figma/oauth/callback."
      );
      return true;
    }

    if (isConfirmNo(trimmed)) {
      conversationRepo.setPendingAction(from, null);
      await sendWhatsApp(from, "Oke, gak jadi ya.");
      return true;
    }
    if (pending.step === "client_id") {
      const next: PendingFigmaSetup = { type: "figma_setup", step: "client_secret", clientId: trimmed };
      conversationRepo.setPendingAction(from, JSON.stringify(next));
      await sendWhatsApp(
        from,
        'Sip. Sekarang Client Secret-nya — kalau app Figma kamu gak pakai secret, ketik "tidak ada".'
      );
      return true;
    }
    // step === "redirect_uri"
    try {
      new URL(trimmed);
    } catch {
      await sendWhatsApp(from, 'URL-nya gak valid. Kirim lagi redirect URI-nya, atau ketik "batal".');
      return true;
    }
    conversationRepo.setPendingAction(from, null);
    figmaAppConfigRepo.save({ clientId: pending.clientId ?? "", clientSecret: pending.clientSecret, redirectUri: trimmed });
    await sendWhatsApp(from, "Oke, Figma OAuth udah aku simpen.");
    await sendFigmaAuthorizeLink(from);
    return true;
  }

  if (pending.type === "image_followup") {
    conversationRepo.setPendingAction(from, null);
    await handleFreeTextInstruction(from, mergeImageDescription(trimmed || undefined, pending.description));
    return true;
  }

  if (pending.type === "clarify_instruction") {
    conversationRepo.setPendingAction(from, null);
    const project = projectsRepo.get(pending.alias);
    if (!project) {
      await sendWhatsApp(from, `Waduh, project "${pending.alias}" udah gak ada. Coba ulangi instruksinya.`);
      return true;
    }
    const merged =
      trimmed === CLARIFY_SKIP_TAP ? pending.instruction : `${pending.instruction}\n\nDetail tambahan dari user: ${trimmed}`;
    // allowClarify=false — this is the second pass, caps the clarify loop at
    // exactly one round no matter how thin the merged instruction still is.
    await classifyAndPresentPlan(from, project, merged, false);
    return true;
  }

  if (pending.type === "confirm_add_folder") {
    const intent = await interpretConfirmationReply(resolveManajemenProvider(from, state), trimmed);
    if (intent === "yes") {
      conversationRepo.setPendingAction(from, null);
      projectsRepo.createLocal(pending.alias, pending.path);
      conversationRepo.setActiveProject(from, pending.alias);
      await sendWhatsApp(
        from,
        `Oke, "${pending.alias}" aku daftarin ke folder itu. Sekarang jadi project aktif buat chat ini.`
      );
      void indexNewProjectInBackground(from, pending.alias, "local");
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

  if (pending.type === "confirm_delete_project") {
    const intent = await interpretConfirmationReply(resolveManajemenProvider(from, state), trimmed);
    if (intent === "yes") {
      conversationRepo.setPendingAction(from, null);
      const project = projectsRepo.get(pending.alias);
      projectsRepo.delete(pending.alias);
      conversationRepo.clearActiveProjectEverywhere(pending.alias);
      deleteProjectIndex(pending.alias);
      // Only for kind='git' — the clone is disposable (re-clonable from
      // GitHub). Never for kind='local': repo_url there IS the user's real
      // folder, removeWorkspace is never called on that path.
      if (project?.kind === "git") {
        try {
          removeWorkspace(pending.alias);
          await sendWhatsApp(from, `Oke, "${pending.alias}" udah ke-unregister dan folder clone-nya di server udah kehapus.`);
        } catch (err) {
          await sendWhatsApp(
            from,
            `"${pending.alias}" udah ke-unregister, tapi gagal hapus folder clone-nya di server: ${err instanceof Error ? err.message : String(err)}. Mungkin perlu dihapus manual.`
          );
        }
      } else {
        await sendWhatsApp(from, `Oke, "${pending.alias}" udah ke-unregister.`);
      }
      return true;
    }
    conversationRepo.setPendingAction(from, null);
    if (intent === "no") {
      await sendWhatsApp(from, "Oke, gak jadi ya.");
    } else {
      await sendWhatsApp(from, 'Gak jelas jawabannya, jadi aku batalin dulu. Ulangi "hapus project" lagi kalau masih mau.');
    }
    return true;
  }

  if (pending.type === "confirm_clear_memory") {
    const intent = await interpretConfirmationReply(resolveManajemenProvider(from, state), trimmed);
    conversationRepo.setPendingAction(from, null);
    if (intent === "yes") {
      memoryRepo.clear(from);
      chatKbRepo.clearForNumber(from);
      await sendWhatsApp(from, "Oke, udah aku lupain semua ya.");
    } else if (intent === "no") {
      await sendWhatsApp(from, "Oke, gak jadi ya.");
    } else {
      await sendWhatsApp(from, 'Gak jelas jawabannya, jadi aku batalin dulu. Ulangi "lupain semua" lagi kalau masih mau.');
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
    const intent = await interpretConfirmationReply(resolveManajemenProvider(from, state), trimmed);
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
  const notChecked = candidates.slice(MODEL_CHECK_LIMIT);
  const results = await Promise.all(
    toCheck.map(async (model) => ({
      model,
      status: await checkProviderStatus(buildProviders(`${providerName}/${model}`)[0]),
    }))
  );

  const modelLines = [
    ...results.map((r) => `• ${r.model} — ${describeProviderStatus(r.status)}`),
    ...notChecked.map((m) => `• ${m} — belum dicek`),
  ];
  const capNote =
    notChecked.length > 0
      ? `\n\n(Ada ${candidates.length} model yang namanya cocok, aku baru cek ${MODEL_CHECK_LIMIT} pertama biar gak kelamaan.)`
      : "";

  const usable = results.filter((r) => r.status.state === "ok").map((r) => r.model);
  const options: QuickReplyOption[] = usable.map((m) => ({
    id: `pakai model semua ${providerName}/${m}`,
    title: m,
    description: `${providerName}/${m}`,
  }));
  const tapNote =
    usable.length > 0
      ? `Yang "bisa dipakai" bisa langsung di-tap buat jadiin default, atau ketik "pakai model <departemen> ${providerName}/<nama-model>" buat satu departemen tertentu.`
      : `Lagi gak ada yang bisa dipakai dari yang udah dicek.`;
  await sendWhatsApp(from, `Model di ${providerName}:\n${modelLines.join("\n")}\n\n${tapNote}${capNote}`, options, "Pilih model");
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
  await classifyAndPresentPlan(from, project, instruction, true);
}

// Split out of handleFreeTextInstruction so a resumed clarify_instruction
// answer (handlePendingConfirmation) can re-enter here directly with
// allowClarify=false, instead of re-running alias/project resolution and
// risking a second clarify round.
async function classifyAndPresentPlan(
  from: string,
  project: Project,
  instruction: string,
  allowClarify: boolean
): Promise<void> {
  const state = conversationRepo.get(from);
  const classifierProviders = buildProviders(resolveManajemenProvider(from, state));
  if (classifierProviders.length === 0) {
    await sendWhatsApp(from, "Belum ada AI provider yang aktif, jadi aku belum bisa kerja.");
    return;
  }

  if (allowClarify) {
    const question = await checkNeedsClarification(instruction, classifierProviders[0], new AbortController().signal);
    if (question) {
      const pending: PendingClarifyInstruction = { type: "clarify_instruction", alias: project.alias, instruction };
      conversationRepo.setPendingAction(from, JSON.stringify(pending));
      await sendWhatsApp(from, question, [{ id: CLARIFY_SKIP_TAP, title: CLARIFY_SKIP_TAP }]);
      return;
    }
  }

  await sendWhatsApp(from, "Bentar, aku pikirin dulu departemen mana yang perlu ngerjain ini...");
  const phases = await classifyDepartments(instruction, classifierProviders[0], new AbortController().signal);

  const deptModels = conversationRepo.getDepartmentModels(from);
  const planLines = phases.map((phase, i) => {
    const label = phase.department === "semua" ? "Satu langkah umum" : DEPARTMENT_LABELS[phase.department];
    const model =
      phase.department === "semua"
        ? (state?.preferred_provider ?? config.departmentDefaultProviders.dev ?? "default")
        : (deptModels[phase.department] ??
            state?.preferred_provider ??
            config.departmentDefaultProviders[phase.department] ??
            "default");
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
      // Awaited by every caller in loop.ts/pipeline.ts — used to be
      // fire-and-forget, which meant two progress messages raised close
      // together (e.g. a phase's "beres" notice immediately followed by the
      // next phase's "start" notice) had no guaranteed delivery order and
      // could arrive on WhatsApp reversed.
      const onProgress = async (msg: string): Promise<void> => {
        await sendWhatsApp(from, msg).catch(() => {});
      };
      const onCheckpoint = async (msg: string, department: string, offerDesignSourceChoice: boolean): Promise<void> => {
        const options = offerDesignSourceChoice
          ? DESAIN_SOURCE_CHECKPOINT_OPTIONS
          : department === "manajemen"
            ? MANAJEMEN_CHECKPOINT_OPTIONS
            : YES_NO_OPTIONS;
        await sendWhatsApp(from, msg, options).catch(() => {});
      };

      let cwd: string;
      let mode: PipelineMode;
      if (project.kind === "local") {
        cwd = await ensureLocalFolder(project);
        mode = { kind: "local", folderPath: cwd };
      } else {
        const workspace = await ensureWorkspace(project);
        cwd = workspace.dir;
        const workBranch = await createWorkBranch(cwd, taskId);
        mode = { kind: "git", defaultBranch: workspace.branch, workBranch, autoMerge: project.auto_merge };
      }

      // Incremental refresh before the pipeline runs — skips fast when the
      // default branch hasn't moved since the last index. Never blocks the
      // task: a failure just means this run works without retrieval.
      await indexProject({
        projectAlias: project.alias,
        cwd,
        mode: project.kind === "local" ? "local" : "git",
        signal: abortController.signal,
        log: (m) => auditLog.add(taskId, "note", m),
      }).catch((err) =>
        auditLog.add(taskId, "error", `Index kode gagal: ${err instanceof Error ? err.message : String(err)}`)
      );

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
          // "semua" means classification didn't split into departments, but
          // the work is still almost always coding — falls back to the dev
          // default (not a "semua"-specific one) rather than the flat
          // provider order, same reasoning the split departments already get.
          department === "semua"
            ? (state?.preferred_provider ?? config.departmentDefaultProviders.dev)
            : (conversationRepo.getDepartmentModel(from, department) ??
                state?.preferred_provider ??
                config.departmentDefaultProviders[department as DepartmentKey]),
        mode,
      });

      tasksRepo.setStatus(taskId, result.ok ? "done" : result.cancelled ? "cancelled" : "failed", result.summary);

      if (result.cancelled && mode.kind === "git") {
        // Safe to always discard: nothing gets merged/pushed into
        // defaultBranch until the pipeline's last phase, so the work branch
        // is disposable no matter how far the task got.
        try {
          await discardWorkBranch(cwd, mode.defaultBranch, mode.workBranch);
          await sendWhatsApp(from, `${result.summary} Perubahan yang sempat dibikin udah aku balikin, workspace bersih lagi.`);
        } catch (err) {
          await sendWhatsApp(
            from,
            `${result.summary} Tapi gagal balikin perubahannya: ${err instanceof Error ? err.message : String(err)}. Mungkin perlu dicek manual di workspace-nya.`
          );
        }
      } else if (result.cancelled && mode.kind === "local") {
        await sendWhatsApp(
          from,
          `${result.summary} Ini folder lokal (bukan git), jadi perubahan file yang sempat dibikin gak bisa otomatis aku balikin — cek manual ya kalau perlu.`
        );
      } else {
        await sendWhatsApp(
          from,
          result.ok ? `Udah selesai. ${result.summary}` : `Gagal nih. ${result.summary}`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tasksRepo.setStatus(taskId, "failed", message);
      await sendWhatsApp(from, `Gagal nih, ada error: ${message}`);
    }
  });
}
