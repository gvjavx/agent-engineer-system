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

// Restricts repoUrl to plain https:// GitHub URLs. Two things this blocks
// that a bare "non-empty string" check wouldn't: git transport helpers like
// "ext::sh -c ..." (git runs that shell command on clone — instant RCE), and
// https:// URLs to hosts other than github.com (which would otherwise get
// offered our GitHub credential on clone/fetch, see git/repo.ts).
const ALLOWED_REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?\/?$/;

export function isAllowedRepoUrl(repoUrl: string): boolean {
  return ALLOWED_REPO_URL_RE.test(repoUrl);
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

export function parseDeleteProject(text: string): string | undefined {
  const match = text.trim().match(DELETE_PROJECT_RE);
  return match?.[2];
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

const LIST_PROJECTS_PHRASES = new Set(["daftar project", "list project", "projects"]);
const LIST_MODELS_PHRASES = new Set(["daftar model", "list model", "models"]);
const HELP_PHRASES = new Set(["help", "bantuan", "menu"]);
const STATUS_PHRASES = new Set(["status"]);
const STOP_PHRASES = new Set(["stop", "batalkan"]);
const CONNECT_FIGMA_PHRASES = new Set(["hubungkan figma", "sambungkan figma", "connect figma"]);
const INTRO_PHRASES = new Set([
  "siapa kamu",
  "siapa kamu?",
  "kamu siapa",
  "kamu siapa?",
  "kamu ini siapa",
  "elu siapa",
  "lu siapa",
  "kenalan dong",
  "kenalan yuk",
  "kenalin dong",
  "kenalin",
  "perkenalkan diri",
  "perkenalkan dirimu",
  "perkenalkan diri kamu",
  "who are you",
  "who are you?",
  "introduce yourself",
  "what are you",
]);

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

export function isConnectFigmaCommand(text: string): boolean {
  return CONNECT_FIGMA_PHRASES.has(text.trim().toLowerCase());
}

export function isIntroCommand(text: string): boolean {
  return INTRO_PHRASES.has(text.trim().toLowerCase());
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

export function isGreetingCommand(text: string): boolean {
  return GREETING_PHRASES.has(text.trim().toLowerCase());
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
