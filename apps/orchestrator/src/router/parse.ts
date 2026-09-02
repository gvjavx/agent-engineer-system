// Pure command-parsing helpers, kept separate from handler.ts so they're
// testable without touching the DB, git, or network.

const ADD_PROJECT_RE = /^tambah\s+project\s+(\S+)\s+(\S+)\s*$/i;
// Path can contain spaces (Windows paths especially), so it's everything
// after the alias rather than a single \S+ token.
const ADD_FOLDER_RE = /^tambah\s+folder\s+(\S+)\s+(.+?)\s*$/i;
const DELETE_PROJECT_RE = /^(hapus|hapuskan)\s+project\s+(\S+)\s*$/i;
const USE_PROJECT_RE = /^(pakai|gunakan)\s+(\S+)\s*$/i;
const USE_MODEL_RE = /^(pakai|gunakan)\s+model\s+(\S+)\s*$/i;
const USE_DEPARTMENT_MODEL_RE = /^(pakai|gunakan)\s+model\s+(\S+)\s+(\S+)\s*$/i;
const LIST_MODELS_FOR_PROVIDER_RE = /^(daftar|list)\s+model\s+(\S+)\s+(.+?)\s*$/i;

export interface AddProjectCommand {
  alias: string;
  repoUrl: string;
}

export function parseAddProject(text: string): AddProjectCommand | undefined {
  const match = text.trim().match(ADD_PROJECT_RE);
  if (!match) return undefined;
  return { alias: match[1], repoUrl: match[2] };
}

// "tambah project" with no alias/url doesn't match ADD_PROJECT_RE at all, so
// it used to fall straight through to the task classifier — same failure
// mode as isBareDeleteProjectCommand below, just for registration instead of
// deletion. Caught here so it starts the guided wizard instead.
const BARE_ADD_PROJECT_PHRASES = new Set(["tambah project"]);

export function isBareAddProjectCommand(text: string): boolean {
  return BARE_ADD_PROJECT_PHRASES.has(text.trim().toLowerCase());
}

// Restricts repoUrl to plain https:// GitHub URLs. Two things this blocks
// that a bare "non-empty string" check wouldn't: git transport helpers like
// "ext::sh -c ..." (git runs that shell command on clone — instant RCE), and
// https:// URLs to hosts other than github.com (which would otherwise get
// offered our GitHub credential on clone/fetch, see git/repo.ts).
const ALLOWED_REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?\/?$/;

export function isAllowedRepoUrl(repoUrl: string): boolean {
  return ALLOWED_REPO_URL_RE.test(repoUrl);
}

// Finds a GitHub repo reference anywhere in free text and normalizes it to
// the canonical https://github.com/<owner>/<repo> form isAllowedRepoUrl
// expects — for the guided "tambah project" wizard, where the user pastes
// whatever their browser address bar gave them (often with a trailing
// /tree/<branch>, a query string, a ".git" suffix, or surrounding words),
// not the exact string this project's own regex-based direct command
// requires. Not anchored on purpose, so it matches regardless of protocol/
// www-prefix/surrounding text; the trailing path/query/hash is simply left
// out of the capture since "/", "?", and "#" aren't in the character class.
const GITHUB_URL_EXTRACT_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/i;

export function extractGithubRepoUrl(text: string): string | undefined {
  const match = text.match(GITHUB_URL_EXTRACT_RE);
  if (!match) return undefined;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  if (!owner || !repo) return undefined;
  return `https://github.com/${owner}/${repo}`;
}

const URL_RE = /https?:\/\//i;

// Cheap zero-AI-cost gate before spending a classification call on a message
// that didn't match any exact-phrase command (see agent/commandIntent.ts and
// agent/confirmationIntent.ts): the commands this backs and any realistic
// paraphrase of them are short; genuine coding-task instructions run longer
// and/or carry URLs (e.g. a Figma link). Messages that fail this check skip
// the classifier and fall straight to the existing behavior for their call
// site — zero added AI cost for that case.
export function isPlausibleShortCommand(text: string, maxWords: number): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || URL_RE.test(trimmed)) return false;
  return trimmed.split(/\s+/).filter(Boolean).length <= maxWords;
}

export interface AddFolderCommand {
  alias: string;
  path: string;
}

export function parseAddFolder(text: string): AddFolderCommand | undefined {
  const match = text.trim().match(ADD_FOLDER_RE);
  if (!match) return undefined;
  return { alias: match[1], path: match[2] };
}

// Same gap as isBareAddProjectCommand above, for the local-folder variant.
const BARE_ADD_FOLDER_PHRASES = new Set(["tambah folder"]);

export function isBareAddFolderCommand(text: string): boolean {
  return BARE_ADD_FOLDER_PHRASES.has(text.trim().toLowerCase());
}

export function parseDeleteProject(text: string): string | undefined {
  const match = text.trim().match(DELETE_PROJECT_RE);
  return match?.[2];
}

// "hapus project" with no alias doesn't match DELETE_PROJECT_RE at all, so it
// used to fall straight through to the task classifier — which read it as an
// instruction to build project-deletion functionality in the codebase rather
// than a command missing its argument. Caught here so it can be answered with
// a picker instead.
const BARE_DELETE_PROJECT_PHRASES = new Set(["hapus project", "hapuskan project"]);

export function isBareDeleteProjectCommand(text: string): boolean {
  return BARE_DELETE_PROJECT_PHRASES.has(text.trim().toLowerCase());
}

// Used to validate a project alias collected turn-by-turn in a guided
// WhatsApp flow (see handler.ts's guided_git_project/guided_folder pending
// states) — free-text replies are more error-prone than a single regex-
// matched token, so this rejects whitespace and path-separator characters
// that would otherwise resolve outside workspacesDir when joined into a path.
export function isValidAliasInput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return false;
  return true;
}

export function parseUseProject(text: string): string | undefined {
  const match = text.trim().match(USE_PROJECT_RE);
  return match?.[2];
}

// Checked before parseUseProject wherever both are used — "pakai model X" would
// never match USE_PROJECT_RE anyway (it requires exactly one word after
// pakai/gunakan), but keeping the model check explicit avoids relying on that.
export interface UseModelCommand {
  // Raw token as typed — "semua" for the 2-token form (no department given).
  // Caller normalizes this via normalizeDepartment().
  department: string;
  provider: string;
}

export function parseUseModel(text: string): UseModelCommand | undefined {
  const trimmed = text.trim();

  // 3-token form ("pakai model <departemen> <provider>") checked first since
  // it's strictly more specific — the 2-token regex can't match it anyway
  // (it anchors to exactly one token after "model").
  const departmentMatch = trimmed.match(USE_DEPARTMENT_MODEL_RE);
  if (departmentMatch) {
    return { department: departmentMatch[2], provider: departmentMatch[3] };
  }

  const simpleMatch = trimmed.match(USE_MODEL_RE);
  if (simpleMatch) {
    return { department: "semua", provider: simpleMatch[2] };
  }

  return undefined;
}

export interface ListModelsForProviderCommand {
  provider: string;
  query: string;
}

// "daftar model <provider> <kata kunci>" — searches that provider's live
// model catalog. Distinct from the bare "daftar model" (exact-phrase) command
// below, which just shows the providers/departments already configured.
export function parseListModelsForProvider(text: string): ListModelsForProviderCommand | undefined {
  const match = text.trim().match(LIST_MODELS_FOR_PROVIDER_RE);
  if (!match) return undefined;
  return { provider: match[2], query: match[3] };
}

// A phrase like "coba lagi" has no fixed meaning on its own — it only makes
// sense as a reply to whatever just failed. Caught deterministically so it
// never reaches the task classifier, which used to read it as a request to
// build a "retry" feature in the codebase instead of retrying the failed
// action itself (see handleRetryCommand in handler.ts).
const RETRY_PHRASES = new Set(["coba lagi", "coba lagi dong", "ulangi", "ulang", "coba ulang", "retry"]);
const LIST_PROJECTS_PHRASES = new Set(["daftar project", "list project", "projects"]);
const LIST_MODELS_PHRASES = new Set(["daftar model", "list model", "models"]);
const HELP_PHRASES = new Set(["help", "bantuan", "menu"]);
const STATUS_PHRASES = new Set(["status"]);
const STOP_PHRASES = new Set(["stop", "batalkan"]);
const CONNECT_FIGMA_PHRASES = new Set(["hubungkan figma", "sambungkan figma", "connect figma"]);
// Broader than the exact-phrase set above — catches real paraphrases like
// "fitus sambungkan figma untuk sambungin akun figma saya" or "tolong
// hubungin akun figma aku dong" that mention both a connect-ish verb and
// "figma" but aren't the exact canonical phrase. Real transcript: a message
// like this missed the exact-phrase set, fell through to the AI intent
// classifier, and got misread as a coding task ("implement Figma
// integration") instead of the existing "hubungkan figma" command — this
// catches it deterministically instead, no AI call needed or at risk of
// misfiring.
const CONNECT_FIGMA_PARAPHRASE_RE = /\b(hubung(?:kan|in)?|sambung(?:kan|in)?|connect)\b[\s\S]*\bfigma\b|\bfigma\b[\s\S]*\b(?:hubung(?:kan|in)?|sambung(?:kan|in)?|connect)\b/i;
const LIST_MEMORY_PHRASES = new Set([
  "lihat memori",
  "apa yang kamu inget",
  "apa yang kamu inget soal saya",
  "inget apa aja soal saya",
  "kamu inget apa aja soal saya",
]);
const CLEAR_MEMORY_PHRASES = new Set(["lupain semua", "hapus memori", "lupain semua soal saya"]);
const SESSION_HISTORY_PHRASES = new Set([
  "riwayat chat",
  "riwayat sesi",
  "sesi sebelumnya",
  "chat sebelumnya",
  "lihat riwayat",
]);
const INTRO_PHRASES = new Set([
  "siapa kamu",
  "siapa kamu?",
  "siapa anda",
  "siapa anda?",
  "siapa lu",
  "siapa lu?",
  "sape lu",
  "sape lu?",
  "sopo kon",
  "sopo kon?",
  "kon sopo",
  "kon sopo?",
  "kamu siapa",
  "kamu siapa?",
  "kamu ini siapa",
  "anda siapa?",
  "anda siapa",
  "elu siapa",
  "lu siapa",
  "kenalan dong",
  "kenalan yuk",
  "kenalin dong",
  "kenalin diri kamu",
  "kenalin",
  "perkenalkan diri",
  "perkenalkan dirimu",
  "perkenalkan diri kamu",
  "jelasin siapa kamu!",
  "jelasin siapa kamu",
  "jelaskan siapa anda",
  "who are you",
  "who are you?",
  "introduce yourself",
  "what are you",
]);

export function isRetryCommand(text: string): boolean {
  return RETRY_PHRASES.has(text.trim().toLowerCase());
}

export function isListProjectsCommand(text: string): boolean {
  return LIST_PROJECTS_PHRASES.has(text.trim().toLowerCase());
}

export function isListModelsCommand(text: string): boolean {
  return LIST_MODELS_PHRASES.has(text.trim().toLowerCase());
}

export function isHelpCommand(text: string): boolean {
  return HELP_PHRASES.has(text.trim().toLowerCase());
}

export function isStatusCommand(text: string): boolean {
  return STATUS_PHRASES.has(text.trim().toLowerCase());
}

export function isStopCommand(text: string): boolean {
  return STOP_PHRASES.has(text.trim().toLowerCase());
}

// "review PR #12", "tolong review pull request 12", "coba review pr 12 dong".
// Deterministic (has an argument — the number) so it never depends on the
// classifier; a plain "review kode ini" with no number falls through to the
// task pipeline like any other free-text instruction.
const REVIEW_PR_RE = /^(?:tolong\s+|coba\s+|bisa\s+|minta\s+)?review\s+(?:pull\s*request|pull|pr)\s*#?\s*(\d{1,7})\b/i;

export function parseReviewPr(text: string): number | undefined {
  const match = text.trim().match(REVIEW_PR_RE);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Short enough to plausibly be a paraphrase of the command ("sambungin akun
// figma saya dong"), too short to be a real task instruction that happens to
// mention both words far apart ("bikin halaman yang bisa hubungkan desain
// figma ke katalog produk dan sinkronin otomatis tiap ada perubahan" is
// already past this — stays a task instruction, doesn't get hijacked).
const CONNECT_FIGMA_PARAPHRASE_MAX_WORDS = 15;

export function isConnectFigmaCommand(text: string): boolean {
  const trimmed = text.trim();
  if (CONNECT_FIGMA_PHRASES.has(trimmed.toLowerCase())) return true;
  return isPlausibleShortCommand(trimmed, CONNECT_FIGMA_PARAPHRASE_MAX_WORDS) && CONNECT_FIGMA_PARAPHRASE_RE.test(trimmed);
}

export function isListMemoryCommand(text: string): boolean {
  return LIST_MEMORY_PHRASES.has(text.trim().toLowerCase());
}

export function isClearMemoryCommand(text: string): boolean {
  return CLEAR_MEMORY_PHRASES.has(text.trim().toLowerCase());
}

export function isSessionHistoryCommand(text: string): boolean {
  return SESSION_HISTORY_PHRASES.has(text.trim().toLowerCase());
}

export function isIntroCommand(text: string): boolean {
  return INTRO_PHRASES.has(text.trim().toLowerCase());
}

const CREATOR_PHRASES = new Set([
  "siapa penciptamu",
  "siapa pencipta kamu",
  "siapa pencipta mu",
  "siapa pembuatmu",
  "siapa pembuat kamu",
  "siapa pembuat mu",
  "siapa developer kamu",
  "siapa developernya",
  "siapa yang membuat kamu",
  "siapa yang membuatmu",
  "siapa yang bikin kamu",
  "siapa yang buat kamu",
  "yang bikin kamu siapa",
  "yang buat kamu siapa",
  "who made you",
  "who created you",
  "who is your creator",
  "who is your developer",
]);
// "pencipta"/"pembuat" (with any suffix — "penciptamu", "pembuatnya") are
// specific enough Indonesian words that they essentially never appear in a
// real coding task instruction, unlike common words ("halo", "kabar") that
// needed a stricter pairing rule to stay safe — see isGreetingCommand.
const CREATOR_PARAPHRASE_RE = /\b(pencipta|pembuat)/i;
const CREATOR_PARAPHRASE_MAX_WORDS = 10;

export function isCreatorCommand(text: string): boolean {
  const trimmed = text.trim();
  if (CREATOR_PHRASES.has(trimmed.toLowerCase())) return true;
  return isPlausibleShortCommand(trimmed, CREATOR_PARAPHRASE_MAX_WORDS) && CREATOR_PARAPHRASE_RE.test(trimmed);
}

const GREETING_PHRASES = new Set([
  "halo",
  "halo!",
  "hallo",
  "hai",
  "hai!",
  "hi",
  "hi!",
  "hello",
  "hello!",
  "hey",
  "hey!",
  "woy",
  "eh halo",
  "selamat pagi",
  "pagi",
  "met pagi",
  "selamat siang",
  "siang",
  "met siang",
  "selamat sore",
  "sore",
  "met sore",
  "selamat malam",
  "malam",
  "met malam",
  "apa kabar",
  "apa kabar?",
  "gimana kabarnya",
  "gimana kabarnya?",
  "kabar baik?",
  "sehat?",
]);

// Broader than the exact-phrase set above, but deliberately narrow — only
// a question word paired with "kabar" ("bagaimana kabar anda", a more formal
// phrasing than "apa kabar"/"gimana kabarnya" that missed the exact set).
// NOT a bare greeting-word match (halo/hai/hi/...): tried that first and it
// broke a real case this file already tests for — "halo, tambahin endpoint
// health check dong" is a real task that happens to open with a casual
// "halo," and must stay routed as a task, not hijacked into a greeting
// reply. "kabar" paired with a question word doesn't have that ambiguity —
// nobody opens a real task instruction with "gimana kabar kamu, tolong
// bikinin...".
const GREETING_PARAPHRASE_RE = /\b(apa|gimana|bagaimana|piye)\b[\s\S]*\bkabar/i;
const GREETING_PARAPHRASE_MAX_WORDS = 8;

export function isGreetingCommand(text: string): boolean {
  const trimmed = text.trim();
  if (GREETING_PHRASES.has(trimmed.toLowerCase())) return true;
  return isPlausibleShortCommand(trimmed, GREETING_PARAPHRASE_MAX_WORDS) && GREETING_PARAPHRASE_RE.test(trimmed);
}

const CONFIRM_YES_PHRASES = new Set(["ya", "iya", "yes", "y", "oke", "ok", "boleh", "lanjut", "setuju"]);
const CONFIRM_NO_PHRASES = new Set(["tidak", "no", "n", "batal", "jangan", "gak", "ga", "nggak"]);
// The third button at the plan-confirmation step, for opting into per-phase
// checkpoints — checked before isConfirmYes wherever both matter, since a
// plain "ya" should mean "run straight through", not "review every phase".
const CONFIRM_YES_CHECKPOINT_PHRASES = new Set([
  "ya, checkpoint",
  "ya checkpoint",
  "checkpoint",
  "review tiap fase",
  "ya, review tiap fase",
]);

export function isConfirmYes(text: string): boolean {
  return CONFIRM_YES_PHRASES.has(text.trim().toLowerCase());
}

export function isConfirmYesWithCheckpoints(text: string): boolean {
  return CONFIRM_YES_CHECKPOINT_PHRASES.has(text.trim().toLowerCase());
}

export function isConfirmNo(text: string): boolean {
  return CONFIRM_NO_PHRASES.has(text.trim().toLowerCase());
}
