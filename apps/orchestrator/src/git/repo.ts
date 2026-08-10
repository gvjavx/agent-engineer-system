import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { config } from "../config.js";
import type { Project } from "../db/index.js";

export function workspacePath(alias: string): string {
  return path.join(config.workspacesDir, alias);
}

// GitHub auth used to be embedded straight into the https remote URL, which
// meant the token sat in plaintext in every workspace's .git/config and
// leaked into any error message that echoed the remote (e.g. a failed clone
// forwarded verbatim to WhatsApp). A global credential helper avoids both:
// git asks it for a password on demand, it reads GITHUB_TOKEN straight from
// the process environment, and nothing token-shaped ever touches disk. Scoped
// to github.com only, so the token is never offered to some other https host.
// Set up once at process start — also covers `git push` run by the agent's
// own `bash` tool, since that inherits the same global git config.
const GITHUB_URL_SCOPE = "https://github.com";

// Lazy + once: only touches global git config the first time a workspace
// operation actually needs it, not just from importing this module (matters
// for tests, and for not failing orchestrator startup if `git` isn't on PATH
// for some unrelated reason).
let credentialHelperReady = false;
function ensureGithubCredentialHelper(): void {
  if (credentialHelperReady) return;
  const helper = `!f() { [ "$1" = get ] && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f`;
  execFileSync("git", ["config", "--global", `credential.${GITHUB_URL_SCOPE}.helper`, helper]);
  credentialHelperReady = true;
}

export async function ensureWorkspace(project: Project): Promise<string> {
  ensureGithubCredentialHelper();
  const dir = workspacePath(project.alias);

  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    await simpleGit().clone(project.repo_url, dir);
  }

  const git = simpleGit(dir);
  await git.fetch("origin");
  await git.checkout(project.default_branch);
  await git.pull("origin", project.default_branch, { "--ff-only": null });
  return dir;
}

export async function createWorkBranch(dir: string, taskId: string): Promise<string> {
  const branch = `agent/${taskId.slice(0, 8)}`;
  await simpleGit(dir).checkoutLocalBranch(branch);
  return branch;
}

// For kind='local' projects: no clone, no branch — the agent edits the folder
// in place. project.repo_url holds the absolute path in this case.
export async function ensureLocalFolder(project: Project): Promise<string> {
  const dir = path.resolve(project.repo_url);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Folder tidak ditemukan: ${dir}`);
  }
  return dir;
}
