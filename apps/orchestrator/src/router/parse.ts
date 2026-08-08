// Pure command-parsing helpers, kept separate from handler.ts so they're
// testable without touching the DB, git, or network.

const ADD_PROJECT_RE = /^tambah\s+project\s+(\S+)\s+(\S+)\s*$/i;
const USE_PROJECT_RE = /^(pakai|gunakan)\s+(\S+)\s*$/i;

export interface AddProjectCommand {
  alias: string;
  repoUrl: string;
}

export function parseAddProject(text: string): AddProjectCommand | undefined {
  const match = text.trim().match(ADD_PROJECT_RE);
  if (!match) return undefined;
  return { alias: match[1], repoUrl: match[2] };
}

export function parseUseProject(text: string): string | undefined {
  const match = text.trim().match(USE_PROJECT_RE);
  return match?.[2];
}

const LIST_PROJECTS_PHRASES = new Set(["daftar project", "list project", "projects"]);
const HELP_PHRASES = new Set(["help", "bantuan", "menu"]);
const STATUS_PHRASES = new Set(["status"]);
const STOP_PHRASES = new Set(["stop", "batalkan"]);

export function isListProjectsCommand(text: string): boolean {
  return LIST_PROJECTS_PHRASES.has(text.trim().toLowerCase());
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
