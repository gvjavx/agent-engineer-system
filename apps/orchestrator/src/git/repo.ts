import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { config } from "../config.js";
import { projectsRepo, type Project } from "../db/index.js";

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
function unsetIfPresent(key: string): void {
  try {
    execFileSync("git", ["config", "--global", "--unset-all", key]);
  } catch {
    // exits non-zero when the key was never set — nothing to remove
  }
}
function ensureGithubCredentialHelper(): void {
  if (credentialHelperReady) return;
  const scopedKey = `credential.${GITHUB_URL_SCOPE}.helper`;
  // Git accumulates every configured credential.helper across
  // system/global/local scopes and consults all of them for a matching URL —
  // scoping ours to github.com doesn't exclude a broader system-level one
  // (e.g. Windows' Git Credential Manager, "manager"), which still gets
  // tried too. The real failure mode this caused in practice: GCM caches
  // whatever credential it's handed, so once it's cached both a human login
  // and this token-based one for github.com, it can no longer auto-pick and
  // pops an interactive account-selection GUI instead — which just hangs
  // this headless process forever. Setting credential.helper to the empty
  // string resets whatever accumulated from earlier-read (system-level)
  // config files before that point in file-read order — but git config only
  // appends a NEW key at the end of the file; an already-existing key (e.g.
  // scopedKey, set by a previous run of this same function) gets updated in
  // place at its original position instead. Left alone, that silently
  // reorders the reset to land AFTER the scoped helper and wipe it out too.
  // Removing both first guarantees a clean, correctly-ordered rewrite every
  // time regardless of what a previous run already wrote.
  unsetIfPresent("credential.helper");
  unsetIfPresent(scopedKey);
  execFileSync("git", ["config", "--global", "credential.helper", ""]);
  const helper = `!f() { [ "$1" = get ] && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f`;
  execFileSync("git", ["config", "--global", scopedKey, helper]);
  credentialHelperReady = true;
}

// A fresh clone always sets refs/remotes/origin/HEAD to whatever branch the
// remote actually treats as default — reading it back is a local, no-network
// way to find out the real branch name instead of assuming "main" (which
// throws a raw "pathspec 'main' did not match any file(s)" error, forwarded
// straight to WhatsApp, for any repo whose default is e.g. "master"). A repo
// with zero commits has no branches at all, so this returns undefined there too.
async function detectDefaultBranch(dir: string): Promise<string | undefined> {
  try {
    const ref = await simpleGit(dir).raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return ref.trim().split("/").pop() || undefined;
  } catch {
    return undefined;
  }
}

export interface Workspace {
  dir: string;
  branch: string;
}

export async function ensureWorkspace(project: Project): Promise<Workspace> {
  ensureGithubCredentialHelper();
  const dir = workspacePath(project.alias);

  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    await simpleGit().clone(project.repo_url, dir);
  }

  const git = simpleGit(dir);
  await git.fetch("origin");

  const branch = await detectDefaultBranch(dir);
  if (!branch) {
    const remoteBranches = await git.branch(["-r"]);
    if (remoteBranches.all.length === 0) {
      throw new Error("Repo-nya masih kosong, belum ada commit sama sekali — push isi minimal dulu baru aku bisa kerja di situ.");
    }
    throw new Error("Gak bisa nentuin default branch repo ini secara otomatis. Cek lagi repo-nya di GitHub ya.");
  }
  if (branch !== project.default_branch) {
    projectsRepo.setDefaultBranch(project.alias, branch);
  }

  await git.checkout(branch);
  await git.pull("origin", branch, { "--ff-only": null });
  return { dir, branch };
}

// Called on "hapus project" for kind='git' projects only — the clone is
// disposable (a re-clone from GitHub fully recovers it), unlike kind='local'
// projects where repo_url IS the user's real folder and must never be
// touched (see projectsRepo.delete's comment). Re-checks the resolved path
// stays inside workspacesDir even though the caller already validates the
// alias at registration time (isValidAliasInput) — a destructive recursive
// delete gets its own independent guard, not just a hope upstream held.
export function removeWorkspace(alias: string): void {
  const dir = path.resolve(workspacePath(alias));
  const root = path.resolve(config.workspacesDir);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(`Refusing to delete a path outside the workspaces directory: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export async function createWorkBranch(dir: string, taskId: string): Promise<string> {
  const branch = `agent/${taskId.slice(0, 8)}`;
  await simpleGit(dir).checkoutLocalBranch(branch);
  return branch;
}

// Called when a task ends cancelled (stop command or checkpoint "batal") —
// safe because nothing is ever merged/pushed into defaultBranch until the
// pipeline's last phase (see systemPrompt.ts's commitRule), so a cancelled
// task's work branch, committed or not, is by definition disposable: default
// branch was never touched, and discarding the branch reverts everything the
// task did in this workspace.
export async function discardWorkBranch(dir: string, defaultBranch: string, workBranch: string): Promise<void> {
  const git = simpleGit(dir);
  await git.checkout(defaultBranch);
  await git.raw(["branch", "-D", workBranch]);
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
